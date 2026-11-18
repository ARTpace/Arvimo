// 右键不能复用 HTCAPTION 的左键系统拖动；在原生端跟踪物理坐标，跨屏也不依赖 WebView mousemove。
#[cfg(windows)]
pub fn start(window: tauri::WebviewWindow) -> Result<(), String> {
    use std::sync::atomic::{AtomicBool, Ordering};
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_RBUTTON};
    static MOVING: AtomicBool = AtomicBool::new(false);
    if MOVING.swap(true, Ordering::SeqCst) { return Ok(()); }
    std::thread::spawn(move || {
        let run = || -> Result<(), String> {
            if window.is_maximized().map_err(|e| e.to_string())? {
                window.unmaximize().map_err(|e| e.to_string())?;
                std::thread::sleep(std::time::Duration::from_millis(32));
            }
            let cursor = window.cursor_position().map_err(|e| e.to_string())?;
            let origin = window.outer_position().map_err(|e| e.to_string())?;
            let mut last = origin;
            while unsafe { GetAsyncKeyState(VK_RBUTTON.0 as i32) } < 0 {
                let point = window.cursor_position().map_err(|e| e.to_string())?;
                let next = tauri::PhysicalPosition::new(
                    origin.x + (point.x - cursor.x).round() as i32,
                    origin.y + (point.y - cursor.y).round() as i32,
                );
                if next != last {
                    window.set_position(next).map_err(|e| e.to_string())?;
                    last = next;
                }
                std::thread::sleep(std::time::Duration::from_millis(8));
            }
            Ok(())
        };
        if let Err(error) = run() { eprintln!("[window-drag] {error}"); }
        MOVING.store(false, Ordering::SeqCst);
    });
    Ok(())
}

#[cfg(not(windows))]
pub fn start(_window: tauri::WebviewWindow) -> Result<(), String> {
    Err("Right-button window dragging is only supported on Windows".into())
}
