use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::config::{safe_external_update_url, write_json_pretty_atomic};
use crate::desktop::local_library::LocalImportEntry;
use crate::desktop::memory::{
    get_memory_snapshot as mem_snapshot, purge_system_memory as mem_purge,
    trim_app_memory as mem_trim, PurgeSystemMemoryPayload,
};
use crate::desktop::win32;
use crate::server::AppBackendState;

const WINDOW_SETTINGS_FILE: &str = "window-settings.json";
const DESKTOP_LYRICS_LABEL: &str = "desktop-lyrics";
const PLATFORM_LOGIN_LABEL: &str = "platform-login";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedWindowSettings {
    close_behavior: String,
}

impl Default for PersistedWindowSettings {
    fn default() -> Self {
        Self {
            close_behavior: "tray".to_string(),
        }
    }
}

pub(crate) fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub struct TauriAppState {
    pub backend: Arc<AppBackendState>,
    pub http_port: AtomicU16,
    pub desktop_lyrics_enabled: AtomicBool,
    pub desktop_lyrics_locked: AtomicBool,
    pub desktop_lyrics_payload: Mutex<Option<Value>>,
    pub close_behavior: Mutex<String>,
    pub desktop_software_locked: AtomicBool,
    pub desktop_icons_visible: AtomicBool,
    pub global_hotkey_bindings: Mutex<Vec<Value>>,
    pub pointer_route: Mutex<Value>,
    pub pointer_poll_seq: AtomicU64,
    pub memory_reduct_enabled: AtomicBool,
    pub memory_reduct_include_system: AtomicBool,
    pub memory_reduct_purge_mask: AtomicU64,
    pub memory_reduct_interval_sec: AtomicU64,
    pub memory_reduct_task_seq: AtomicU64,
    pub platform_login_seq: AtomicU64,
}

impl TauriAppState {
    pub fn new(backend: Arc<AppBackendState>) -> Self {
        let settings_path = backend.config.paths().user_data_dir.join(WINDOW_SETTINGS_FILE);
        let close_behavior = std::fs::read_to_string(&settings_path)
            .ok()
            .and_then(|s| serde_json::from_str::<PersistedWindowSettings>(&s).ok())
            .map(|s| normalize_close_behavior(&s.close_behavior))
            .unwrap_or_else(|| "tray".to_string());

        Self {
            backend,
            http_port: AtomicU16::new(0),
            desktop_lyrics_enabled: AtomicBool::new(false),
            desktop_lyrics_locked: AtomicBool::new(false),
            desktop_lyrics_payload: Mutex::new(None),
            close_behavior: Mutex::new(close_behavior),
            desktop_software_locked: AtomicBool::new(false),
            desktop_icons_visible: AtomicBool::new(true),
            global_hotkey_bindings: Mutex::new(Vec::new()),
            pointer_route: Mutex::new(json!({
                "overSoftwareUi": true,
                "overDesktopControls": false
            })),
            pointer_poll_seq: AtomicU64::new(0),
            memory_reduct_enabled: AtomicBool::new(false),
            memory_reduct_include_system: AtomicBool::new(false),
            memory_reduct_purge_mask: AtomicU64::new(0),
            memory_reduct_interval_sec: AtomicU64::new(60),
            memory_reduct_task_seq: AtomicU64::new(0),
            platform_login_seq: AtomicU64::new(0),
        }
    }

    pub fn http_base(&self) -> String {
        let port = self.http_port.load(Ordering::Acquire);
        if port > 0 {
            format!("http://127.0.0.1:{port}")
        } else {
            String::new()
        }
    }

    pub fn save_close_behavior(&self, behavior: &str) -> String {
        let norm = normalize_close_behavior(behavior);
        *lock_unpoisoned(&self.close_behavior) = norm.clone();
        let settings_path = self
            .backend
            .config
            .paths()
            .user_data_dir
            .join(WINDOW_SETTINGS_FILE);
        let _ = write_json_pretty_atomic(
            &settings_path,
            &PersistedWindowSettings {
                close_behavior: norm.clone(),
            },
        );
        norm
    }
}

fn normalize_close_behavior(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "quit" | "exit" => "quit".to_string(),
        _ => "tray".to_string(),
    }
}

pub fn build_window_state_payload(app: &AppHandle, state: &TauriAppState) -> Value {
    let win = app.get_webview_window("main");
    let is_maximized = win
        .as_ref()
        .and_then(|w| w.is_maximized().ok())
        .unwrap_or(false);
    let is_fullscreen = win
        .as_ref()
        .and_then(|w| w.is_fullscreen().ok())
        .unwrap_or(false);
    let is_minimized = win
        .as_ref()
        .and_then(|w| w.is_minimized().ok())
        .unwrap_or(false);
    let wp_status = state.backend.wallpaper_engine.get_wallpaper_mode_status();
    let close_behavior = lock_unpoisoned(&state.close_behavior).clone();

    json!({
        "isDesktop": true,
        "isMaximized": is_maximized,
        "isFullScreen": is_fullscreen,
        "isMinimized": is_minimized,
        "isDesktopEmbedded": wp_status.enabled,
        "isDesktopInteractive": !state.desktop_software_locked.load(Ordering::Relaxed),
        "isPrimaryDisplay": true,
        "hasDisplayOnLeft": false,
        "closeBehavior": close_behavior,
    })
}

pub fn emit_window_state(app: &AppHandle, state: &TauriAppState) {
    let payload = build_window_state_payload(app, state);
    let _ = app.emit("desktop-window-state", payload);
}

#[tauri::command]
pub fn get_runtime_endpoints(state: tauri::State<'_, Arc<TauriAppState>>) -> Value {
    json!({
        "httpBase": state.http_base(),
        "mediaToken": state.backend.local_library.media_token(),
        "wallpaperMediaToken": state.backend.wallpaper_engine.media_token(),
    })
}

/// 退出看门狗：app.exit(0) 依赖事件循环完成收尾；若收尾流程（子窗口销毁、
/// Win32 桌面挂载清理等）在个别环境卡住，2 秒后强制结束进程，保证
/// 「退出应用 / 托盘退出 / 关闭按钮直接退出」在任何情况下都能真正关掉应用。
pub fn spawn_exit_watchdog() {
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_secs(2));
        std::process::exit(0);
    });
}

/// 在应用真正退出前执行清理：恢复桌面图标、解除 WorkerW 挂载、关闭鼠标穿透及销毁子窗口。
pub fn cleanup_before_app_exit(app: &AppHandle, state: &TauriAppState) {
    state.pointer_poll_seq.fetch_add(1, Ordering::AcqRel);
    state.platform_login_seq.fetch_add(1, Ordering::AcqRel);
    state.memory_reduct_enabled.store(false, Ordering::Release);
    state.memory_reduct_task_seq.fetch_add(1, Ordering::AcqRel);
    state.desktop_software_locked.store(false, Ordering::Release);

    if !state.desktop_icons_visible.load(Ordering::Acquire) {
        if win32::set_desktop_icons_visible(true).is_ok() {
            state.desktop_icons_visible.store(true, Ordering::Release);
        }
    }

    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_ignore_cursor_events(false);
        #[cfg(target_os = "windows")]
        {
            if let Ok(hwnd) = win.hwnd() {
                let _ = win32::set_full_desktop_attached(hwnd.0 as isize, false);
            }
        }
    }

    for label in [DESKTOP_LYRICS_LABEL, PLATFORM_LOGIN_LABEL] {
        if let Some(child_win) = app.get_webview_window(label) {
            let _ = child_win.close();
        }
    }
}

// ==================== 窗口控制 ====================

#[tauri::command]
pub fn desktop_window_minimize(
    app: AppHandle,
    state: tauri::State<'_, Arc<TauriAppState>>,
) -> Value {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.minimize();
        emit_window_state(&app, &state);
        return json!({ "ok": true });
    }
    json!({ "ok": false })
}

#[tauri::command]
pub fn desktop_window_restore(
    app: AppHandle,
    state: tauri::State<'_, Arc<TauriAppState>>,
) -> Value {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        emit_window_state(&app, &state);
        return json!({ "ok": true });
    }
    json!({ "ok": false })
}

#[tauri::command]
pub fn desktop_window_toggle_maximize(
    app: AppHandle,
    state: tauri::State<'_, Arc<TauriAppState>>,
) -> Value {
    if let Some(win) = app.get_webview_window("main") {
        let is_max = win.is_maximized().unwrap_or(false);
        if is_max {
            let _ = win.unmaximize();
        } else {
            let _ = win.maximize();
        }
        emit_window_state(&app, &state);
        return json!({ "ok": true, "isMaximized": !is_max });
    }
    json!({ "ok": false })
}

#[tauri::command]
pub fn desktop_window_toggle_fullscreen(
    app: AppHandle,
    state: tauri::State<'_, Arc<TauriAppState>>,
) -> Value {
    if let Some(win) = app.get_webview_window("main") {
        let is_fs = win.is_fullscreen().unwrap_or(false);
        let _ = win.set_fullscreen(!is_fs);
        emit_window_state(&app, &state);
        return json!({ "ok": true, "isFullScreen": !is_fs });
    }
    json!({ "ok": false })
}

#[tauri::command]
pub fn desktop_window_exit_fullscreen_windowed(
    app: AppHandle,
    state: tauri::State<'_, Arc<TauriAppState>>,
) -> Value {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_fullscreen(false);
        let _ = win.unmaximize();
        emit_window_state(&app, &state);
        return json!({ "ok": true, "isFullScreen": false });
    }
    json!({ "ok": false })
}

#[tauri::command]
pub fn desktop_window_close(
    app: AppHandle,
    state: tauri::State<'_, Arc<TauriAppState>>,
    behavior: Option<String>,
) -> Value {
    let resolved = behavior
        .as_deref()
        .map(normalize_close_behavior)
        .unwrap_or_else(|| lock_unpoisoned(&state.close_behavior).clone());
    if resolved == "quit" {
        cleanup_before_app_exit(&app, &state);
        spawn_exit_watchdog();
        app.exit(0);
        return json!({ "ok": true, "behavior": "quit" });
    }
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
        emit_window_state(&app, &state);
        return json!({ "ok": true, "behavior": "tray" });
    }
    json!({ "ok": false })
}

#[tauri::command]
pub fn desktop_window_get_state(
    app: AppHandle,
    state: tauri::State<'_, Arc<TauriAppState>>,
) -> Value {
    build_window_state_payload(&app, &state)
}

#[tauri::command]
pub fn desktop_window_get_close_behavior(state: tauri::State<'_, Arc<TauriAppState>>) -> Value {
    let behavior = lock_unpoisoned(&state.close_behavior).clone();
    json!({ "behavior": behavior })
}

#[tauri::command]
pub fn desktop_window_set_close_behavior(
    app: AppHandle,
    state: tauri::State<'_, Arc<TauriAppState>>,
    behavior: String,
) -> Value {
    let saved = state.save_close_behavior(&behavior);
    emit_window_state(&app, &state);
    json!({ "ok": true, "behavior": saved })
}

// ==================== 彩蛋门控 ====================

#[tauri::command]
pub fn get_login_easter_egg_status(state: tauri::State<'_, Arc<TauriAppState>>) -> Value {
    json!(state.backend.gate.public_status())
}

#[tauri::command]
pub fn unlock_login_easter_egg(
    state: tauri::State<'_, Arc<TauriAppState>>,
    password: String,
) -> Value {
    json!(state.backend.gate.unlock(&password))
}

#[tauri::command]
pub fn reset_login_easter_egg(state: tauri::State<'_, Arc<TauriAppState>>) -> Value {
    let b = state.backend.clone();
    let res = state.backend.gate.reset_for_replay(|| {
        b.clear_all_credentials();
        Ok(())
    });
    json!(res)
}

// ==================== 内置歌单 CRUD ====================

#[tauri::command]
pub fn list_built_in_playlists(state: tauri::State<'_, Arc<TauriAppState>>) -> Value {
    json!(state.backend.builtin_playlists.list())
}

#[tauri::command]
pub fn read_built_in_playlist(
    state: tauri::State<'_, Arc<TauriAppState>>,
    id: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Value {
    json!(state
        .backend
        .builtin_playlists
        .page(&id, offset.unwrap_or(0), limit.unwrap_or(200)))
}

#[tauri::command]
pub fn create_built_in_playlist(
    state: tauri::State<'_, Arc<TauriAppState>>,
    name: String,
) -> Value {
    match state.backend.builtin_playlists.create(&name) {
        Ok(res) => json!(res),
        Err(err) => json!({ "ok": false, "error": err.code() }),
    }
}

#[tauri::command]
pub fn rename_built_in_playlist(
    state: tauri::State<'_, Arc<TauriAppState>>,
    id: String,
    name: String,
) -> Value {
    match state.backend.builtin_playlists.rename(&id, &name) {
        Ok(res) => json!(res),
        Err(err) => json!({ "ok": false, "error": err.code() }),
    }
}

#[tauri::command]
pub fn delete_built_in_playlist(
    state: tauri::State<'_, Arc<TauriAppState>>,
    id: String,
) -> Value {
    match state.backend.builtin_playlists.delete(&id) {
        Ok(res) => json!(res),
        Err(err) => json!({ "ok": false, "error": err.code() }),
    }
}

#[tauri::command]
pub fn add_built_in_playlist_track(
    state: tauri::State<'_, Arc<TauriAppState>>,
    id: String,
    track: Value,
) -> Value {
    match state.backend.builtin_playlists.add_track(&id, &track) {
        Ok(res) => json!(res),
        Err(err) => json!({ "ok": false, "error": err.code() }),
    }
}

#[tauri::command]
pub fn remove_built_in_playlist_track(
    state: tauri::State<'_, Arc<TauriAppState>>,
    id: String,
    index: usize,
) -> Value {
    match state.backend.builtin_playlists.remove_track(&id, index) {
        Ok(res) => json!(res),
        Err(err) => json!({ "ok": false, "error": err.code() }),
    }
}

#[tauri::command]
pub fn reorder_built_in_playlist_track(
    state: tauri::State<'_, Arc<TauriAppState>>,
    id: String,
    from_index: usize,
    to_index: usize,
) -> Value {
    match state
        .backend
        .builtin_playlists
        .reorder_track(&id, from_index, to_index)
    {
        Ok(res) => json!(res),
        Err(err) => json!({ "ok": false, "error": err.code() }),
    }
}

// ==================== 本地曲库 ====================

#[tauri::command]
pub async fn choose_local_music_files(app: AppHandle) -> Value {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("选择本地音频文件")
            .add_filter(
                "音频文件",
                &["mp3", "flac", "wav", "m4a", "aac", "ogg", "opus", "wma", "alac", "aiff"],
            )
            .blocking_pick_files()
    })
    .await
    .ok()
    .flatten();

    match picked {
        Some(paths) if !paths.is_empty() => {
            let files: Vec<String> = paths
                .into_iter()
                .filter_map(|p| p.into_path().ok())
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            json!({ "ok": true, "canceled": false, "files": files })
        }
        _ => json!({ "ok": false, "canceled": true, "files": [] }),
    }
}

#[tauri::command]
pub fn list_local_music_library(state: tauri::State<'_, Arc<TauriAppState>>) -> Value {
    json!(state.backend.local_library.list_tracks())
}

#[tauri::command]
pub fn read_local_music_lyric(
    state: tauri::State<'_, Arc<TauriAppState>>,
    local_file_id: String,
) -> Value {
    json!(state.backend.local_library.lyric_for_track(&local_file_id))
}

#[tauri::command]
pub fn authorize_local_music(
    state: tauri::State<'_, Arc<TauriAppState>>,
    files: Vec<LocalImportEntry>,
) -> Value {
    json!(state.backend.local_library.authorize_files(files, false))
}

#[tauri::command]
pub fn import_local_music(
    state: tauri::State<'_, Arc<TauriAppState>>,
    token: String,
) -> Value {
    json!(state.backend.local_library.import_authorized(&token))
}

// ==================== 缓存与存档 ====================

#[tauri::command]
pub fn get_cache_settings(state: tauri::State<'_, Arc<TauriAppState>>) -> Value {
    json!(state.backend.config.get_cache_settings())
}

#[tauri::command]
pub fn set_cache_settings(
    state: tauri::State<'_, Arc<TauriAppState>>,
    payload: Option<Value>,
) -> Value {
    let p = payload.unwrap_or(Value::Null);
    let root = p
        .get("rootPath")
        .or_else(|| p.get("root_path"))
        .or_else(|| p.get("cacheRoot"))
        .or_else(|| p.get("path"))
        .or_else(|| p.get("dir"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| {
            state
                .backend
                .config
                .get_cache_settings()
                .settings
                .root_path
        });
    match state.backend.config.set_cache_settings(&root) {
        Ok(snap) => json!(snap),
        Err(err) => json!({ "ok": false, "error": err }),
    }
}

#[tauri::command]
pub async fn choose_cache_directory(app: AppHandle) -> Value {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("选择缓存根目录")
            .blocking_pick_folder()
    })
    .await
    .ok()
    .flatten();

    match picked.and_then(|p| p.into_path().ok()) {
        Some(path) => json!({
            "ok": true,
            "canceled": false,
            "path": path.to_string_lossy().into_owned(),
        }),
        None => json!({ "ok": false, "canceled": true }),
    }
}

#[tauri::command]
pub fn read_current_fx_autosave(state: tauri::State<'_, Arc<TauriAppState>>) -> Value {
    match state.backend.config.read_current_fx_autosave() {
        Some(snap) => json!({ "ok": true, "snapshot": snap }),
        None => json!({ "ok": true, "snapshot": Value::Null }),
    }
}

#[tauri::command]
pub fn save_current_fx_autosave(
    state: tauri::State<'_, Arc<TauriAppState>>,
    payload: Value,
) -> Value {
    match state.backend.config.save_current_fx_autosave(&payload) {
        Ok(()) => json!({ "ok": true }),
        Err(err) => json!({ "ok": false, "error": err }),
    }
}

#[tauri::command]
pub fn read_lyric_cache(
    state: tauri::State<'_, Arc<TauriAppState>>,
    key: String,
) -> Value {
    json!(state.backend.config.read_lyric_cache(&key))
}

#[tauri::command]
pub fn write_lyric_cache(
    state: tauri::State<'_, Arc<TauriAppState>>,
    key: String,
    payload: Value,
) -> Value {
    match state.backend.config.write_lyric_cache(&key, &payload) {
        Ok(()) => json!({ "ok": true }),
        Err(err) => json!({ "ok": false, "error": err }),
    }
}

// ==================== 内存快照与清理 ====================

#[tauri::command]
pub fn get_memory_snapshot() -> Value {
    json!(mem_snapshot())
}

#[tauri::command]
pub fn trim_app_memory(payload: Option<Value>) -> Value {
    let reason = payload
        .as_ref()
        .and_then(|v| v.get("reason"))
        .and_then(|v| v.as_str());
    json!(mem_trim(reason))
}

#[tauri::command]
pub fn purge_system_memory(payload: Option<PurgeSystemMemoryPayload>) -> Value {
    json!(mem_purge(payload))
}

#[tauri::command]
pub fn configure_memory_reduct(
    state: tauri::State<'_, Arc<TauriAppState>>,
    payload: Option<Value>,
) -> Value {
    let cfg = payload.unwrap_or_else(|| json!({}));
    let enabled = cfg
        .get("enabled")
        .or_else(|| cfg.get("autoTrim"))
        .or_else(|| cfg.get("auto"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let include_system = cfg
        .get("includeSystem")
        .or_else(|| cfg.get("purgeSystem"))
        .or_else(|| cfg.get("system"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let purge_mask = cfg
        .get("mask")
        .and_then(|v| v.as_u64())
        .map(|v| win32::normalize_memory_mask(Some(v as u32)) as u64)
        .unwrap_or(win32::MEMORY_MASK_DEFAULT as u64);
    let interval_sec = cfg
        .get("intervalSec")
        .or_else(|| cfg.get("intervalSeconds"))
        .and_then(|v| v.as_u64())
        .or_else(|| {
            cfg.get("intervalMs")
                .and_then(|v| v.as_u64())
                .map(|ms| ms / 1000)
        })
        .or_else(|| {
            cfg.get("intervalMinutes")
                .and_then(|v| v.as_u64())
                .map(|m| m * 60)
        })
        .or_else(|| {
            cfg.get("interval").and_then(|v| v.as_u64()).map(|v| {
                if v > 1000 {
                    v / 1000
                } else {
                    v
                }
            })
        })
        .unwrap_or(60)
        .clamp(15, 3600);

    state.memory_reduct_enabled.store(enabled, Ordering::Release);
    state
        .memory_reduct_include_system
        .store(include_system, Ordering::Release);
    state
        .memory_reduct_purge_mask
        .store(purge_mask, Ordering::Release);
    state
        .memory_reduct_interval_sec
        .store(interval_sec, Ordering::Release);
    let seq = state.memory_reduct_task_seq.fetch_add(1, Ordering::AcqRel) + 1;

    if enabled {
        let state_bg = state.inner().clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let sec = state_bg
                    .memory_reduct_interval_sec
                    .load(Ordering::Acquire)
                    .clamp(15, 3600);
                tokio::time::sleep(Duration::from_secs(sec)).await;
                if state_bg.memory_reduct_task_seq.load(Ordering::Acquire) != seq
                    || !state_bg.memory_reduct_enabled.load(Ordering::Acquire)
                {
                    break;
                }
                let _ = mem_trim(Some("memory-reduct-timer"));
                if state_bg
                    .memory_reduct_include_system
                    .load(Ordering::Acquire)
                {
                    let mask = state_bg.memory_reduct_purge_mask.load(Ordering::Acquire) as u32;
                    let _ = mem_purge(Some(PurgeSystemMemoryPayload {
                        mask: Some(mask),
                        manual: Some(false),
                        pids: None,
                    }));
                }
            }
        });
    }

    let supported = cfg!(target_os = "windows");
    json!({
        "ok": true,
        "supported": supported,
        "enabled": enabled,
        "includeSystem": include_system,
        "mask": purge_mask,
        "intervalSec": interval_sec,
        "config": cfg,
    })
}

// ==================== 桌面歌词悬浮窗 ====================

fn ensure_desktop_lyrics_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(existing) = app.get_webview_window(DESKTOP_LYRICS_LABEL) {
        return Ok(existing);
    }

    let builder = WebviewWindowBuilder::new(
        app,
        DESKTOP_LYRICS_LABEL,
        WebviewUrl::App("desktop-lyrics.html".into()),
    )
    .title("MineradioX 桌面歌词")
    .inner_size(760.0, 180.0)
    .min_inner_size(360.0, 96.0)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .focused(false)
    .visible(false);

    builder.build().map_err(|e| format!("CREATE_LYRICS_WINDOW_FAILED:{e}"))
}

fn apply_desktop_lyrics_y_position(app: &AppHandle, win: &tauri::WebviewWindow, y_val: f64) {
    if !y_val.is_finite() {
        return;
    }
    let cur_pos = win.outer_position().unwrap_or(PhysicalPosition::new(0, 0));
    let win_size = win.outer_size().unwrap_or(PhysicalSize::new(760, 180));
    let monitor = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());

    let next_y = if let Some(mon) = monitor {
        let mon_pos = mon.position();
        let mon_size = mon.size();
        let max_y = mon_pos.y + (mon_size.height as i32 - win_size.height as i32).max(0);
        let raw_y = if y_val > 0.0 && y_val <= 1.0 {
            let ratio = y_val.clamp(0.08, 0.92);
            mon_pos.y + ((mon_size.height as f64) * ratio - (win_size.height as f64) * 0.5).round() as i32
        } else {
            let scale = win.scale_factor().unwrap_or(1.0);
            (y_val * scale).round() as i32
        };
        raw_y.clamp(mon_pos.y, max_y.max(mon_pos.y))
    } else if y_val > 0.0 && y_val <= 1.0 {
        cur_pos.y
    } else {
        let scale = win.scale_factor().unwrap_or(1.0);
        (y_val * scale).round() as i32
    };

    let _ = win.set_position(PhysicalPosition::new(cur_pos.x, next_y));
}

#[tauri::command]
pub fn desktop_lyrics_get_state(state: tauri::State<'_, Arc<TauriAppState>>) -> Value {
    let payload = lock_unpoisoned(&state.desktop_lyrics_payload).clone();
    json!({
        "ok": true,
        "enabled": state.desktop_lyrics_enabled.load(Ordering::Acquire),
        "locked": state.desktop_lyrics_locked.load(Ordering::Acquire),
        "payload": payload,
    })
}

#[tauri::command]
pub fn set_desktop_lyrics_enabled(
    app: AppHandle,
    state: tauri::State<'_, Arc<TauriAppState>>,
    enabled: bool,
    payload: Option<Value>,
) -> Value {
    state
        .desktop_lyrics_enabled
        .store(enabled, Ordering::Release);
    if let Some(ref p) = payload {
        *lock_unpoisoned(&state.desktop_lyrics_payload) = Some(p.clone());
        if let Some(click_through) = p.get("clickThrough").and_then(|v| v.as_bool()) {
            state
                .desktop_lyrics_locked
                .store(click_through, Ordering::Release);
        }
    }

    if enabled {
        match ensure_desktop_lyrics_window(&app) {
            Ok(win) => {
                let locked = state.desktop_lyrics_locked.load(Ordering::Acquire);
                let _ = win.set_ignore_cursor_events(locked);
                if let Some(y_val) = payload
                    .as_ref()
                    .and_then(|p| p.get("y"))
                    .and_then(|v| v.as_f64())
                {
                    apply_desktop_lyrics_y_position(&app, &win, y_val);
                }
                let _ = win.show();
                let current_payload = lock_unpoisoned(&state.desktop_lyrics_payload).clone();
                if let Some(p) = current_payload {
                    let _ = app.emit("mineradio-desktop-lyrics-state", p);
                }
            }
            Err(err) => {
                return json!({ "ok": false, "enabled": false, "error": err });
            }
        }
    } else if let Some(win) = app.get_webview_window(DESKTOP_LYRICS_LABEL) {
        let _ = win.hide();
    }

    let _ = app.emit(
        "mineradio-desktop-lyrics-enabled-state",
        json!({ "enabled": enabled }),
    );
    json!({ "ok": true, "enabled": enabled })
}

#[tauri::command]
pub fn update_desktop_lyrics(
    app: AppHandle,
    state: tauri::State<'_, Arc<TauriAppState>>,
    payload: Value,
) -> Value {
    let merged_payload = {
        let mut guard = lock_unpoisoned(&state.desktop_lyrics_payload);
        let next = match (guard.take(), payload.clone()) {
            (Some(Value::Object(mut prev)), Value::Object(patch)) => {
                for (k, v) in patch {
                    prev.insert(k, v);
                }
                Value::Object(prev)
            }
            (_, next) => next,
        };
        *guard = Some(next.clone());
        next
    };

    if let Some(click_through) = payload.get("clickThrough").and_then(|v| v.as_bool()) {
        let prev_locked = state.desktop_lyrics_locked.load(Ordering::Acquire);
        if click_through != prev_locked {
            state
                .desktop_lyrics_locked
                .store(click_through, Ordering::Release);
            if let Some(win) = app.get_webview_window(DESKTOP_LYRICS_LABEL) {
                let _ = win.set_ignore_cursor_events(click_through);
            }
            let _ = app.emit(
                "mineradio-desktop-lyrics-lock-state",
                json!({ "locked": click_through }),
            );
        }
    }

    if let Some(y_val) = payload.get("y").and_then(|v| v.as_f64()).filter(|y| y.is_finite()) {
        if let Some(win) = app.get_webview_window(DESKTOP_LYRICS_LABEL) {
            apply_desktop_lyrics_y_position(&app, &win, y_val);
        }
    }

    let _ = app.emit("mineradio-desktop-lyrics-state", merged_payload);
    json!({ "ok": true })
}

#[tauri::command]
pub fn set_desktop_lyrics_lock_state(
    app: AppHandle,
    state: tauri::State<'_, Arc<TauriAppState>>,
    locked: bool,
) -> Value {
    state
        .desktop_lyrics_locked
        .store(locked, Ordering::Release);
    if let Some(win) = app.get_webview_window(DESKTOP_LYRICS_LABEL) {
        let _ = win.set_ignore_cursor_events(locked);
    }
    let _ = app.emit(
        "mineradio-desktop-lyrics-lock-state",
        json!({ "locked": locked }),
    );
    json!({ "ok": true, "locked": locked })
}

#[tauri::command]
pub fn move_desktop_lyrics_by(app: AppHandle, dx: f64, dy: f64) -> Value {
    if let Some(win) = app.get_webview_window(DESKTOP_LYRICS_LABEL) {
        if let Ok(pos) = win.outer_position() {
            let next_x = pos.x + dx.round() as i32;
            let next_y = pos.y + dy.round() as i32;
            let _ = win.set_position(PhysicalPosition::new(next_x, next_y));
            return json!({ "ok": true, "x": next_x, "y": next_y });
        }
    }
    json!({ "ok": false })
}

// ==================== 外部打开 / 剪贴板 / JSON 导入导出 ====================

#[tauri::command]
pub fn open_update_page(url: String) -> Value {
    let Some(safe) = safe_external_update_url(&url) else {
        return json!({ "ok": false, "error": "INVALID_UPDATE_URL" });
    };
    match opener::open(&safe) {
        Ok(()) => json!({ "ok": true, "url": safe }),
        Err(err) => json!({ "ok": false, "error": format!("OPEN_URL_FAILED:{err}") }),
    }
}

#[tauri::command]
pub fn copy_text(text: String) -> Value {
    match arboard::Clipboard::new().and_then(|mut cb| cb.set_text(text)) {
        Ok(()) => json!({ "ok": true }),
        Err(err) => json!({ "ok": false, "error": format!("CLIPBOARD_WRITE_FAILED:{err}") }),
    }
}

#[tauri::command]
pub fn read_text() -> Value {
    match arboard::Clipboard::new().and_then(|mut cb| cb.get_text()) {
        Ok(text) => json!({ "ok": true, "text": text }),
        Err(err) => json!({ "ok": false, "text": "", "error": format!("CLIPBOARD_READ_FAILED:{err}") }),
    }
}

#[tauri::command]
pub async fn export_json_file(app: AppHandle, payload: Value) -> Value {
    let default_name = payload
        .get("filename")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("mineradio-export.json")
        .to_string();
    let title = payload
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("导出 JSON 文件")
        .to_string();
    let data = payload.get("data").cloned().unwrap_or(Value::Null);

    let saved = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title(&title)
            .set_file_name(&default_name)
            .add_filter("JSON", &["json"])
            .blocking_save_file()
    })
    .await
    .ok()
    .flatten();

    let Some(path) = saved.and_then(|p| p.into_path().ok()) else {
        return json!({ "ok": false, "canceled": true });
    };

    match write_json_pretty_atomic(&path, &data) {
        Ok(()) => json!({
            "ok": true,
            "canceled": false,
            "path": path.to_string_lossy().into_owned(),
        }),
        Err(err) => json!({ "ok": false, "error": format!("EXPORT_WRITE_FAILED:{err}") }),
    }
}

#[tauri::command]
pub async fn import_json_file(app: AppHandle) -> Value {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("导入 JSON 文件")
            .add_filter("JSON", &["json"])
            .blocking_pick_file()
    })
    .await
    .ok()
    .flatten();

    let Some(path) = picked.and_then(|p| p.into_path().ok()) else {
        return json!({ "ok": false, "canceled": true });
    };

    let Ok(meta) = std::fs::metadata(&path) else {
        return json!({ "ok": false, "error": "IMPORT_READ_FAILED" });
    };
    if meta.len() > 24 * 1024 * 1024 {
        return json!({ "ok": false, "error": "IMPORT_FILE_TOO_LARGE" });
    }
    match std::fs::read_to_string(&path)
        .map_err(|e| format!("IMPORT_READ_FAILED:{e}"))
        .and_then(|s| serde_json::from_str::<Value>(&s).map_err(|e| format!("INVALID_JSON:{e}")))
    {
        Ok(data) => json!({
            "ok": true,
            "canceled": false,
            "path": path.to_string_lossy().into_owned(),
            "data": data,
        }),
        Err(err) => json!({ "ok": false, "error": err }),
    }
}

// ==================== Wallpaper Engine & 桌面模式 ====================

#[tauri::command]
pub fn list_wallpaper_engine_projects(
    state: tauri::State<'_, Arc<TauriAppState>>,
    payload: Option<Value>,
) -> Value {
    let force_refresh = payload
        .as_ref()
        .and_then(|v| v.get("forceRefresh").or_else(|| v.get("force")))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    json!(state.backend.wallpaper_engine.list_projects(force_refresh))
}

#[tauri::command]
pub fn get_wallpaper_engine_project_details(
    state: tauri::State<'_, Arc<TauriAppState>>,
    id: String,
) -> Value {
    match state.backend.wallpaper_engine.get_project_details(&id) {
        Ok(details) => json!({ "ok": true, "project": details }),
        Err(err) => json!({ "ok": false, "project": Value::Null, "error": err }),
    }
}

#[tauri::command]
pub fn open_wallpaper_engine_project_details(
    state: tauri::State<'_, Arc<TauriAppState>>,
    id: String,
    target: Option<String>,
) -> Value {
    let Ok(details) = state.backend.wallpaper_engine.get_project_details(&id) else {
        return json!({ "ok": false, "error": "WALLPAPER_PROJECT_NOT_FOUND" });
    };
    let mode = target.unwrap_or_else(|| "we".to_string());
    if mode == "workshop" {
        if !details.workshop_id.is_empty() && details.workshop_id.chars().all(|c| c.is_ascii_digit()) {
            let url = format!(
                "https://steamcommunity.com/sharedfiles/filedetails/?id={}",
                details.workshop_id
            );
            let _ = opener::open(&url);
            return json!({ "ok": true, "url": url });
        }
        return json!({ "ok": false, "error": "MISSING_WORKSHOP_ID" });
    }
    if !details.workshop_id.is_empty() && details.workshop_id.chars().all(|c| c.is_ascii_digit()) {
        let steam_url = format!("steam://url/CommunityFilePage/{}", details.workshop_id);
        if opener::open(&steam_url).is_ok() {
            return json!({ "ok": true, "url": steam_url });
        }
    }
    json!({ "ok": false, "error": "OPEN_DETAILS_UNAVAILABLE" })
}

#[tauri::command]
pub async fn choose_wallpaper_engine_directory(app: AppHandle) -> Value {
    let app_clone = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app_clone
            .dialog()
            .file()
            .set_title("添加 Wallpaper Engine 壁纸目录")
            .blocking_pick_folder()
    })
    .await
    .ok()
    .flatten();

    let Some(path) = picked.and_then(|p| p.into_path().ok()) else {
        return json!({ "ok": false, "canceled": true });
    };

    let state = app.state::<Arc<TauriAppState>>();
    match state.backend.wallpaper_engine.add_directory(&path) {
        Ok(snapshot) => json!({
            "ok": true,
            "canceled": false,
            "path": path.to_string_lossy().into_owned(),
            "snapshot": snapshot,
        }),
        Err(err) => json!({ "ok": false, "error": err }),
    }
}

#[tauri::command]
pub async fn choose_wallpaper_engine_project_file(app: AppHandle) -> Value {
    let app_clone = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app_clone
            .dialog()
            .file()
            .set_title("选择 Wallpaper Engine project.json")
            .add_filter("Wallpaper Project", &["json"])
            .blocking_pick_file()
    })
    .await
    .ok()
    .flatten();

    let Some(path) = picked.and_then(|p| p.into_path().ok()) else {
        return json!({ "ok": false, "canceled": true });
    };

    let state = app.state::<Arc<TauriAppState>>();
    match state.backend.wallpaper_engine.add_manual_project_file(&path) {
        Ok(snapshot) => json!({
            "ok": true,
            "canceled": false,
            "path": path.to_string_lossy().into_owned(),
            "snapshot": snapshot,
        }),
        Err(err) => json!({ "ok": false, "error": err }),
    }
}

#[tauri::command]
pub fn remove_wallpaper_engine_directory(
    state: tauri::State<'_, Arc<TauriAppState>>,
    root_id: String,
) -> Value {
    match state.backend.wallpaper_engine.remove_directory(&root_id) {
        Ok(snapshot) => json!({ "ok": true, "snapshot": snapshot }),
        Err(err) => json!({ "ok": false, "error": err }),
    }
}

#[tauri::command]
pub fn get_wallpaper_engine_runtime_status(
    state: tauri::State<'_, Arc<TauriAppState>>,
    _payload: Option<Value>,
) -> Value {
    let status = state.backend.wallpaper_engine.get_wallpaper_mode_status();
    json!({
        "ok": status.ok,
        "supported": status.supported,
        "active": status.enabled,
        "platform": status.platform,
        "workerwWindowId": status.workerw_window_id,
        "message": status.message,
    })
}

#[tauri::command]
pub fn start_wallpaper_engine_scene(
    _state: tauri::State<'_, Arc<TauriAppState>>,
    _payload: Option<Value>,
) -> Value {
    json!({
        "ok": false,
        "supported": cfg!(target_os = "windows"),
        "active": false,
        "message": "Wallpaper Engine scene native host is deferred on Tauri; video/image layers play directly inside MineradioX.",
    })
}

#[tauri::command]
pub fn stop_wallpaper_engine_scene(
    _state: tauri::State<'_, Arc<TauriAppState>>,
    _payload: Option<Value>,
) -> Value {
    json!({ "ok": true, "supported": cfg!(target_os = "windows"), "active": false })
}

fn emit_wallpaper_runtime_state(app: &AppHandle, state: &TauriAppState) -> Value {
    let status = state.backend.wallpaper_engine.get_wallpaper_mode_status();
    let payload = json!({
        "ok": status.ok,
        "enabled": status.enabled,
        "supported": status.supported,
        "softwareLocked": state.desktop_software_locked.load(Ordering::Acquire),
        "iconsVisible": state.desktop_icons_visible.load(Ordering::Acquire),
        "workerwWindowId": status.workerw_window_id,
        "message": status.message,
    });
    let _ = app.emit("mineradio-wallpaper-runtime-state", payload.clone());
    payload
}

#[tauri::command]
pub fn set_wallpaper_mode(
    app: AppHandle,
    state: tauri::State<'_, Arc<TauriAppState>>,
    enabled: bool,
    _payload: Option<Value>,
) -> Value {
    #[cfg(target_os = "windows")]
    {
        if let Some(win) = app.get_webview_window("main") {
            let hwnd = win.hwnd().map(|h| h.0 as isize).unwrap_or(0);
            if hwnd != 0 {
                if let Err(err) = win32::set_full_desktop_attached(hwnd, enabled) {
                    return json!({
                        "ok": false,
                        "enabled": false,
                        "supported": true,
                        "error": err,
                    });
                }
            }
        }
    }

    match state.backend.wallpaper_engine.set_wallpaper_mode(enabled) {
        Ok(_status) => {
            if !enabled {
                state.desktop_software_locked.store(false, Ordering::Release);
                state.pointer_poll_seq.fetch_add(1, Ordering::AcqRel);
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.set_ignore_cursor_events(false);
                }
            } else {
                sync_main_window_pointer_passthrough(&app, &state);
            }
            let payload = emit_wallpaper_runtime_state(&app, &state);
            emit_window_state(&app, &state);
            payload
        }
        Err(err) => json!({
            "ok": false,
            "enabled": false,
            "supported": cfg!(target_os = "windows"),
            "error": err,
        }),
    }
}

#[tauri::command]
pub fn update_wallpaper_mode(
    app: AppHandle,
    state: tauri::State<'_, Arc<TauriAppState>>,
    payload: Option<Value>,
) -> Value {
    let status = state.backend.wallpaper_engine.get_wallpaper_mode_status();
    let res = json!({
        "ok": status.ok,
        "enabled": status.enabled,
        "supported": status.supported,
        "softwareLocked": state.desktop_software_locked.load(Ordering::Acquire),
        "iconsVisible": state.desktop_icons_visible.load(Ordering::Acquire),
        "options": payload.unwrap_or_else(|| json!({})),
    });
    let _ = app.emit("mineradio-wallpaper-runtime-state", res.clone());
    res
}

#[tauri::command]
pub fn get_wallpaper_mode_status(state: tauri::State<'_, Arc<TauriAppState>>) -> Value {
    json!(state.backend.wallpaper_engine.get_wallpaper_mode_status())
}

pub(crate) fn compute_pointer_ignore(
    wallpaper_enabled: bool,
    software_locked: bool,
    route: &Value,
) -> bool {
    if !wallpaper_enabled || !software_locked {
        return false;
    }
    let over_controls = route
        .get("overDesktopControls")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    !over_controls
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn point_in_rect_value(rect: &Value, x: f64, y: f64) -> bool {
    let Some(obj) = rect.as_object() else {
        return false;
    };
    let (Some(l), Some(t), Some(r), Some(b)) = (
        obj.get("left").and_then(|v| v.as_f64()),
        obj.get("top").and_then(|v| v.as_f64()),
        obj.get("right").and_then(|v| v.as_f64()),
        obj.get("bottom").and_then(|v| v.as_f64()),
    ) else {
        return false;
    };
    x >= l && x <= r && y >= t && y <= b
}

pub fn sync_main_window_pointer_passthrough(app: &AppHandle, state: &TauriAppState) {
    let wp_enabled = state
        .backend
        .wallpaper_engine
        .get_wallpaper_mode_status()
        .enabled;
    let locked = state.desktop_software_locked.load(Ordering::Acquire);
    let route = lock_unpoisoned(&state.pointer_route).clone();
    let ignore = compute_pointer_ignore(wp_enabled, locked, &route);
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_ignore_cursor_events(ignore);
    }
}

fn start_windows_pointer_route_monitor(app: &AppHandle, state: &Arc<TauriAppState>) {
    let seq = state.pointer_poll_seq.fetch_add(1, Ordering::AcqRel) + 1;
    #[cfg(target_os = "windows")]
    {
        let app_bg = app.clone();
        let state_bg = state.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(60)).await;
                if state_bg.pointer_poll_seq.load(Ordering::Acquire) != seq
                    || !state_bg.desktop_software_locked.load(Ordering::Acquire)
                {
                    break;
                }
                let wp_enabled = state_bg
                    .backend
                    .wallpaper_engine
                    .get_wallpaper_mode_status()
                    .enabled;
                if !wp_enabled {
                    if let Some(win) = app_bg.get_webview_window("main") {
                        let _ = win.set_ignore_cursor_events(false);
                    }
                    break;
                }
                let Some(win) = app_bg.get_webview_window("main") else {
                    break;
                };
                let Ok(hwnd) = win.hwnd() else {
                    continue;
                };
                if let Some((px, py)) = win32::get_cursor_client_pos(hwnd.0 as isize) {
                    let scale = win.scale_factor().unwrap_or(1.0).max(0.5);
                    let lx = (px as f64) / scale;
                    let ly = (py as f64) / scale;
                    let route = lock_unpoisoned(&state_bg.pointer_route).clone();
                    let over_controls = route
                        .get("controlRect")
                        .map(|rect| point_in_rect_value(rect, lx, ly))
                        .unwrap_or_else(|| {
                            route
                                .get("overDesktopControls")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false)
                        });
                    let _ = win.set_ignore_cursor_events(!over_controls);
                }
            }
        });
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, seq);
    }
}

#[tauri::command]
pub fn set_desktop_software_locked(
    app: AppHandle,
    state: tauri::State<'_, Arc<TauriAppState>>,
    locked: bool,
) -> Value {
    state
        .desktop_software_locked
        .store(locked, Ordering::Release);
    sync_main_window_pointer_passthrough(&app, &state);
    if locked
        && state
            .backend
            .wallpaper_engine
            .get_wallpaper_mode_status()
            .enabled
    {
        start_windows_pointer_route_monitor(&app, state.inner());
    } else {
        state.pointer_poll_seq.fetch_add(1, Ordering::AcqRel);
    }
    emit_wallpaper_runtime_state(&app, &state);
    emit_window_state(&app, &state);
    json!({ "ok": true, "locked": locked })
}

#[tauri::command]
pub fn set_desktop_icons_visible(
    app: AppHandle,
    state: tauri::State<'_, Arc<TauriAppState>>,
    visible: bool,
) -> Value {
    match win32::set_desktop_icons_visible(visible) {
        Ok(actual) => {
            state.desktop_icons_visible.store(actual, Ordering::Release);
            emit_wallpaper_runtime_state(&app, &state);
            json!({ "ok": true, "visible": actual, "supported": cfg!(target_os = "windows") })
        }
        Err(err) => {
            emit_wallpaper_runtime_state(&app, &state);
            json!({
                "ok": false,
                "visible": state.desktop_icons_visible.load(Ordering::Relaxed),
                "supported": cfg!(target_os = "windows"),
                "error": err,
            })
        }
    }
}

#[tauri::command]
pub fn request_desktop_keyboard_focus(app: AppHandle, _reason: Option<String>) -> Value {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_focus();
    }
    json!({ "ok": true })
}

#[tauri::command]
pub fn update_desktop_pointer_route(
    app: AppHandle,
    state: tauri::State<'_, Arc<TauriAppState>>,
    payload: Value,
) -> Value {
    {
        let mut guard = lock_unpoisoned(&state.pointer_route);
        if let (Some(prev), Some(patch)) = (guard.as_object_mut(), payload.as_object()) {
            for (k, v) in patch {
                prev.insert(k.clone(), v.clone());
            }
        } else {
            *guard = payload;
        }
    }
    sync_main_window_pointer_passthrough(&app, &state);
    json!({ "ok": true })
}

#[tauri::command]
pub fn update_desktop_icon_shields(
    app: AppHandle,
    state: tauri::State<'_, Arc<TauriAppState>>,
    payload: Value,
) -> Value {
    {
        let mut guard = lock_unpoisoned(&state.pointer_route);
        if let Some(obj) = guard.as_object_mut() {
            if let Some(rect) = payload.get("controlRect") {
                obj.insert("controlRect".to_string(), rect.clone());
            }
            if let Some(over) = payload.get("overDesktopControls") {
                obj.insert("overDesktopControls".to_string(), over.clone());
            }
        }
    }
    sync_main_window_pointer_passthrough(&app, &state);
    json!({ "ok": true, "supported": cfg!(target_os = "windows") })
}

// ==================== 全局快捷键 / 诊断 / 重启 ====================

#[tauri::command]
pub fn configure_global_hotkeys(
    app: AppHandle,
    state: tauri::State<'_, Arc<TauriAppState>>,
    bindings: Vec<Value>,
) -> Value {
    *lock_unpoisoned(&state.global_hotkey_bindings) = bindings.clone();
    let manager = app.global_shortcut();
    let _ = manager.unregister_all();

    let mut registered = 0usize;
    let mut errors: Vec<String> = Vec::new();
    let mut results_vec: Vec<Value> = Vec::new();
    for item in bindings {
        let enabled = item
            .get("enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        if !enabled {
            continue;
        }
        let accel = item
            .get("accelerator")
            .or_else(|| item.get("shortcut"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if accel.is_empty() {
            continue;
        }
        let action = item
            .get("action")
            .or_else(|| item.get("id"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let app_handle = app.clone();
        let action_clone = action.clone();
        let accel_clone = accel.clone();
        if let Err(err) = manager.on_shortcut(accel.as_str(), move |_app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let _ = app_handle.emit(
                    "mineradio-global-hotkey",
                    json!({
                        "action": action_clone,
                        "accelerator": accel_clone,
                    }),
                );
            }
        }) {
            let err_msg = err.to_string();
            errors.push(format!("{accel}: {err_msg}"));
            results_vec.push(json!({
                "action": action,
                "accelerator": accel,
                "ok": false,
                "error": err_msg,
                "conflict": {
                    "sourceName": "系统 / 其他软件",
                    "sourceIcon": "warning",
                    "reason": "该组合键已被占用或被系统保留",
                },
            }));
        } else {
            registered += 1;
            results_vec.push(json!({
                "action": action,
                "accelerator": accel,
                "ok": true,
            }));
        }
    }

    json!({
        "ok": errors.is_empty(),
        "results": results_vec,
        "registered": registered,
        "errors": errors,
    })
}

#[tauri::command]
pub fn get_gpu_diagnostics() -> Value {
    json!({
        "ok": true,
        "runtime": "tauri-webview",
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    })
}

#[tauri::command]
pub fn request_gesture_camera_permission() -> Value {
    json!({
        "ok": true,
        "granted": true,
        "delegatedToWebview": true,
    })
}

#[tauri::command]
pub fn restart_app(app: AppHandle) -> Value {
    app.restart();
}

// ==================== 平台 Webview 登录弹窗（受彩蛋门控保护） ====================

#[derive(Clone, Copy)]
struct PlatformLoginSpec {
    provider: &'static str,
    title: &'static str,
    login_url: &'static str,
    cookie_urls: &'static [&'static str],
}

const NETEASE_LOGIN_SPEC: PlatformLoginSpec = PlatformLoginSpec {
    provider: "netease",
    title: "网易云音乐登录",
    login_url: "https://music.163.com/#/login",
    cookie_urls: &[
        "https://music.163.com/",
        "https://interface.music.163.com/",
        "https://interface3.music.163.com/",
    ],
};

const QQ_LOGIN_SPEC: PlatformLoginSpec = PlatformLoginSpec {
    provider: "qq",
    title: "QQ音乐登录",
    login_url: "https://y.qq.com/",
    cookie_urls: &[
        "https://y.qq.com/",
        "https://u.y.qq.com/",
        "https://c.y.qq.com/",
        "https://graph.qq.com/",
    ],
};

const KUGOU_LOGIN_SPEC: PlatformLoginSpec = PlatformLoginSpec {
    provider: "kugou",
    title: "酷狗音乐登录",
    login_url: "https://www.kugou.com/",
    cookie_urls: &[
        "https://www.kugou.com/",
        "https://m.kugou.com/",
        "https://gateway.kugou.com/",
        "https://login.user.kugou.com/",
    ],
};

const QISHUI_LOGIN_SPEC: PlatformLoginSpec = PlatformLoginSpec {
    provider: "qishui",
    title: "汽水音乐登录",
    login_url: "https://music.douyin.com/",
    cookie_urls: &[
        "https://music.douyin.com/",
        "https://www.douyin.com/",
        "https://api.qishui.com/",
    ],
};

fn platform_spec_by_name(provider: &str) -> Option<PlatformLoginSpec> {
    match provider.trim().to_ascii_lowercase().as_str() {
        "netease" => Some(NETEASE_LOGIN_SPEC),
        "qq" => Some(QQ_LOGIN_SPEC),
        "kugou" => Some(KUGOU_LOGIN_SPEC),
        "qishui" => Some(QISHUI_LOGIN_SPEC),
        _ => None,
    }
}

fn clear_backend_provider_session(backend: &AppBackendState, provider: &str) {
    match provider {
        "netease" => {
            let _ = backend.netease.set_cookie("");
        }
        "qq" => {
            let _ = backend.qq.set_cookie("");
        }
        "kugou" => {
            let _ = backend.kugou.set_cookie("");
        }
        "qishui" => {
            let _ = backend.qishui.logout();
        }
        _ => {}
    }
}

fn clear_webview_cookies_for_urls(win: &tauri::WebviewWindow, urls: &[&str]) {
    for raw in urls {
        if let Ok(parsed) = url::Url::parse(raw) {
            if let Ok(cookies) = win.cookies_for_url(parsed) {
                for c in cookies {
                    let _ = win.delete_cookie(c);
                }
            }
        }
    }
}

fn collect_webview_cookies_map(
    win: &tauri::WebviewWindow,
    urls: &[&str],
) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    for raw in urls {
        if let Ok(parsed) = url::Url::parse(raw) {
            if let Ok(cookies) = win.cookies_for_url(parsed) {
                for c in cookies {
                    let name = c.name().trim().to_string();
                    let val = c.value().trim().to_string();
                    if !name.is_empty() && !val.is_empty() {
                        map.entry(name).or_insert(val);
                    }
                }
            }
        }
    }
    map
}

fn serialize_cookie_map(map: &BTreeMap<String, String>) -> String {
    map.iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("; ")
}

fn cookies_satisfy_provider(provider: &str, map: &BTreeMap<String, String>) -> bool {
    let has_non_empty = |key: &str| map.get(key).is_some_and(|v| !v.trim().is_empty());
    match provider {
        "netease" => has_non_empty("MUSIC_U"),
        "qq" => has_non_empty("qqmusic_key") || has_non_empty("qm_keyst"),
        "kugou" => {
            has_non_empty("token")
                || has_non_empty("Token")
                || has_non_empty("KugooID")
                || has_non_empty("kugouID")
        }
        "qishui" => has_non_empty("sessionid") || has_non_empty("sessionid_ss"),
        _ => false,
    }
}

async fn apply_captured_platform_cookie(
    backend: &AppBackendState,
    provider: &str,
    cookie_header: &str,
) -> Option<Value> {
    match provider {
        "netease" => {
            if backend.netease.set_cookie(cookie_header).is_ok() {
                Some(
                    backend
                        .netease
                        .login_status()
                        .await
                        .unwrap_or_else(|_| json!({ "loggedIn": true })),
                )
            } else {
                None
            }
        }
        "qq" => {
            if backend.qq.set_cookie(cookie_header).is_ok() {
                Some(
                    backend
                        .qq
                        .login_status(true, true)
                        .await
                        .unwrap_or_else(|_| json!({ "provider": "qq", "loggedIn": true })),
                )
            } else {
                None
            }
        }
        "kugou" => {
            if backend.kugou.set_cookie(cookie_header).is_ok() {
                Some(
                    backend
                        .kugou
                        .login_status()
                        .await
                        .unwrap_or_else(|_| json!({ "provider": "kugou", "loggedIn": true })),
                )
            } else {
                None
            }
        }
        "qishui" => {
            if backend.qishui.set_cookie(cookie_header).is_ok() {
                Some(
                    backend
                        .qishui
                        .status()
                        .await
                        .unwrap_or_else(|_| json!({ "provider": "qishui", "loggedIn": true })),
                )
            } else {
                None
            }
        }
        _ => None,
    }
}

async fn open_platform_login_window_impl(
    app: &AppHandle,
    state: &Arc<TauriAppState>,
    spec: PlatformLoginSpec,
    force_reauth: bool,
) -> Value {
    if !state.backend.gate.is_unlocked() {
        return json!({
            "ok": false,
            "error": "LOGIN_EASTER_EGG_LOCKED",
            "message": "登录入口尚未解锁"
        });
    }
    let Ok(parsed) = url::Url::parse(spec.login_url) else {
        return json!({ "ok": false, "error": "INVALID_LOGIN_URL" });
    };

    if force_reauth {
        clear_backend_provider_session(&state.backend, spec.provider);
    }

    let win = if let Some(existing) = app.get_webview_window(PLATFORM_LOGIN_LABEL) {
        if force_reauth {
            clear_webview_cookies_for_urls(&existing, spec.cookie_urls);
        }
        let _ = existing.set_title(spec.title);
        let _ = existing.navigate(parsed.clone());
        let _ = existing.show();
        let _ = existing.set_focus();
        existing
    } else {
        let initial_url = if force_reauth {
            url::Url::parse("about:blank").unwrap_or_else(|_| parsed.clone())
        } else {
            parsed.clone()
        };

        let created = match WebviewWindowBuilder::new(
            app,
            PLATFORM_LOGIN_LABEL,
            WebviewUrl::External(initial_url),
        )
        .title(spec.title)
        .inner_size(980.0, 680.0)
        .center()
        .build()
        {
            Ok(w) => w,
            Err(err) => {
                return json!({ "ok": false, "error": format!("LOGIN_WINDOW_FAILED:{err}") })
            }
        };

        if force_reauth {
            clear_webview_cookies_for_urls(&created, spec.cookie_urls);
            let _ = created.navigate(parsed);
        }
        created
    };

    let _ = &win;

    let seq = state.platform_login_seq.fetch_add(1, Ordering::AcqRel) + 1;
    let app_bg = app.clone();
    let state_bg = state.clone();
    tauri::async_runtime::spawn(async move {
        // 最长轮询 15 分钟
        for _ in 0..1125 {
            tokio::time::sleep(Duration::from_millis(800)).await;
            if state_bg.platform_login_seq.load(Ordering::Acquire) != seq {
                break;
            }
            let Some(login_win) = app_bg.get_webview_window(PLATFORM_LOGIN_LABEL) else {
                break;
            };
            let cookie_map = collect_webview_cookies_map(&login_win, spec.cookie_urls);
            if !cookies_satisfy_provider(spec.provider, &cookie_map) {
                continue;
            }
            let cookie_header = serialize_cookie_map(&cookie_map);
            if cookie_header.is_empty() {
                continue;
            }
            if let Some(status_val) =
                apply_captured_platform_cookie(&state_bg.backend, spec.provider, &cookie_header)
                    .await
            {
                let _ = app_bg.emit(
                    "mineradio-platform-login-success",
                    json!({
                        "provider": spec.provider,
                        "loggedIn": true,
                        "status": status_val,
                    }),
                );
                let _ = login_win.close();
                break;
            }
        }
    });

    json!({ "ok": true, "url": spec.login_url, "provider": spec.provider })
}

#[tauri::command]
pub async fn open_netease_music_login(
    app: AppHandle,
    state: tauri::State<'_, Arc<TauriAppState>>,
    force_reauth: Option<bool>,
) -> Result<Value, String> {
    Ok(open_platform_login_window_impl(
        &app,
        state.inner(),
        NETEASE_LOGIN_SPEC,
        force_reauth.unwrap_or(false),
    )
    .await)
}

#[tauri::command]
pub async fn open_qq_music_login(
    app: AppHandle,
    state: tauri::State<'_, Arc<TauriAppState>>,
    force_reauth: Option<bool>,
) -> Result<Value, String> {
    Ok(open_platform_login_window_impl(
        &app,
        state.inner(),
        QQ_LOGIN_SPEC,
        force_reauth.unwrap_or(false),
    )
    .await)
}

#[tauri::command]
pub async fn open_kugou_music_login(
    app: AppHandle,
    state: tauri::State<'_, Arc<TauriAppState>>,
    force_reauth: Option<bool>,
) -> Result<Value, String> {
    Ok(open_platform_login_window_impl(
        &app,
        state.inner(),
        KUGOU_LOGIN_SPEC,
        force_reauth.unwrap_or(false),
    )
    .await)
}

#[tauri::command]
pub async fn open_qishui_auth_login(
    app: AppHandle,
    state: tauri::State<'_, Arc<TauriAppState>>,
    force_reauth: Option<bool>,
) -> Result<Value, String> {
    Ok(open_platform_login_window_impl(
        &app,
        state.inner(),
        QISHUI_LOGIN_SPEC,
        force_reauth.unwrap_or(false),
    )
    .await)
}

#[tauri::command]
pub async fn clear_platform_login_session(
    app: AppHandle,
    state: tauri::State<'_, Arc<TauriAppState>>,
    provider: String,
) -> Result<Value, String> {
    let normalized = provider.trim().to_ascii_lowercase();
    let specs: Vec<PlatformLoginSpec> = if normalized == "all" {
        vec![
            NETEASE_LOGIN_SPEC,
            QQ_LOGIN_SPEC,
            KUGOU_LOGIN_SPEC,
            QISHUI_LOGIN_SPEC,
        ]
    } else if let Some(spec) = platform_spec_by_name(&normalized) {
        vec![spec]
    } else {
        return Ok(json!({
            "ok": false,
            "error": "UNSUPPORTED_PROVIDER",
            "provider": provider,
        }));
    };

    for spec in &specs {
        clear_backend_provider_session(&state.backend, spec.provider);
        for label in [PLATFORM_LOGIN_LABEL, "main"] {
            if let Some(win) = app.get_webview_window(label) {
                clear_webview_cookies_for_urls(&win, spec.cookie_urls);
            }
        }
    }

    Ok(json!({
        "ok": true,
        "provider": normalized,
        "cleared": specs.iter().map(|s| s.provider).collect::<Vec<_>>(),
    }))
}

#[tauri::command]
pub fn close_platform_login_window(
    app: AppHandle,
    state: tauri::State<'_, Arc<TauriAppState>>,
) -> Value {
    state.platform_login_seq.fetch_add(1, Ordering::AcqRel);
    if let Some(win) = app.get_webview_window(PLATFORM_LOGIN_LABEL) {
        let _ = win.close();
    }
    json!({ "ok": true })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pointer_ignore_and_rect_routing_work() {
        assert!(!compute_pointer_ignore(false, true, &json!({})));
        assert!(!compute_pointer_ignore(true, false, &json!({})));
        assert!(compute_pointer_ignore(
            true,
            true,
            &json!({ "overDesktopControls": false })
        ));
        assert!(!compute_pointer_ignore(
            true,
            true,
            &json!({ "overDesktopControls": true })
        ));

        let rect = json!({ "left": 100.0, "top": 20.0, "right": 300.0, "bottom": 80.0 });
        assert!(point_in_rect_value(&rect, 150.0, 50.0));
        assert!(!point_in_rect_value(&rect, 99.0, 50.0));
        assert!(!point_in_rect_value(&rect, 150.0, 90.0));
    }

    #[test]
    fn normalize_close_behavior_maps_exit_and_quit_uniformly() {
        assert_eq!(normalize_close_behavior("exit"), "quit");
        assert_eq!(normalize_close_behavior("QUIT"), "quit");
        assert_eq!(normalize_close_behavior("tray"), "tray");
        assert_eq!(normalize_close_behavior(""), "tray");
    }

    #[test]
    fn desktop_icons_visible_off_windows_reports_visible_true() {
        #[cfg(not(target_os = "windows"))]
        assert_eq!(win32::set_desktop_icons_visible(false).unwrap(), true);
    }

    #[test]
    fn platform_cookie_detection_and_serialization_work() {
        let mut ne = BTreeMap::new();
        assert!(!cookies_satisfy_provider("netease", &ne));
        ne.insert("MUSIC_U".to_string(), "tok1".to_string());
        ne.insert("__csrf".to_string(), "c1".to_string());
        assert!(cookies_satisfy_provider("netease", &ne));
        assert_eq!(serialize_cookie_map(&ne), "MUSIC_U=tok1; __csrf=c1");

        let mut qq = BTreeMap::new();
        qq.insert("uin".to_string(), "12345".to_string());
        assert!(!cookies_satisfy_provider("qq", &qq));
        qq.insert("qm_keyst".to_string(), "qk1".to_string());
        assert!(cookies_satisfy_provider("qq", &qq));

        let mut kg = BTreeMap::new();
        kg.insert("kg_mid".to_string(), "m1".to_string());
        assert!(!cookies_satisfy_provider("kugou", &kg));
        kg.insert("KugooID".to_string(), "9988".to_string());
        assert!(cookies_satisfy_provider("kugou", &kg));

        let mut qs = BTreeMap::new();
        assert!(!cookies_satisfy_provider("qishui", &qs));
        qs.insert("sessionid".to_string(), "sid_abc".to_string());
        assert!(cookies_satisfy_provider("qishui", &qs));

        assert!(platform_spec_by_name("NetEase").is_some());
        assert!(platform_spec_by_name("unknown").is_none());
    }
}
