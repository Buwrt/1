//! githup 桌面版 —— 原生层
//!
//! 设计原则：**Rust 只做 Web 做不到的事**（写磁盘、开外部浏览器、退出）。
//! 文件选择、读文件、上传、剪贴板、偏好存储这些一律交给前端 JS 完成，
//! 这样桌面端不需要堆一堆 Rust 依赖，构建也更快更稳。

mod lansync;

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/* ============================ 命令 ============================ */

/// 应用版本号，与 Cargo.toml / tauri.conf.json 保持一致。
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// 退出应用。
#[tauri::command]
fn app_exit(app: tauri::AppHandle) {
    app.exit(0);
}

/// 用系统默认浏览器打开链接。
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let u = url.trim().to_string();
    if u.is_empty() {
        return Err("空的链接".to_string());
    }
    // 只允许 http/https，避免把任意字符串交给系统去执行
    if !(u.starts_with("http://") || u.starts_with("https://")) {
        return Err("只支持 http/https 链接".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .arg("/c")
            .arg("start")
            .arg("")
            .arg(&u)
            .spawn()
            .map_err(|e| format!("打开浏览器失败：{}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&u)
            .spawn()
            .map_err(|e| format!("打开浏览器失败：{}", e))?;
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(&u)
            .spawn()
            .map_err(|e| format!("打开浏览器失败：{}", e))?;
    }
    Ok(())
}

/// 把文件写到「下载」目录下的 githup 子目录，返回完整路径。
///
/// 内容以 Base64 传入（IPC 走 JSON，二进制不好带）。
#[tauri::command]
fn save_file(name: String, b64: String) -> Result<String, String> {
    let bytes = b64_decode(&b64)?;
    if bytes.is_empty() {
        return Err("内容为空".to_string());
    }

    let dir = downloads_dir().ok_or_else(|| "取不到下载目录".to_string())?.join("githup");
    fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败：{}", e))?;

    let safe = sanitize(&name);
    let mut target = dir.join(&safe);
    if target.exists() {
        // 重名就加序号，别直接覆盖用户上一份
        let stem = PathBuf::from(&safe);
        let ext = stem
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        let base = stem
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| safe.clone());
        let mut i = 1;
        loop {
            let candidate = dir.join(format!("{}({}){}", base, i, ext));
            if !candidate.exists() {
                target = candidate;
                break;
            }
            i += 1;
            if i > 999 {
                return Err("同名文件太多".to_string());
            }
        }
    }

    fs::write(&target, &bytes).map_err(|e| format!("写入失败：{}", e))?;
    Ok(target.to_string_lossy().to_string())
}

/// 在文件管理器里高亮某个已保存的文件（前端「下载」页可调用）。
#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg("/select,")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("打开文件管理器失败：{}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("打开文件管理器失败：{}", e))?;
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let dir = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or(path.clone());
        Command::new("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("打开文件管理器失败：{}", e))?;
    }
    Ok(())
}

/* ============================ 网络通道 ============================
 *
 * 与安卓端 JsBridge.http 同一套契约：前端调 http(id, method, url, body,
 * headersJson)，这里发完请求后用 eval 回调 window.Native._cb(id, status,
 * body, headersJson)。
 *
 * 为什么不让前端直接 fetch：WebView2 里页面 origin 是 http://tauri.localhost，
 * 往外打要过 CSP 和 CORS，还受系统代理影响 —— 登录时那句
 * "Failed to fetch" 就是这么来的。交给 Rust 发请求，这些限制一个都不存在，
 * 行为也和安卓端完全一致。
 */

/* ---------------- 代理 ----------------
 *
 * 为什么必须自己处理：reqwest 只认环境变量里的代理，而 Windows 用户
 * 多半是在「系统设置 → 代理」里配的（走注册表），reqwest 根本不看。
 * 于是电脑上明明开着代理、浏览器能上 GitHub，客户端却报
 * "error sending request for url" —— 请求根本没走到代理。
 *
 * 所以按这个顺序找：
 *   1. 用户在设置里手动填的（最优先，能override一切）
 *   2. 环境变量 HTTPS_PROXY / ALL_PROXY / HTTP_PROXY
 *   3. Windows 注册表里的系统代理
 */

struct NetState {
    proxy: Option<String>,
    client: reqwest::Client,
}

static NET: OnceLock<Mutex<NetState>> = OnceLock::new();

fn build_client(spec: &Option<String>) -> reqwest::Client {
    let mut b = reqwest::Client::builder()
        .timeout(Duration::from_secs(40))
        // 不跟随重定向：Location 由前端自己决定要不要跟（与安卓端一致）
        .redirect(reqwest::redirect::Policy::none());

    let chosen = match spec {
        Some(v) => {
            let v = v.trim().to_string();
            if v.is_empty() { detect_system_proxy() } else { Some(v) }
        }
        None => detect_system_proxy(),
    };
    if let Some(p) = &chosen {
        match reqwest::Proxy::all(p) {
            Ok(px) => { b = b.proxy(px); }
            Err(e) => eprintln!("代理地址无效（{}）：{}", p, e),
        }
    }
    b.build().unwrap_or_else(|_| reqwest::Client::new())
}

fn net() -> &'static Mutex<NetState> {
    NET.get_or_init(|| Mutex::new(NetState { proxy: None, client: build_client(&None) }))
}

fn http_client() -> reqwest::Client {
    net().lock().map(|g| g.client.clone()).unwrap_or_else(|_| build_client(&None))
}

/// 当前实际生效的代理（手动优先，否则自动探测出来的）。
fn active_proxy() -> Option<String> {
    let g = net().lock().ok()?;
    match &g.proxy {
        Some(v) if !v.trim().is_empty() => Some(v.clone()),
        _ => detect_system_proxy(),
    }
}

fn env_proxy() -> Option<String> {
    for k in ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy"] {
        if let Ok(v) = std::env::var(k) {
            let v = v.trim().to_string();
            if !v.is_empty() { return Some(v); }
        }
    }
    None
}

/// Windows 系统代理：读 HKCU\...\Internet Settings 的 ProxyEnable / ProxyServer。
/// 用 reg.exe 查，不为这点事引一个注册表 crate。
#[cfg(target_os = "windows")]
fn registry_proxy() -> Option<String> {
    let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";

    let en = Command::new("reg").args(["query", key, "/v", "ProxyEnable"]).output().ok()?;
    if !String::from_utf8_lossy(&en.stdout).contains("0x1") {
        return None;   // 系统代理没开
    }

    let sv = Command::new("reg").args(["query", key, "/v", "ProxyServer"]).output().ok()?;
    let txt = String::from_utf8_lossy(&sv.stdout).to_string();
    // 输出形如：    ProxyServer    REG_SZ    http=127.0.0.1:7890;https=127.0.0.1:7890
    let val = txt.lines()
        .rev()
        .find(|l| l.contains("REG_SZ"))?
        .split("REG_SZ").nth(1)?
        .trim().to_string();
    if val.is_empty() { return None; }

    // 可能是 "http=...;https=..." 的分段形式，优先取 https
    let pick = val.split(';')
        .find_map(|p| p.trim().strip_prefix("https=").or_else(|| p.trim().strip_prefix("http=")))
        .map(|s| s.to_string())
        .unwrap_or_else(|| val.split(';').next().unwrap_or("").trim().to_string());
    if pick.is_empty() { return None; }
    if pick.contains("://") { Some(pick) } else { Some(format!("http://{}", pick)) }
}

#[cfg(not(target_os = "windows"))]
fn registry_proxy() -> Option<String> { None }

fn detect_system_proxy() -> Option<String> {
    env_proxy().or_else(registry_proxy)
}

/// 设置手动代理。传空字符串表示「清空，回到自动探测」。
#[tauri::command]
fn net_set_proxy(spec: String) -> String {
    let spec = if spec.trim().is_empty() { None } else { Some(spec.trim().to_string()) };
    let client = build_client(&spec);
    let shown = match &spec {
        Some(v) => v.clone(),
        None => detect_system_proxy().unwrap_or_else(|| "".to_string()),
    };
    if let Ok(mut g) = net().lock() {
        g.proxy = spec;
        g.client = client;
    }
    shown
}

/// 查询当前生效的代理（供设置面板显示）。
#[tauri::command]
fn net_get_proxy() -> String {
    active_proxy().unwrap_or_else(|| "".to_string())
}

/// 网络诊断：分别试几个地址，把耗时和错误原样返回，方便判断是哪一层断了。
#[tauri::command]
async fn net_diagnose() -> String {
    let targets = [
        ("GitHub API", "https://api.github.com/zen"),
        ("GitHub 主页", "https://github.com"),
        ("百度（对照）", "https://www.baidu.com"),
    ];
    let p = active_proxy();
    let mut out = serde_json::Map::new();
    out.insert(
        "proxy".to_string(),
        serde_json::Value::String(p.clone().unwrap_or_else(|| "（未检测到）".to_string())),
    );

    let client = http_client();
    let mut items = Vec::new();
    for (name, url) in targets {
        let t0 = std::time::Instant::now();
        let r = client.get(url).send().await;
        let ms = t0.elapsed().as_millis();
        let item = match r {
            Ok(resp) => serde_json::json!({
                "name": name, "ok": true,
                "status": resp.status().as_u16(), "ms": ms
            }),
            Err(e) => serde_json::json!({
                "name": name, "ok": false,
                "error": format!("{}", e), "ms": ms
            }),
        };
        items.push(item);
    }
    out.insert("items".to_string(), serde_json::Value::Array(items));
    serde_json::Value::Object(out).to_string()
}

/// 转成合法的 JS 字符串字面量（JSON 字符串语法是 JS 的子集，够用且安全）。
fn js_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}

/// 把结果送回前端。eval 失败只记日志，不能让它把命令本身搞挂。
fn emit_cb(window: &tauri::WebviewWindow, id: &str, status: u16, body: &str, headers: &str) {
    let js = format!(
        "window.Native._cb({},{},{},{})",
        js_str(id),
        status,
        js_str(body),
        js_str(headers)
    );
    if let Err(e) = window.eval(&js) {
        eprintln!("回调前端失败：{}", e);
    }
}

/// 收集响应头。Link（翻页）和 X-RateLimit-Remaining（限流提示）前端都要读。
fn headers_to_json(resp: &reqwest::Response) -> String {
    let mut m = serde_json::Map::new();
    for (k, v) in resp.headers().iter() {
        if let Ok(s) = v.to_str() {
            m.insert(k.as_str().to_lowercase(), serde_json::Value::String(s.to_string()));
        }
    }
    serde_json::Value::Object(m).to_string()
}

/// 解析前端传来的请求头 JSON，解析不出来就当空处理。
fn parse_headers(raw: &str) -> HashMap<String, String> {
    serde_json::from_str::<HashMap<String, String>>(raw).unwrap_or_default()
}

#[tauri::command]
async fn http_request(
    id: String,
    method: String,
    url: String,
    body: Option<String>,
    headers: String,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    let m = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| format!("不支持的请求方法：{}", method))?;

    let mut rb = http_client().request(m, &url);
    for (k, v) in parse_headers(&headers) {
        // 这两个由 reqwest 自己算，手动塞进去会导致请求体长度对不上而卡住
        if k.eq_ignore_ascii_case("content-length") || k.eq_ignore_ascii_case("host") {
            continue;
        }
        rb = rb.header(k, v);
    }
    if let Some(b) = body {
        if !b.is_empty() {
            rb = rb.body(b);
        }
    }

    match rb.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let hdrs = headers_to_json(&resp);
            match resp.text().await {
                Ok(text) => emit_cb(&window, &id, status, &text, &hdrs),
                Err(e) => emit_cb(&window, &id, 502, &format!("读取响应失败：{}", e), "{}"),
            }
        }
        Err(e) => {
            // 网络层失败：给一个带 message 的假响应，前端会把它显示成
            // "网络请求失败：…"，比空 body 的"响应内容读取失败"清楚得多
            let msg = format!("网络请求失败：{}", e);
            let body = serde_json::json!({ "message": msg }).to_string();
            emit_cb(&window, &id, 502, &body, "{}");
        }
    }
    Ok(())
}

/// 二进制资源（README 图片等）走这条路，返回 Base64 文本。
#[tauri::command]
async fn http_b64(
    id: String,
    url: String,
    headers: String,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    let mut rb = http_client().get(&url);
    for (k, v) in parse_headers(&headers) {
        if k.eq_ignore_ascii_case("content-length") || k.eq_ignore_ascii_case("host") {
            continue;
        }
        rb = rb.header(k, v);
    }

    match rb.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let hdrs = headers_to_json(&resp);
            match resp.bytes().await {
                Ok(b) => emit_cb(&window, &id, status, &b64_encode(&b), &hdrs),
                Err(e) => emit_cb(&window, &id, 502, &format!("读取响应失败：{}", e), "{}"),
            }
        }
        Err(e) => {
            let msg = format!("网络请求失败：{}", e);
            let body = serde_json::json!({ "message": msg }).to_string();
            emit_cb(&window, &id, 502, &body, "{}");
        }
    }
    Ok(())
}

/* ============================ 工具 ============================ */

fn downloads_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("USERPROFILE").map(|p| PathBuf::from(p).join("Downloads"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var_os("HOME").map(|p| PathBuf::from(p).join("Downloads"))
    }
}

/// 去掉文件名里的路径分隔符和 Windows 保留字符，防止写到目录外面去。
fn sanitize(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => '_',
            _ => c,
        })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').to_string();
    if cleaned.is_empty() {
        "download".to_string()
    } else {
        cleaned
    }
}

/// 标准 Base64 编码。不引外部 crate，二十来行的事。
fn b64_encode(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len() / 3 * 4 + 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | (b[2] as u32);
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    let mut out: Vec<u8> = Vec::with_capacity(s.len() / 4 * 3 + 3);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for c in s.chars() {
        if c == '\n' || c == '\r' || c == ' ' || c == '\t' {
            continue;
        }
        if c == '=' {
            break;
        }
        let v: u8 = match c {
            'A'..='Z' => (c as u8) - b'A',
            'a'..='z' => (c as u8) - b'a' + 26,
            '0'..='9' => (c as u8) - b'0' + 52,
            '+' => 62,
            '/' => 63,
            _ => return Err(format!("非法的 Base64 字符：{}", c)),
        };
        acc = (acc << 6) | (v as u32);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff) as u8);
        }
    }
    Ok(out)
}

/* ============================ 入口 ============================ */

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            app_version,
            app_exit,
            open_url,
            save_file,
            reveal_path,
            http_request,
            http_b64,
            net_set_proxy,
            net_get_proxy,
            net_diagnose,
            lansync::lan_start,
            lansync::lan_stop,
            lansync::lan_status,
            lansync::lan_discover,
            lansync::lan_peers,
            lansync::lan_found,
            lansync::lan_new_pair_code,
            lansync::lan_pair_envelope,
            lansync::lan_pair,
            lansync::lan_remove_peer,
            lansync::lan_push,
            lansync::lan_pull,
            lansync::lan_approve,
            lansync::lan_submit_collect,
            lansync::lan_device_name
        ])
        .run(tauri::generate_context!())
        .expect("启动 githup 桌面版失败");
}
