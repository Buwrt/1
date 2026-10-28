//! githup 桌面版 —— 原生层
//!
//! 设计原则：**Rust 只做 Web 做不到的事**（写磁盘、开外部浏览器、退出）。
//! 文件选择、读文件、上传、剪贴板、偏好存储这些一律交给前端 JS 完成，
//! 这样桌面端不需要堆一堆 Rust 依赖，构建也更快更稳。

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;
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

/// 复用一个客户端：TLS 握手和连接池都能跨请求复用，冷启动快很多。
static HTTP: OnceLock<reqwest::Client> = OnceLock::new();

fn http_client() -> &'static reqwest::Client {
    HTTP.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(40))
            // 不跟随重定向：GitHub 的 3xx 会把 Location 带在响应里，
            // 前端自己决定要不要跟（跟安卓端保持一致）。
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
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
            http_b64
        ])
        .run(tauri::generate_context!())
        .expect("启动 githup 桌面版失败");
}
