// 让 Windows 下用 `cargo build` 直接跑时不会弹出控制台黑窗
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    githup_lib::run()
}
