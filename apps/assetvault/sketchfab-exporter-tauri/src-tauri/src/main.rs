// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod licensing;
mod updates;
mod data_path;
mod process_group;
mod dragout;
mod window_drag;

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

/// Windows 下隐藏被拉起的 node sidecar 控制台窗口（避免启动瞬间闪一下命令行窗）。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// 持有 node 服务子进程句柄，应用退出时统一回收。
struct NodeGuard(Mutex<Option<Child>>, Mutex<Option<process_group::ProcessGroup>>);
impl NodeGuard {
    fn stop(&self) {
        println!("[desktop] stopping backend process group");
        if let Some(mut child) = self.0.lock().unwrap().take() {
            // Closing the job kills Node and its workers, not unrelated applications.
            self.1.lock().unwrap().take();
            let _ = child.kill();
            let _ = child.wait();
        }
        println!("[desktop] backend process group stopped");
    }
}
#[derive(Default)]
struct BootError(Mutex<Option<String>>);

#[derive(Default)]
struct BackendReady(Mutex<Option<String>>);

#[tauri::command]
fn backend_ready_url(app: AppHandle) -> Option<String> {
    app.state::<BackendReady>().0.lock().unwrap().clone()
}

#[tauri::command]
fn open_ready_library(app: AppHandle) -> Result<(), String> {
    let address = app.state::<BackendReady>().0.lock().unwrap().clone()
        .ok_or("本地服务尚未就绪")?;
    let window = app.get_webview_window("main").ok_or("主窗口不存在")?;
    // 由原生宿主导航，避免本地协议页面的 JS 跳转被 WebView2 标记为跨站请求。
    window.navigate(url::Url::parse(&address).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn backend_startup_error(app: AppHandle) -> Option<String> {
    app.state::<BootError>().0.lock().unwrap().clone()
}

/// sidecar 启动所需的全部路径。setup 里先算好放进 state，
/// 这样「启动时已授权」和「界面上刚激活成功」两条路都能复用同一个启动函数。
struct Backend {
    node_exe: PathBuf,
    entry: PathBuf,
    static_root: PathBuf,
    data_dir: PathBuf,
    /// 账号与机器令牌（多个资源库共用一套，所以放在 data_dir 外面）
    accounts_dir: PathBuf,
    download_dir: PathBuf,
    browser_exe: PathBuf,
    browser_root: PathBuf,
    license_path: PathBuf,
}

/// 托盘可用时关窗隐藏，否则最小化，避免窗口隐藏后无法找回。
static TRAY_READY: AtomicBool = AtomicBool::new(false);

/// 兼容仍缓存着旧关闭弹窗逻辑的前端。
#[tauri::command]
fn close_ui_ready() {
    // 保留旧前端命令兼容性；关闭行为由原生窗口统一处理。
}

/// 从托盘把主窗口叫回来：可能被「缩到托盘」隐藏过，也可能还最小化着。
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn restart_app(app: &AppHandle) {
    // 开发版由启动器重启 CLI，保留开发服务器与热更新监听。
    #[cfg(debug_assertions)]
    if let Some(marker) = std::env::var_os("ARVIMO_DEV_RESTART_FILE") {
        if let Err(error) = std::fs::write(marker, b"restart") {
            eprintln!("无法请求重启开发版：{error}");
            return;
        }
        app.exit(0);
        return;
    }
    // 原生退出事件会先回收 NodeGuard，再启动新的应用进程。
    app.request_restart();
}

/// 「缩到托盘」：只把窗口藏起来，node 服务与后台下载照常跑，点托盘图标随时叫回来。
#[tauri::command]
fn hide_to_tray(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

/// 「退出应用」：走正常退出流程，RunEvent::Exit 里会把 node 子进程一并回收。
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    println!("[desktop] explicit quit requested");
    app.exit(0);
}

/// 用系统默认浏览器打开外部网页。
///
/// WebView 里的 target="_blank" / window.open 在 Tauri 里不会走系统浏览器（多半什么都不发生），
/// 所以资产详情页的所有外链统一走这个命令。只放行 http/https：这是给用户主动点的链接用的，
/// 不该让界面拿着任意协议（比如 file://）去调系统。
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("只允许打开 http/https 链接".to_string());
    }
    #[cfg(windows)]
    {
        // 不走 cmd.exe：cmd /c start 会被 shell 解析出第二个 & 之后的命令。
        // rundll32 url.dll,FileProtocolHandler 直接交给系统 ShellExecute，是 Windows 官方做法。
        let mut cmd = Command::new("rundll32.exe");
        cmd.arg("url.dll,FileProtocolHandler").arg(trimmed);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.spawn()
            .map(|_| ())
            .map_err(|e| format!("无法打开默认浏览器：{e}"))
    }
    #[cfg(not(windows))]
    {
        Command::new("xdg-open")
            .arg(trimmed)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("无法打开默认浏览器：{e}"))
    }
}

// ---------------------------------------------------------------------------
// 授权
// ---------------------------------------------------------------------------

/// 授权闸门开关。
///
/// false = 免激活：装完直接用，不再拦在本地服务前面（当前发布策略）。
/// true  = 恢复「未授权不拉起本地服务，界面停在激活页」。
///
/// 关掉的不是授权本身 —— 验签、机器指纹、离线签发工具（licensing.rs / tools/keygen.mjs）
/// 全都还在，把这里改回 true 即可恢复，不需要重写任何东西。
const LICENSE_GATE: bool = false;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LicenseStatus {
    licensed: bool,
    /// 未授权时是失败原因；已授权时是所用密钥。
    reason: String,
    machine_code: String,
    /// 完整机器指纹（AVFP1.…）。纯离线签发的模式下，用户把这串发给发行方，
    /// 发行方据此签发一份绑定本机的授权文件。
    fingerprint: String,
    /// 3 个硬件因子的哈希，激活时原样回传给授权服务做同机判定。
    factors: Vec<String>,
    server: String,
    max_devices: u32,
    /// 闸门当前是否开启。免激活发布时界面据此跳过激活面板，只显示「正在启动…」。
    gate: bool,
}

// ── 开机自启 ────────────────────────────────────────────────────────────────
//
// 直接写 HKCU\...\Run，而不是引入 tauri-plugin-autostart：那条路要多一个 cargo 依赖、
// 一份 capability 配置和一次插件初始化；而 Windows 上的「开机自启」本质就是一个注册表
// 字符串值，用已有的 winreg 写一行就够，少一个安装失败点。
//
// 值里带 --autostart：开机拉起时只把服务留在托盘，不弹主窗口（见 setup 末尾）。
// 用户主动双击不会带这个参数，行为和以前完全一致。
const AUTOSTART_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const AUTOSTART_VALUE: &str = "AssetVault";
const AUTOSTART_FLAG: &str = "--autostart";

#[derive(serde::Serialize)]
struct AutostartStatus {
    /// 当前平台能不能设。非 Windows 一律 false，界面据此隐藏开关。
    supported: bool,
    enabled: bool,
    /// 注册表里记的启动命令：程序被搬走时，界面能据此提示「它指向的还是旧位置」。
    command: Option<String>,
}

#[cfg(windows)]
fn autostart_command() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|error| format!("拿不到程序路径：{error}"))?;
    // 引号必须有：Program Files 下的路径带空格，不加会被拆成「程序」+「参数」两截。
    Ok(format!("\"{}\" {}", exe.display(), AUTOSTART_FLAG))
}

#[cfg(windows)]
fn read_autostart() -> AutostartStatus {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = match hkcu.open_subkey_with_flags(AUTOSTART_KEY, KEY_READ) {
        Ok(key) => key,
        Err(_) => return AutostartStatus { supported: true, enabled: false, command: None },
    };
    match key.get_value::<String, _>(AUTOSTART_VALUE) {
        Ok(command) if !command.trim().is_empty() => {
            AutostartStatus { supported: true, enabled: true, command: Some(command) }
        }
        _ => AutostartStatus { supported: true, enabled: false, command: None },
    }
}

#[tauri::command]
fn autostart_status() -> AutostartStatus {
    #[cfg(windows)]
    {
        read_autostart()
    }
    #[cfg(not(windows))]
    {
        AutostartStatus { supported: false, enabled: false, command: None }
    }
}

#[tauri::command]
fn autostart_set(enabled: bool) -> Result<AutostartStatus, String> {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (key, _) = hkcu
            .create_subkey(AUTOSTART_KEY)
            .map_err(|error| format!("打开启动项注册表失败：{error}"))?;
        if enabled {
            let command = autostart_command()?;
            key.set_value(AUTOSTART_VALUE, &command)
                .map_err(|error| format!("写入启动项失败：{error}"))?;
        } else {
            // 本来就没有这一项时 delete_value 会给 NotFound，那不是错误。
            match key.delete_value(AUTOSTART_VALUE) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(format!("移除启动项失败：{error}")),
            }
        }
        Ok(read_autostart())
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Err("当前平台不支持开机自启".to_string())
    }
}

/// 界面启动时主动来问（不用事件推送：setup 阶段窗口可能还没加载完，推了会丢）。
#[tauri::command]
fn license_info(app: AppHandle) -> LicenseStatus {
    let factors = licensing::machine_factors();
    let path = app.state::<Backend>().license_path.clone();
    let machine_code = licensing::machine_code(&factors);
    let fingerprint = licensing::fingerprint(&factors);
    let server = licensing::server_url();
    let (licensed, reason, max_devices) = match licensing::load(&path, &factors) {
        Ok(payload) => (true, payload.key, payload.max_devices),
        Err(reason) => (false, reason, 0),
    };
    LicenseStatus {
        licensed,
        reason,
        machine_code,
        fingerprint,
        factors,
        server,
        max_devices,
        gate: LICENSE_GATE,
    }
}

/// 界面拿到授权文件后回传：先验签 + 比对机器，通过才落盘，然后才拉起本地服务。
/// 顺序很重要 —— 校验没过就绝不启动 sidecar，改前端 JS 也绕不过去。
#[tauri::command]
fn activate_with(app: AppHandle, license: String) -> Result<String, String> {
    let factors = licensing::machine_factors();
    let path = app.state::<Backend>().license_path.clone();
    let payload = licensing::verify(&license, &factors)?;
    licensing::save(&path, &license)?;
    start_backend(&app)?;
    Ok(payload.key)
}

// ---------------------------------------------------------------------------
// sidecar 启动
// ---------------------------------------------------------------------------

/// 拉起 node sidecar，并把就绪地址交给本地加载页，由它直接进入工作台。
fn start_backend(app: &AppHandle) -> Result<(), String> {
    if app.state::<NodeGuard>().0.lock().unwrap().is_some() {
        return Ok(());
    }
    let backend = app.state::<Backend>();
    *app.state::<BootError>().0.lock().unwrap() = None;
    *app.state::<BackendReady>().0.lock().unwrap() = None;
    // 后台优先绑定固定端口，冲突时自行回退并通过自己的 stdout 报告实际端口。
    let port = 4179;
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<u16>();
    let mut cmd = Command::new(&backend.node_exe);
    #[cfg(debug_assertions)]
    cmd.arg("--watch");
    let group = process_group::ProcessGroup::new().map_err(|e| format!("无法创建后台进程组：{e}"))?;
    cmd.arg(&backend.entry)
        .env("SFX_STATIC_ROOT", &backend.static_root)
        // 库数据目录不再钉死在这里：库是自包含的（<库>/.assetvault/data），
        // 服务端按 libraries.json 自己找回。硬指应用数据目录会让整个库拷到
        // 别的机器后打不开，也让"拔了硬盘就走"变成一句空话。
        // 账号（SFX_ACCOUNTS_DIR）、浏览器、下载仍是机器级的，继续由下面几个变量钉住。
        .env("SFX_ACCOUNTS_DIR", &backend.accounts_dir)
        .env("SFX_REPLACE_LIBRARY_OWNER", "1")
        .env("SFX_DOWNLOAD_DIR", &backend.download_dir)
        .env("SFX_BROWSER", &backend.browser_exe)
        .env("SFX_BROWSER_INSTALL_DIR", &backend.browser_root)
        // 工具是本机直连抓取，绝不应走用户机器上的系统代理 / 环境变量代理
        // （127.0.0.1 上的劫持代理会把所有外发请求导歪，导致搜索与下载全部失败）。
        // SFX_PROXY=none 强制直连，且不再回落到 HTTPS_PROXY 或 Windows 系统代理。
        .env("SFX_PROXY", "none")
        .env("SFX_NO_SYSTEM_PROXY", "1")
        .env("SFX_PORT", port.to_string())
        .env("SFX_PORT_FALLBACK", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Windows 下隐藏被拉起的 node 控制台窗口，避免启动瞬间闪一下命令行窗。
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd.spawn().map_err(|e| {
        let message = format!("启动 node 服务失败: {e}");
        *app.state::<BootError>().0.lock().unwrap() = Some(message.clone());
        message
    })?;
    if let Err(error) = group.attach(&child) {
        let _ = child.kill();let _ = child.wait();
        return Err(format!("无法管理后台进程生命周期：{error}"));
    }
    app.state::<NodeGuard>().1.lock().unwrap().replace(group);

    // 转发子进程日志到主进程 stdout/stderr，便于排查。
    if let Some(out) = child.stdout.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if let Some(value) = line.strip_prefix("ASSETVAULT_READY_PORT=") {
                    if let Ok(port) = value.parse::<u16>() {
                        if port != 0 { let _ = ready_tx.send(port); }
                    }
                }
                println!("[node] {line}");
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        let handle = app.clone();
        let log = backend.data_dir.join("startup-error.log");
        std::thread::spawn(move || {
            let mut lines = Vec::new();
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                eprintln!("[node] {line}");
                lines.push(line);
                if lines.len() > 40 { lines.remove(0); }
            }
            if !lines.is_empty() {
                let details = lines.join("\n");
                let _ = std::fs::write(&log, &details);
                let message = if details.contains("另一个服务使用") {
                    "启动失败：另一个艺团后台服务正在使用下载记录。请退出旧版软件或源码启动的服务后重新打开。".to_string()
                } else { format!("本地服务启动失败：{}。日志：{}", lines.last().unwrap(), log.display()) };
                *handle.state::<BootError>().0.lock().unwrap() = Some(message);
            }
        });
    }

    app.state::<NodeGuard>().0.lock().unwrap().replace(child);

    let handle = app.clone();
    std::thread::spawn(move || {
        if let Ok(port) = ready_rx.recv_timeout(std::time::Duration::from_secs(45)) {
            // ponytail: 本地加载页持续显示，只发布就绪地址，不再跳到第二张启动页。
            *handle.state::<BackendReady>().0.lock().unwrap() = Some(format!("http://127.0.0.1:{port}/"));
        } else {
            eprintln!("[node] 本地服务未报告就绪端口，界面会停在等待页。");
            let state = handle.state::<BootError>();
            let mut error = state.0.lock().unwrap();
            if error.is_none() { *error = Some("本地服务启动超时，请关闭旧版艺团 后重新打开。".into()); }
        }
    });

    Ok(())
}

#[tauri::command]
fn desktop_window_action(window: tauri::WebviewWindow, action: String) -> Result<(), String> {
    if action == "drag-right" { return window_drag::start(window); }
    let result = match action.as_str() {
        "drag" => window.start_dragging(),
        "minimize" => window.minimize(),
        "maximize" => match window.is_maximized() {
            Ok(true) => window.unmaximize(),
            Ok(false) => window.maximize(),
            Err(error) => return Err(error.to_string()),
        },
        "close" => window.close(),
        _ => return Err("Unknown window action".into()),
    };
    result.map_err(|error| error.to_string())
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show_main_window(app)))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updates::UpdateState::default())
        .manage(NodeGuard(Mutex::new(None), Mutex::new(None)))
        .manage(BootError::default())
        .manage(BackendReady::default())
        .setup(|app| {
            // 资源随安装包解压：node.exe 运行时 + sidecar-server 目录。
            #[cfg(not(debug_assertions))]
            let resource_dir = app.path().resource_dir()?;
            #[cfg(debug_assertions)]
            let library_project = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
            #[cfg(debug_assertions)]
            let resource_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            // 数据与下载目录放到应用数据目录，避免写入安装目录（可能无写权限）。
            #[cfg(not(debug_assertions))]
            let app_data = data_path::resolve(&app.path().app_data_dir()?)?;
            #[cfg(debug_assertions)]
            let app_data = library_project.join("../../_local/desktop-dev");

            let data_dir = app_data.join("data");
            let download_dir = app_data.join("downloads");
            let _ = std::fs::create_dir_all(&data_dir);
            let _ = std::fs::create_dir_all(&download_dir);
            // 账号不能跟着 data_dir 走：一旦显式传了 SFX_DATA_DIR，服务端会把账号目录
            // 算成 <dataDir>/accounts，切资源库就等于换了个人。这里把它钉在 app_data 下。
            let accounts_dir = app_data.join("accounts");
            let _ = std::fs::create_dir_all(&accounts_dir);

            // 独立 Chromium headless shell 不再随安装包分发（解压后 236MB，占安装包九成体积），
            // 改成安装后在设置里点一下按需下载到应用数据目录。SFX_BROWSER 指向的因此是
            // “将来的下载位置”而不是随包资源：browserPath() 每次都做存在性判断，下载完成后
            // 同一路径立刻生效、不用重启；还没下载时会自动回落到系统 Edge/Chrome。
            let browser_root = app_data.join("browsers");
            let _ = std::fs::create_dir_all(&browser_root);

            app.manage(Backend {
                node_exe: resource_dir
                    .join("binaries")
                    .join("node-x86_64-pc-windows-msvc.exe"),
                entry: {
                    #[cfg(debug_assertions)]
                    { library_project.join("server/library.mjs") }
                    #[cfg(not(debug_assertions))]
                    { resource_dir.join("sidecar-server/server/library.mjs") }
                },
                static_root: {
                    #[cfg(debug_assertions)]
                    { library_project.join("dist/library") }
                    #[cfg(not(debug_assertions))]
                    { resource_dir.join("sidecar-server/dist/library") }
                },
                browser_exe: browser_root
                    .join("chrome-headless-shell-win64")
                    .join("chrome-headless-shell.exe"),
                browser_root,
                data_dir,
                accounts_dir,
                download_dir,
                license_path: app_data.join(licensing::LICENSE_FILE),
            });

            // 授权闸门：没通过就完全不拉起本地服务，界面会停在 waiting.html 显示激活面板。
            // 这是整套授权的落点 —— 即使有人改了前端 JS，服务没起来也拿不到任何数据。
            // LICENSE_GATE=false 时闸门整体跳过（免激活发布），服务照常拉起。
            // Let the event loop paint waiting.html while licensing and Node start in the background.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
            let factors = licensing::machine_factors();
            let license_path = handle.state::<Backend>().license_path.clone();
            match licensing::load(&license_path, &factors) {
                Ok(_) => {
                    if let Err(error) = start_backend(&handle) {
                        eprintln!("[license] {error}");
                    }
                }
                Err(reason) => {
                    if LICENSE_GATE {
                        println!("[license] 未授权（{reason}），等待界面激活。");
                    } else {
                        // 免激活：授权状态只留痕，不再挡在启动前面。
                        println!("[license] 免激活模式（本机未授权：{reason}），直接启动本地服务。");
                        if let Err(error) = start_backend(&handle) {
                            eprintln!("[license] {error}");
                        }
                    }
                }
            }

            });

            // 常驻托盘：关窗口后后台服务继续运行。
            // 左键单击 = 唤起窗口；右键 = 弹出菜单（打开 / 重启 / 退出）。
            let show_item = MenuItem::with_id(app, "show", "打开 Arvimo", true, None::<&str>)?;
            let restart_item = MenuItem::with_id(app, "restart", "重启应用", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &restart_item, &quit_item])?;
            let mut tray = TrayIconBuilder::with_id("main-tray")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("Arvimo · 艺团")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "restart" => restart_app(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            // 托盘建不起来（系统策略等原因）不该拖垮整个应用：提示一声，照常启动。
            match tray.build(app) {
                Ok(_) => TRAY_READY.store(true, Ordering::Relaxed),
                Err(error) => eprintln!("创建系统托盘失败，关闭窗口会改为最小化：{error}"),
            }

            // 开机自启拉起（带 --autostart）时只留在托盘：用户开机是为了让下载/服务在后台跑，
            // 不是要看一脸启动画面。托盘建不起来就不隐藏 —— 否则窗口藏了没法找回。
            if std::env::args().any(|arg| arg == AUTOSTART_FLAG) && TRAY_READY.load(Ordering::Relaxed) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }

            Ok(())
        })
        .on_page_load(|webview, payload| {
            if webview.label() == "main" && payload.event() == tauri::webview::PageLoadEvent::Finished {
                #[cfg(debug_assertions)]
                let chrome = std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/desktop-chrome.js"))
                    .unwrap_or_else(|_| include_str!("desktop-chrome.js").into());
                #[cfg(not(debug_assertions))]
                let chrome = include_str!("desktop-chrome.js");
                if let Err(error) = webview.eval(&chrome) {
                    eprintln!("Window chrome: {error}");
                }
                #[cfg(debug_assertions)]
                if let Ok(port) = std::env::var("ARVIMO_DEV_RELOAD_PORT") {
                    if let Ok(port) = port.parse::<u16>() {
                        let _ = webview.eval(format!("new EventSource('http://127.0.0.1:{port}/events').onmessage=()=>location.reload();"));
                    }
                }
            }
        })
        // 原生处理关闭，启动页或前端异常时也能保持后台任务运行。
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if !TRAY_READY.load(Ordering::Relaxed) || window.hide().is_err() {
                    let _ = window.minimize();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            desktop_window_action,
            hide_to_tray,
            quit_app,
            open_external,
            close_ui_ready,
            backend_startup_error,
            backend_ready_url,
            open_ready_library,
            license_info,
            autostart_status,
            autostart_set,
            activate_with,
            updates::check_app_update,
            updates::download_app_update,
            updates::install_app_update,
            dragout::start_file_drag
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            app_handle.state::<NodeGuard>().stop();
        }
    });
}
