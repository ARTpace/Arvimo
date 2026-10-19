#![windows_subsystem = "windows"]

use std::{fs, path::{Path, PathBuf}, process::Command, os::windows::process::CommandExt};
use tao::{event::{Event, WindowEvent}, event_loop::{ControlFlow, EventLoopBuilder}, window::WindowBuilder};
use wry::WebViewBuilder;
use base64::Engine;

const ENGINE: &[u8] = include_bytes!(env!("ASSETVAULT_INSTALLER_ENGINE"));
const HTML: &str = include_str!(env!("ASSETVAULT_INSTALLER_HTML"));
const HIDDEN: u32 = 0x08000000;

#[derive(serde::Deserialize)]
struct Request { action: String, path: Option<String>, shortcut: Option<bool> }
enum Message { Request(Request), Finished(Result<bool, String>) }

fn valid_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    // NSIS /D must be the final, unquoted argument. Restrict to a local absolute directory.
    bytes.len() > 3 && bytes[0].is_ascii_alphabetic() && &bytes[1..3] == b":\\"
        && !value.chars().any(|c| c.is_control() || "\"<>|?*".contains(c))
        && !value[3..].contains(':') && !value.ends_with([' ', '.'])
        && !Path::new(value).components().any(|c| c == std::path::Component::ParentDir)
}

fn ps_literal(value: &str) -> String { format!("'{}'", value.replace('\'', "''")) }

fn install(path: &str, shortcut: bool) -> Result<bool, String> {
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let temporary = std::env::temp_dir().join(format!("AssetVault-setup-{}-{nonce}", std::process::id()));
    fs::create_dir(&temporary).map_err(|e| e.to_string())?;
    let result = (|| {
        let engine = temporary.join("engine.exe");
        fs::write(&engine, ENGINE).map_err(|e| e.to_string())?;
        let arguments = format!("/S {} /D={path}", if shortcut { "" } else { "/NS" });
        // Elevate only the NSIS child; the UI and subsequently launched app stay unelevated.
        let script = format!("$ErrorActionPreference='Stop'; try {{ $p=Start-Process -FilePath {} -ArgumentList {} -Verb RunAs -Wait -PassThru; Write-Output $p.ExitCode }} catch {{ Write-Error $_; exit 1 }}", ps_literal(&engine.to_string_lossy()), ps_literal(&arguments));
        let output = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(HIDDEN).output().map_err(|e| e.to_string())?;
        if !output.status.success() { return Err("未能启动安装，可能已取消管理员授权。请重试。".into()); }
        match String::from_utf8_lossy(&output.stdout).trim() {
            "0" | "3010" if Path::new(path).join("assetvault.exe").is_file() => Ok(String::from_utf8_lossy(&output.stdout).trim() == "3010"),
            code => Err(format!("安装未完成（退出码 {code}）。请检查安装目录权限或关闭正在运行的 AssetVault 后重试。")),
        }
    })();
    // Only this invocation's private extraction directory is removed.
    let _ = fs::remove_dir_all(temporary);
    result
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let event_loop = EventLoopBuilder::<Message>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let window = WindowBuilder::new().with_title("安装 AssetVault")
        .with_inner_size(tao::dpi::LogicalSize::new(1040., 700.))
        .with_resizable(false).build(&event_loop)?;
    let embedded_url = format!("data:text/html;charset=utf-8;base64,{}", base64::engine::general_purpose::STANDARD.encode(HTML));
    let webview = WebViewBuilder::new().with_html(HTML)
        .with_initialization_script("window.__INSTALLER_NATIVE__=true;")
        .with_navigation_handler(move |url| url == "about:blank" || url == embedded_url)
        .with_ipc_handler(move |request| {
            if let Ok(message) = serde_json::from_str(request.body()) { let _ = proxy.send_event(Message::Request(message)); }
        }).build(&window)?;
    let mut busy = false;
    let mut installed: Option<PathBuf> = None;
    let proxy = event_loop.create_proxy();
    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        let mut report = None;
        match event {
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } if !busy => *control_flow = ControlFlow::Exit,
            Event::UserEvent(Message::Request(request)) => match request.action.as_str() {
                "install" if !busy && installed.is_none() => {
                    let path = request.path.unwrap_or_default();
                    if !valid_path(&path) { report = Some(serde_json::json!({"state":"error","message":"请选择有效的本地绝对路径，例如 C:\\Program Files\\AssetVault。"})); }
                    else {
                        installed = Some(PathBuf::from(&path));
                        busy = true;
                        let proxy = proxy.clone();
                        std::thread::spawn(move || { let _ = proxy.send_event(Message::Finished(install(&path, request.shortcut.unwrap_or(true)))); });
                    }
                }
                "launch" if !busy => if let Some(path) = &installed {
                    match Command::new(path.join("assetvault.exe")).current_dir(path).spawn() {
                        Ok(_) => *control_flow = ControlFlow::Exit,
                        Err(_) => report = Some(serde_json::json!({"state":"launch-error","message":"启动失败，请从开始菜单打开 AssetVault。"})),
                    }
                },
                "close" if !busy => *control_flow = ControlFlow::Exit,
                _ => {}
            },
            Event::UserEvent(Message::Finished(result)) => {
                busy = false;
                report = Some(match result {
                    Ok(restart) => serde_json::json!({"state":"done","restart":restart}),
                    Err(message) => { installed = None; serde_json::json!({"state":"error","message":message}) }
                });
            }
            _ => {}
        }
        if let Some(value) = report { let _ = webview.evaluate_script(&format!("window.installerStatus({value})")); }
    });
}

fn main() {
    if run().is_err() {
        // A machine without WebView2 must still be able to reach the NSIS bootstrapper.
        let temporary = std::env::temp_dir().join(format!("AssetVault-fallback-{}", std::process::id()));
        if fs::create_dir(&temporary).is_ok() {
            let engine = temporary.join("engine.exe");
            if fs::write(&engine, ENGINE).is_ok() {
                let script = format!("Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('无法打开新版安装界面，将使用标准安装向导。','AssetVault'); Start-Process -FilePath {} -Verb RunAs -Wait", ps_literal(&engine.to_string_lossy()));
                let _ = Command::new("powershell.exe").args(["-NoProfile", "-Command", &script]).creation_flags(HIDDEN).status();
            }
            let _ = fs::remove_dir_all(temporary);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validate_nsis_directory() {
        assert!(valid_path("C:\\Program Files\\AssetVault"));
        assert!(valid_path("D:\\模型工具\\AssetVault"));
        for value in ["C:\\", "relative", "C:\\a\" /S", "C:\\a\nb", "C:\\..\\Windows", "C:\\a:b", "C:\\foo."] { assert!(!valid_path(value), "{value}"); }
        assert_eq!(ps_literal("a'b"), "'a''b'");
    }
}
