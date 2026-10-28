//! 局域网同步（桌面端 / pc 角色）
//!
//! 协议与安卓端 `LanSync.java` 完全一致，可以互相发现、互相配对、互相同步。
//!
//! ═══ 审批规则（改之前先读这段） ═══
//!
//!   手机 → 电脑 推送    电脑端**免确认**直接收
//!   电脑 → 手机 推送    手机端弹确认（手机那边实现）
//!   手机 拉取 电脑数据  **电脑端弹确认**（就是这里）
//!   电脑 拉取 手机数据  手机端弹确认
//!
//! 归纳：除了「手机主动推给电脑」，其余方向都要对端点一次确认。
//! 规则集中在 `need_approval()`，改策略只动那一个函数。
//!
//! ═══ 为什么走裸 TCP ═══
//! 局域网里没有可信证书，自签 HTTPS 在两端都得手动信任。裸 Socket +
//! 自己加密（AES-256-GCM）反而更简单也更可控。
//!
//! 实现上刻意用 std::net + 线程，不引 tokio：同步 IO 写起来直白，
//! 也少拉一大堆异步依赖，CI 编译更快。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use hmac::{Hmac, Mac};
use pbkdf2::pbkdf2;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;
use tauri::WebviewWindow;

/* ============================ 常量 ============================ */

const DISCOVER_PORT: u16 = 45678;
const MAGIC: &str = "GHSYNC1";
const MAX_FRAME: usize = 8 * 1024 * 1024;
const APPROVE_TIMEOUT: Duration = Duration::from_secs(120);
const PAIR_WINDOW_MS: u64 = 5 * 60_000;
const PAIR_MAX_TRY: u32 = 5;
const NONCE_LEN: usize = 12;

/* ============================ 加密 ============================ */

fn b64e(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}

fn b64d(s: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .map_err(|e| format!("base64 解码失败：{}", e))
}

fn random(n: usize) -> Vec<u8> {
    let mut b = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut b);
    b
}

fn sha256(b: &[u8]) -> Vec<u8> {
    let mut h = Sha256::new();
    h.update(b);
    h.finalize().to_vec()
}

/// PBKDF2 派生。SHA-256 拿不到时退 SHA-1（桌面端其实两者都有，留着跟安卓对称）。
fn pin_key(pin: &str, salt: &str) -> Result<Vec<u8>, String> {
    let mut out = [0u8; 32];
    let s = format!("githup-lan-pair|{}", salt);
    let r = pbkdf2::<Hmac<Sha256>>(pin.as_bytes(), s.as_bytes(), 210_000, &mut out);
    let _ = r;
    if out.iter().any(|&x| x != 0) {
        return Ok(out.to_vec());
    }
    let r = pbkdf2::<Hmac<sha2::Sha1>>(pin.as_bytes(), s.as_bytes(), 310_000, &mut out);
    let _ = r;
    Ok(out.to_vec())
}

/// 输出 nonce(12) || 密文+tag，整体 base64。
fn seal(key: &[u8], plain: &[u8]) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "密钥长度不是 32 字节".to_string())?;
    let nonce_bytes = random(NONCE_LEN);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ct = cipher.encrypt(nonce, plain).map_err(|e| format!("加密失败：{}", e))?;
    let mut all = nonce_bytes;
    all.extend_from_slice(&ct);
    Ok(b64e(&all))
}

fn open(key: &[u8], packed: &str) -> Result<Vec<u8>, String> {
    let raw = b64d(packed)?;
    if raw.len() <= NONCE_LEN {
        return Err("密文太短".to_string());
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "密钥长度不是 32 字节".to_string())?;
    let nonce = Nonce::from_slice(&raw[..NONCE_LEN]);
    cipher
        .decrypt(nonce, &raw[NONCE_LEN..])
        .map_err(|_| "解密失败：配对密钥不一致或数据被篡改".to_string())
}

/// 4 字符短认证串，配对后两边显示出来让用户肉眼比对（防中间人）。
fn sas(psk: &[u8]) -> String {
    let mut v = b"githup-sas".to_vec();
    v.extend_from_slice(psk);
    let h = sha256(&v);
    format!("{:02X}{:02X}", h[0], h[1])
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/* ============================ 数据 ============================ */

#[derive(Clone, Serialize, Deserialize)]
struct Peer {
    id: String,
    name: String,
    #[serde(rename = "type")]
    kind: String,
    host: String,
    port: u16,
    psk: String, // base64
    at: u64,
}

#[derive(Clone)]
struct Found {
    id: String,
    name: String,
    kind: String,
    host: String,
    port: u16,
    seen: u64,
}

struct PairSession {
    pin: String,
    born: u64,
    tries: u32,
}

struct State {
    id: String,
    name: String,
    port: u16,
    running: bool,
    peers: HashMap<String, Peer>,
    found: HashMap<String, Found>,
    /// 等待前端回话的通道。审批回 "1"/"0"，数据采集回 JSON 字符串。
    pending: HashMap<String, Sender<String>>,
    pair: Option<PairSession>,
    store: Option<std::path::PathBuf>,
}

impl State {
    fn me(&self) -> serde_json::Value {
        serde_json::json!({
            "id": self.id, "name": self.name, "type": "pc", "port": self.port
        })
    }

    fn load_peers(&mut self) {
        let path = match &self.store {
            Some(p) => p.clone(),
            None => return,
        };
        if let Ok(txt) = std::fs::read_to_string(&path) {
            if let Ok(list) = serde_json::from_str::<Vec<Peer>>(&txt) {
                for p in list {
                    self.peers.insert(p.id.clone(), p);
                }
            }
        }
    }

    fn save_peers(&self) {
        if let Some(path) = &self.store {
            let list: Vec<&Peer> = self.peers.values().collect();
            if let Ok(txt) = serde_json::to_string(&list) {
                let _ = std::fs::write(path, txt);
            }
        }
    }
}

static ST: OnceLock<Arc<Mutex<State>>> = OnceLock::new();
static RUNNING: AtomicBool = AtomicBool::new(false);

fn st() -> &'static Arc<Mutex<State>> {
    ST.get_or_init(|| {
        let id = hex(&random(8));
        let name = hostname();
        Arc::new(Mutex::new(State {
            id,
            name,
            port: 0,
            running: false,
            peers: HashMap::new(),
            found: HashMap::new(),
            pending: HashMap::new(),
            pair: None,
            store: None,
        }))
    })
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "githup 电脑版".to_string())
}

/* ============================ 前端回调 ============================ */

fn emit(win: &WebviewWindow, js: String) {
    let w = win.clone();
    // eval 必须在主线程跑，同步任务里直接调会出问题
    let _ = w.run_on_main_thread(move || {
        let _ = w.eval(&js);
    });
}

fn jsq(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}

fn emit_devices(win: &WebviewWindow) {
    let list = {
        let g = st().lock().unwrap();
        let mut v = Vec::new();
        for f in g.found.values() {
            v.push(serde_json::json!({
                "id": f.id, "name": f.name, "type": f.kind,
                "host": f.host, "port": f.port,
                "paired": g.peers.contains_key(&f.id)
            }));
        }
        v
    };
    let json = serde_json::Value::Array(list).to_string();
    emit(win, format!("window.LanSync.onDevices({})", jsq(&json)));
}

/* ============================ 帧 ============================ */

fn read_frame(s: &mut TcpStream) -> Result<String, String> {
    let mut len = [0u8; 4];
    s.read_exact(&mut len).map_err(|e| format!("读帧长度失败：{}", e))?;
    let n = u32::from_be_bytes(len) as usize;
    if n == 0 || n > MAX_FRAME {
        return Err(format!("非法帧长度：{}", n));
    }
    let mut buf = vec![0u8; n];
    s.read_exact(&mut buf).map_err(|e| format!("读帧内容失败：{}", e))?;
    String::from_utf8(buf).map_err(|e| format!("帧不是合法 UTF-8：{}", e))
}

fn write_frame(s: &mut TcpStream, json: &str) -> Result<(), String> {
    let b = json.as_bytes();
    s.write_all(&(b.len() as u32).to_be_bytes())
        .map_err(|e| format!("写帧长度失败：{}", e))?;
    s.write_all(b).map_err(|e| format!("写帧内容失败：{}", e))?;
    s.flush().ok();
    Ok(())
}

fn ok(data: serde_json::Value) -> String {
    serde_json::json!({"ok": true, "data": data}).to_string()
}

fn err(msg: &str) -> String {
    serde_json::json!({"ok": false, "msg": msg}).to_string()
}

fn ok_msg(msg: &str) -> String {
    serde_json::json!({"ok": true, "msg": msg}).to_string()
}

fn fail(msg: &str) -> String {
    serde_json::json!({"ok": false, "msg": msg}).to_string()
}

/* ============================ 审批 ============================ */

/// 唯一的审批判定。pc 是本机，peer_kind 是对方。
fn need_approval(action: &str, peer_kind: &str) -> bool {
    match action {
        "push" => {
            // 手机推给电脑：免确认（用户在手机上主动发起本身就是授权）
            if peer_kind == "phone" {
                return false;
            }
            true
        }
        // pull：数据持有方一律确认，不能被静默搬走
        _ => true,
    }
}

fn ask_user(win: &WebviewWindow, action: &str, peer_id: &str, peer_name: &str, items: &str) -> bool {
    let (tx, rx): (Sender<String>, Receiver<String>) = channel();
    let req_id = hex(&random(8));

    {
        let mut g = st().lock().unwrap();
        g.pending.insert(req_id.clone(), tx);
    }

    let info = serde_json::json!({
        "reqId": req_id, "action": action,
        "peerId": peer_id, "peerName": peer_name, "items": items
    });
    emit(win, format!("window.LanSync.onApprove({})", jsq(&info.to_string())));

    // 超时 / 通道断开一律按「拒绝」处理，不能让对方一直挂着
    let got = rx.recv_timeout(APPROVE_TIMEOUT).unwrap_or_else(|_| "0".to_string()) == "1";
    st().lock().unwrap().pending.remove(&req_id);
    got
}

/* ============================ 数据落地 ============================ */

/// 把收到的数据交给前端（令牌 / 设置 / Star 列表都在 localStorage，
/// 桌面端原生层不另存敏感数据，所以全部转给 JS 自己写）。
fn apply_payload(win: &WebviewWindow, data: &serde_json::Value) {
    emit(win, format!("window.LanSync.onApply({})", jsq(&data.to_string())));
}

fn describe(data: &serde_json::Value) -> String {
    let mut items = Vec::new();
    if data.get("token").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false) {
        items.push("登录令牌");
    }
    if data.get("settings").is_some() {
        items.push("应用设置");
    }
    if data.get("starlists").is_some() {
        items.push("Star 列表");
    }
    if data.get("totp").and_then(|v| v.as_str()).map(|s| s.len() > 2).unwrap_or(false) {
        items.push("TOTP 密钥");
    }
    if items.is_empty() {
        "空数据".to_string()
    } else {
        items.join("、")
    }
}

/* ============================ 请求处理 ============================ */

fn dispatch(win: &WebviewWindow, req: &str, remote: &str) -> String {
    let o: serde_json::Value = match serde_json::from_str(req) {
        Ok(v) => v,
        Err(e) => return err(&format!("请求不是合法 JSON：{}", e)),
    };

    let from = o.get("from").cloned().unwrap_or(serde_json::json!({}));
    let peer_id = from.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let peer_name = from.get("name").and_then(|v| v.as_str()).unwrap_or("未知设备").to_string();
    let peer_kind = from.get("type").and_then(|v| v.as_str()).unwrap_or("pc").to_string();

    match o.get("type").and_then(|v| v.as_str()).unwrap_or("") {
        "ping" => ok(serde_json::json!({"pong": true})),
        "pair-claim" => on_pair_claim(win, &o, &peer_id, &peer_name, &peer_kind, remote),
        "push" => on_push(win, &o, &peer_id, &peer_name, &peer_kind),
        "pull" => on_pull(win, &peer_id, &peer_name, &peer_kind),
        other => err(&format!("未知请求类型：{}", other)),
    }
}

/// 配对握手（本端是「展示配对码」的一方，对方拿 PIN 来认领）。
/// salt 约定：展示方 ID 在前，认领方 ID 在后 —— 与安卓端必须一致。
fn on_pair_claim(
    win: &WebviewWindow,
    o: &serde_json::Value,
    peer_id: &str,
    peer_name: &str,
    peer_kind: &str,
    remote: &str,
) -> String {
    let mut g = st().lock().unwrap();

    let session = match &g.pair {
        Some(s) => (s.pin.clone(), s.born, s.tries),
        None => return err("当前没有正在等待的配对，请先生成配对码"),
    };
    if now_ms() - session.1 > PAIR_WINDOW_MS {
        g.pair = None;
        return err("配对码已过期，请重新生成");
    }
    if session.2 >= PAIR_MAX_TRY {
        g.pair = None;
        return err("配对码错误次数过多，已作废，请重新生成");
    }

    let ke = match pin_key(&session.0, &format!("{}|{}", g.id, peer_id)) {
        Ok(k) => k,
        Err(e) => return err(&format!("密钥派生失败：{}", e)),
    };

    let sealed = o.get("psk").and_then(|v| v.as_str()).unwrap_or("");
    let psk = match open(&ke, sealed) {
        Ok(p) if p.len() == 32 => p,
        _ => {
            if let Some(s) = g.pair.as_mut() {
                s.tries += 1;
            }
            return err("配对失败：配对码不正确");
        }
    };

    // 对方必须回一个用 PSK 签的证明，证明它真拿到了 PSK
    let proof = o.get("proof").and_then(|v| v.as_str()).unwrap_or("");
    match open(&psk, proof) {
        Ok(v) if v == b"githup-pair-ok".to_vec() => {}
        _ => {
            if let Some(s) = g.pair.as_mut() {
                s.tries += 1;
            }
            return err("配对校验未通过");
        }
    }

    let p = Peer {
        id: peer_id.to_string(),
        name: peer_name.to_string(),
        kind: peer_kind.to_string(),
        host: remote.to_string(),
        port: o.get("port").and_then(|v| v.as_u64()).unwrap_or(0) as u16,
        psk: b64e(&psk),
        at: now_ms(),
    };
    g.peers.insert(peer_id.to_string(), p);
    g.pair = None;
    g.save_peers();
    let s = sas(&psk);
    let my_name = g.name.clone();
    drop(g);

    emit(
        win,
        format!(
            "window.LanSync.onPaired({},{},{})",
            jsq(peer_id),
            jsq(peer_name),
            jsq(&s)
        ),
    );
    ok(serde_json::json!({"paired": true, "sas": s, "myName": my_name}))
}

fn on_push(
    win: &WebviewWindow,
    o: &serde_json::Value,
    peer_id: &str,
    peer_name: &str,
    peer_kind: &str,
) -> String {
    let psk = {
        let g = st().lock().unwrap();
        match g.peers.get(peer_id) {
            Some(p) => match b64d(&p.psk) {
                Ok(k) => k,
                Err(_) => return err("本机保存的配对密钥损坏，请重新配对"),
            },
            None => return err("未配对的设备，请先配对"),
        }
    };

    let body = o.get("body").and_then(|v| v.as_str()).unwrap_or("");
    let data: serde_json::Value = match open(&psk, body) {
        Ok(b) => match serde_json::from_slice(&b) {
            Ok(v) => v,
            Err(e) => return err(&format!("数据不是合法 JSON：{}", e)),
        },
        Err(e) => return err(&format!("数据解密失败：{}", e)),
    };

    // ★ 规则：手机推给电脑免确认；其余（比如电脑推电脑）要本机确认
    if need_approval("push", peer_kind) {
        let items = describe(&data);
        if !ask_user(win, "push", peer_id, peer_name, &items) {
            return err("用户拒绝了这次同步");
        }
    }

    let items = describe(&data);
    apply_payload(win, &data);
    emit(
        win,
        format!("window.LanSync.onSyncDone({},{},{})", jsq("in"), jsq(peer_name), jsq(&items)),
    );
    ok(serde_json::json!({"applied": true}))
}

fn on_pull(win: &WebviewWindow, peer_id: &str, peer_name: &str, peer_kind: &str) -> String {
    let psk = {
        let g = st().lock().unwrap();
        match g.peers.get(peer_id) {
            Some(p) => match b64d(&p.psk) {
                Ok(k) => k,
                Err(_) => return err("本机保存的配对密钥损坏，请重新配对"),
            },
            None => return err("未配对的设备，请先配对"),
        }
    };

    // ★ 规则：别人来拉本机数据，一律先问本机用户
    if need_approval("pull", peer_kind) {
        if !ask_user(win, "pull", peer_id, peer_name, "本机全部可同步数据") {
            return err("用户拒绝了这次同步");
        }
    }

    // 桌面端的设置与令牌都在 localStorage，原生层拿不到 ——
    // 这里向前端要一份，拿到后再封包回给对方。
    let json = collect_from_frontend(win);
    match seal(&psk, json.as_bytes()) {
        Ok(body) => {
            emit(
                win,
                format!(
                    "window.LanSync.onSyncDone({},{},{})",
                    jsq("out"),
                    jsq(peer_name),
                    jsq("本机数据")
                ),
            );
            ok(serde_json::json!({"body": body}))
        }
        Err(e) => err(&format!("加密失败：{}", e)),
    }
}

/// 同步取值：用 eval 拿不到返回值，所以走一条阻塞通道 ——
/// 前端收到 onCollect 后调 lan_submit_collect 把数据送回来。
fn collect_from_frontend(win: &WebviewWindow) -> String {
    let (tx, rx) = channel();
    let token = hex(&random(8));
    {
        let mut g = st().lock().unwrap();
        g.pending.insert(format!("collect:{}", token), tx);
    }
    emit(win, format!("window.LanSync.onCollect({})", jsq(&token)));
    let got = rx
        .recv_timeout(Duration::from_secs(20))
        .unwrap_or_else(|_| "{}".to_string());
    st().lock().unwrap().pending.remove(&format!("collect:{}", token));
    got
}

/* ============================ 服务端 ============================ */

fn serve(win: WebviewWindow, listener: TcpListener) {
    // 非阻塞 + 轮询：std 的 accept 没法被优雅打断，靠标志位退出
    let _ = listener.set_nonblocking(true);
    while RUNNING.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((mut sock, addr)) => {
                let w = win.clone();
                thread::spawn(move || {
                    let _ = sock.set_read_timeout(Some(Duration::from_secs(30)));
                    let resp = match read_frame(&mut sock) {
                        Ok(req) => dispatch(&w, &req, &addr.ip().to_string()),
                        Err(e) => err(&format!("读请求失败：{}", e)),
                    };
                    let _ = write_frame(&mut sock, &resp);
                });
            }
            Err(_) => thread::sleep(Duration::from_millis(120)),
        }
    }
}

fn announce(port: u16) {
    let g = st().lock().unwrap();
    let payload = serde_json::json!({
        "id": g.id, "name": g.name, "type": "pc", "port": port
    });
    let msg = format!("{}|{}", MAGIC, payload);
    drop(g);

    if let Ok(s) = UdpSocket::bind("0.0.0.0:0") {
        let _ = s.set_broadcast(true);
        let _ = s.send_to(msg.as_bytes(), ("255.255.255.255", DISCOVER_PORT));
    }
}

fn discover_loop(win: WebviewWindow) {
    let sock = match UdpSocket::bind(("0.0.0.0", DISCOVER_PORT)) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("局域网同步：广播端口 {} 绑定失败（{}），发现功能不可用", DISCOVER_PORT, e);
            return;
        }
    };
    let _ = sock.set_read_timeout(Some(Duration::from_millis(500)));

    let mut buf = vec![0u8; 4096];
    while RUNNING.load(Ordering::SeqCst) {
        match sock.recv_from(&mut buf) {
            Ok((n, addr)) => {
                let s = String::from_utf8_lossy(&buf[..n]).to_string();
                handle_beacon(&win, &s, &addr.ip().to_string());
            }
            Err(_) => {}
        }
    }
}

fn handle_beacon(win: &WebviewWindow, s: &str, host: &str) {
    let body = match s.strip_prefix(&format!("{}|", MAGIC)) {
        Some(b) => b,
        None => return,
    };
    let o: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return,
    };
    let id = match o.get("id").and_then(|v| v.as_str()) {
        Some(v) if !v.is_empty() => v.to_string(),
        _ => return,
    };

    let mut changed = false;
    {
        let mut g = st().lock().unwrap();
        if id == g.id {
            return; // 忽略自己
        }
        let name = o.get("name").and_then(|v| v.as_str()).unwrap_or("未知设备").to_string();
        let kind = o.get("type").and_then(|v| v.as_str()).unwrap_or("pc").to_string();
        let port = o.get("port").and_then(|v| v.as_u64()).unwrap_or(0) as u16;

        let seen_before = g.found.contains_key(&id);
        g.found.insert(
            id.clone(),
            Found { id: id.clone(), name: name.clone(), kind: kind.clone(), host: host.to_string(), port, seen: now_ms() },
        );
        // 已配对设备换 IP 了（路由器重新分配），顺手更新
        if let Some(p) = g.peers.get_mut(&id) {
            if p.host != host || p.port != port {
                p.host = host.to_string();
                p.port = port;
                g.save_peers();
            }
        }
        changed = !seen_before;
    }
    if changed {
        emit_devices(win);
    }
}

fn sweep_loop(win: WebviewWindow) {
    while RUNNING.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_secs(3));
        let mut changed = false;
        {
            let mut g = st().lock().unwrap();
            let now = now_ms();
            let dead: Vec<String> = g
                .found
                .values()
                .filter(|f| now - f.seen > 45_000)
                .map(|f| f.id.clone())
                .collect();
            for id in dead {
                g.found.remove(&id);
                changed = true;
            }
        }
        if changed {
            emit_devices(&win);
        }
        announce(st().lock().unwrap().port);
    }
}

/* ============================ 客户端 ============================ */

fn send_to(peer: &Peer, msg: &str) -> Option<serde_json::Value> {
    let addr = format!("{}:{}", peer.host, peer.port);
    let mut sock = TcpStream::connect_timeout(
        &addr.parse().ok()?,
        Duration::from_secs(8),
    )
    .ok()?;
    let _ = sock.set_read_timeout(Some(Duration::from_secs(60)));
    write_frame(&mut sock, msg).ok()?;
    let resp = read_frame(&mut sock).ok()?;
    serde_json::from_str(&resp).ok()
}

/* ============================ 命令 ============================ */

#[tauri::command]
pub fn lan_start(app: tauri::AppHandle, window: WebviewWindow) -> Result<bool, String> {
    if RUNNING.load(Ordering::SeqCst) {
        return Ok(true);
    }

    let listener = TcpListener::bind("0.0.0.0:0").map_err(|e| format!("监听失败：{}", e))?;
    let port = listener.local_addr().map_err(|e| format!("取端口失败：{}", e))?.port();

    // 配对记录存到应用数据目录，重装/重启后还在
    let store = app
        .path()
        .app_data_dir()
        .ok()
        .map(|d| {
            let _ = std::fs::create_dir_all(&d);
            d.join("lansync-peers.json")
        });

    {
        let mut g = st().lock().unwrap();
        g.port = port;
        g.store = store;
        g.load_peers();
    }

    RUNNING.store(true, Ordering::SeqCst);

    let w1 = window.clone();
    thread::spawn(move || serve(w1, listener));
    let w2 = window.clone();
    thread::spawn(move || discover_loop(w2));
    let w3 = window.clone();
    thread::spawn(move || sweep_loop(w3));

    announce(port);
    Ok(true)
}

#[tauri::command]
pub fn lan_stop() -> Result<(), String> {
    RUNNING.store(false, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn lan_status() -> bool {
    RUNNING.load(Ordering::SeqCst)
}

#[tauri::command]
pub fn lan_discover() {
    announce(st().lock().unwrap().port);
}

#[tauri::command]
pub fn lan_peers() -> String {
    let g = st().lock().unwrap();
    let mut v = Vec::new();
    for p in g.peers.values() {
        v.push(serde_json::json!({
            "id": p.id, "name": p.name, "type": p.kind,
            "host": p.host, "port": p.port, "at": p.at
        }));
    }
    serde_json::Value::Array(v).to_string()
}

#[tauri::command]
pub fn lan_found() -> String {
    let g = st().lock().unwrap();
    let mut v = Vec::new();
    for f in g.found.values() {
        v.push(serde_json::json!({
            "id": f.id, "name": f.name, "type": f.kind,
            "host": f.host, "port": f.port,
            "paired": g.peers.contains_key(&f.id)
        }));
    }
    serde_json::Value::Array(v).to_string()
}

/// 生成 6 位配对码（电脑展示、手机输入时用）。
#[tauri::command]
pub fn lan_new_pair_code() -> String {
    let pin = format!("{:06}", rand::thread_rng().next_u32() % 1_000_000);
    st().lock().unwrap().pair = Some(PairSession {
        pin: pin.clone(),
        born: now_ms(),
        tries: 0,
    });
    pin
}

#[tauri::command]
pub fn lan_pair_envelope() -> String {
    let g = st().lock().unwrap();
    let pin = g.pair.as_ref().map(|s| s.pin.clone()).unwrap_or_default();
    serde_json::json!({
        "id": g.id, "name": g.name, "type": "pc", "pin": pin, "port": g.port
    })
    .to_string()
}

/// 用对方显示的配对码去认领配对（电脑输入手机上那 6 位码的常规路径）。
#[tauri::command]
pub fn lan_pair(window: WebviewWindow, peer_id: String, pin: String) -> String {
    let pin = pin.trim().to_string();
    if pin.len() != 6 || !pin.chars().all(|c| c.is_ascii_digit()) {
        return fail("配对码是 6 位数字");
    }

    // 已配对过的能直接拿地址；没配对过的地址在「已发现」列表里
    let peer = {
        let g = st().lock().unwrap();
        if let Some(p) = g.peers.get(&peer_id) {
            p.clone()
        } else if let Some(f) = g.found.get(&peer_id) {
            Peer {
                id: f.id.clone(),
                name: f.name.clone(),
                kind: f.kind.clone(),
                host: f.host.clone(),
                port: f.port,
                psk: String::new(),
                at: 0,
            }
        } else {
            return fail("没找到这台设备，请先刷新列表");
        }
    };

    let my_id = st().lock().unwrap().id.clone();
    // salt：展示方（对方）在前，认领方（本机）在后 —— 与安卓端互为镜像
    let ke = match pin_key(&pin, &format!("{}|{}", peer.id, my_id)) {
        Ok(k) => k,
        Err(e) => return fail(&format!("密钥派生失败：{}", e)),
    };
    let psk = random(32);
    let sealed = match seal(&ke, &psk) {
        Ok(s) => s,
        Err(e) => return fail(&format!("加密失败：{}", e)),
    };
    let proof = match seal(&psk, b"githup-pair-ok") {
        Ok(s) => s,
        Err(e) => return fail(&format!("签名失败：{}", e)),
    };

    // 先把值取出来：在同一个 json! 里调两次 lock() 会同时持有两把 Guard，
    // std 的 Mutex 不可重入，第二次直接死锁。
    let (me, port) = {
        let g = st().lock().unwrap();
        (g.me(), g.port)
    };
    let msg = serde_json::json!({
        "type": "pair-claim",
        "from": me,
        "port": port,
        "psk": sealed,
        "proof": proof
    })
    .to_string();

    match send_to(&peer, &msg) {
        Some(r) if r.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) => {
            let mut p = peer;
            p.psk = b64e(&psk);
            p.at = now_ms();
            let s = sas(&psk);
            {
                let mut g = st().lock().unwrap();
                g.peers.insert(p.id.clone(), p.clone());
                g.save_peers();
            }
            emit(
                &window,
                format!("window.LanSync.onPaired({},{},{})", jsq(&p.id), jsq(&p.name), jsq(&s)),
            );
            ok_msg(&format!("配对成功，短认证串 {}（请与对方核对）", s))
        }
        Some(r) => fail(r.get("msg").and_then(|v| v.as_str()).unwrap_or("配对失败")),
        None => fail("连不上对方，请确认两端在同一网络且都已开启同步"),
    }
}

#[tauri::command]
pub fn lan_remove_peer(peer_id: String) {
    let mut g = st().lock().unwrap();
    g.peers.remove(&peer_id);
    g.save_peers();
}

/// 向已配对设备推送。payload 由前端组装（设置 / Star 列表 / 令牌）。
#[tauri::command]
pub fn lan_push(window: WebviewWindow, peer_id: String, payload: String) -> String {
    let peer = {
        let g = st().lock().unwrap();
        match g.peers.get(&peer_id) {
            Some(p) => p.clone(),
            None => return fail("未配对的设备，请先配对"),
        }
    };
    let psk = match b64d(&peer.psk) {
        Ok(k) => k,
        Err(_) => return fail("配对密钥损坏，请重新配对"),
    };

    let body = match seal(&psk, payload.as_bytes()) {
        Ok(b) => b,
        Err(e) => return fail(&format!("加密失败：{}", e)),
    };
    let msg = serde_json::json!({
        "type": "push",
        "from": st().lock().unwrap().me(),
        "body": body
    })
    .to_string();

    match send_to(&peer, &msg) {
        Some(r) if r.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) => {
            emit(
                &window,
                format!(
                    "window.LanSync.onSyncDone({},{},{})",
                    jsq("out"),
                    jsq(&peer.name),
                    jsq("已推送")
                ),
            );
            ok_msg(&format!("已推送到 {}", peer.name))
        }
        Some(r) => fail(r.get("msg").and_then(|v| v.as_str()).unwrap_or("对方拒绝")),
        None => fail("连不上对方，请确认两端在同一网络且都已开启同步"),
    }
}

/// 从已配对设备拉取。对方（比如手机）会先弹确认。
#[tauri::command]
pub fn lan_pull(window: WebviewWindow, peer_id: String) -> String {
    let peer = {
        let g = st().lock().unwrap();
        match g.peers.get(&peer_id) {
            Some(p) => p.clone(),
            None => return fail("未配对的设备，请先配对"),
        }
    };
    let psk = match b64d(&peer.psk) {
        Ok(k) => k,
        Err(_) => return fail("配对密钥损坏，请重新配对"),
    };

    let msg = serde_json::json!({
        "type": "pull",
        "from": st().lock().unwrap().me()
    })
    .to_string();

    match send_to(&peer, &msg) {
        Some(r) if r.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) => {
            let body = r
                .get("data")
                .and_then(|d| d.get("body"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            match open(&psk, body) {
                Ok(bytes) => match serde_json::from_slice::<serde_json::Value>(&bytes) {
                    Ok(data) => {
                        let items = describe(&data);
                        apply_payload(&window, &data);
                        emit(
                            &window,
                            format!(
                                "window.LanSync.onSyncDone({},{},{})",
                                jsq("in"),
                                jsq(&peer.name),
                                jsq(&items)
                            ),
                        );
                        ok_msg(&format!("已从 {} 同步：{}", peer.name, items))
                    }
                    Err(e) => fail(&format!("数据解析失败：{}", e)),
                },
                Err(e) => fail(e),
            }
        }
        Some(r) => fail(r.get("msg").and_then(|v| v.as_str()).unwrap_or("对方拒绝")),
        None => fail("连不上对方，请确认两端在同一网络且都已开启同步"),
    }
}

/// 前端对审批请求的答复（同意 / 拒绝）。
#[tauri::command]
pub fn lan_approve(req_id: String, granted: bool) -> bool {
    let mut g = st().lock().unwrap();
    match g.pending.remove(&req_id) {
        Some(tx) => tx.send(if granted { "1".to_string() } else { "0".to_string() }).is_ok(),
        None => false,
    }
}

/// 前端把本机数据交给原生层（回应 onCollect）。
#[tauri::command]
pub fn lan_submit_collect(token: String, payload: String) -> bool {
    let key = format!("collect:{}", token);
    let mut g = st().lock().unwrap();
    match g.pending.remove(&key) {
        Some(tx) => tx.send(payload).is_ok(),
        None => false,
    }
}

#[tauri::command]
pub fn lan_device_name() -> String {
    st().lock().unwrap().name.clone()
}
