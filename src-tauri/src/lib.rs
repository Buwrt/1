//! githup 桌面版 —— 原生层
//!
//! 设计原则：**Rust 只做 Web 做不到的事**（写磁盘、开外部浏览器、退出）。
//! 文件选择、读文件、上传、剪贴板、偏好存储这些一律交给前端 JS 完成，
//! 这样桌面端不需要堆一堆 Rust 依赖，构建也更快更稳。

use std::fs;
use std::path::PathBuf;
use std::process::Command;

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
            reveal_path
        ])
        .run(tauri::generate_context!())
        .expect("启动 githup 桌面版失败");
}
