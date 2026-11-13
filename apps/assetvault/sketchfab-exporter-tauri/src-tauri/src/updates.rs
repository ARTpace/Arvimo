use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct UpdateState(pub tauri::async_runtime::Mutex<Option<(Update, Option<Vec<u8>>)>>);

#[tauri::command]
pub async fn check_app_update(app: AppHandle) -> Result<serde_json::Value, String> {
    let state = app.state::<UpdateState>();
    let mut pending = state.0.try_lock().map_err(|_| "更新任务正在进行，请稍候")?;
    if pending.as_ref().is_some_and(|(_, bytes)| bytes.is_some()) {
        let update = &pending.as_ref().unwrap().0;
        return Ok(serde_json::json!({"available":true,"ready":true,"version":update.version,"notes":update.body}));
    }
    let handle = app.clone();
    let update = app.updater_builder().on_before_exit(move || {
        handle.state::<super::NodeGuard>().stop();
    }).timeout(std::time::Duration::from_secs(20))
        .build().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    let result = match &update {
        Some(value) => serde_json::json!({"available":true,"version":value.version,"notes":value.body}),
        None => serde_json::json!({"available":false,"version":app.package_info().version.to_string()}),
    };
    *pending = update.map(|value| (value, None));
    Ok(result)
}

#[tauri::command]
pub async fn download_app_update(app: AppHandle) -> Result<(), String> {
    let state = app.state::<UpdateState>();
    let mut pending = state.0.try_lock().map_err(|_| "更新任务正在进行")?;
    let (update, bytes) = pending.as_mut().ok_or("请先检查更新")?;
    if bytes.is_some() { return Ok(()); }
    let mut received = 0u64;
    let data = update.download(|chunk, total| {
        received += chunk as u64;
        let _ = app.emit("assetvault:update-progress", serde_json::json!({"received":received,"total":total}));
    }, || {}).await.map_err(|e| e.to_string())?;
    // The updater verifies the embedded public-key signature before returning bytes.
    *bytes = Some(data);
    Ok(())
}

#[tauri::command]
pub async fn install_app_update(app: AppHandle) -> Result<(), String> {
    let state = app.state::<UpdateState>();
    let mut pending = state.0.try_lock().map_err(|_| "更新任务正在进行")?;
    let (update, bytes) = pending.as_mut().ok_or("请先下载更新")?;
    let data = bytes.as_ref().ok_or("更新尚未下载完成")?;
    if let Err(error) = update.install(data) {
        // A denied elevation can return after the updater's pre-exit cleanup.
        if app.state::<super::NodeGuard>().0.lock().unwrap().is_none() {
            let _ = super::start_backend(&app);
        }
        return Err(error.to_string());
    }
    Ok(())
}
