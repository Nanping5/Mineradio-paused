pub mod analyzer;
pub mod config;
pub mod cuefield;
pub mod desktop;
pub mod providers;
pub mod server;

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::config::ConfigManager;
use crate::desktop::commands::{self, TauriAppState};
use crate::desktop::wallpaper_engine::WallpaperFileCapability;
use crate::server::{start_local_server, AppBackendState};

fn parse_query_map(query: Option<&str>) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Some(q) = query else {
        return map;
    };
    for pair in q.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            let dk = percent_encoding::percent_decode_str(k)
                .decode_utf8_lossy()
                .into_owned();
            let dv = percent_encoding::percent_decode_str(v)
                .decode_utf8_lossy()
                .into_owned();
            map.insert(dk, dv);
        }
    }
    map
}

fn split_scheme_segments(uri: &tauri::http::Uri) -> Vec<String> {
    let mut segs = Vec::new();
    if let Some(host) = uri.host() {
        let lower = host.to_ascii_lowercase();
        if lower != "localhost" && !lower.ends_with(".localhost") && !lower.is_empty() {
            segs.push(host.to_string());
        }
    }
    for part in uri.path().split('/') {
        if !part.is_empty() {
            let decoded = percent_encoding::percent_decode_str(part)
                .decode_utf8_lossy()
                .into_owned();
            segs.push(decoded);
        }
    }
    segs
}

fn mime_for_wallpaper_path(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
}

fn build_protocol_error(status: u16, msg: &str) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", "*")
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(msg.as_bytes().to_vec())
        .unwrap()
}

const PROTOCOL_FULL_READ_MAX_BYTES: u64 = 8 * 1024 * 1024;
const PROTOCOL_RANGE_CHUNK_MAX_BYTES: u64 = 16 * 1024 * 1024;

fn build_range_file_protocol_response(
    path: &Path,
    mime: &str,
    range_header: Option<&str>,
) -> tauri::http::Response<Vec<u8>> {
    let Ok(mut file) = std::fs::File::open(path) else {
        return build_protocol_error(404, "Not found");
    };
    let Ok(meta) = file.metadata() else {
        return build_protocol_error(404, "Not found");
    };
    let size = meta.len();
    if size == 0 {
        return tauri::http::Response::builder()
            .status(200)
            .header("Access-Control-Allow-Origin", "*")
            .header("Content-Type", mime)
            .header("Accept-Ranges", "bytes")
            .header("Content-Length", "0")
            .body(Vec::new())
            .unwrap();
    }

    if let Some(rh) = range_header.map(str::trim) {
        if rh.len() >= 6 && rh[..6].eq_ignore_ascii_case("bytes=") {
            let spec = &rh[6..];
            let mut parts = spec.split('-');
            let s_str = parts.next().unwrap_or("").trim();
            let e_str = parts.next().unwrap_or("").trim();
            let (start, end) = match (s_str.parse::<u64>(), e_str.parse::<u64>()) {
                (Ok(s), Ok(e)) => (
                    s,
                    e.min(s.saturating_add(PROTOCOL_RANGE_CHUNK_MAX_BYTES - 1))
                        .min(size - 1),
                ),
                (Ok(s), Err(_)) => (
                    s,
                    s.saturating_add(4 * 1024 * 1024 - 1).min(size - 1),
                ),
                (Err(_), Ok(suffix)) if suffix > 0 => {
                    let capped_suffix = suffix.min(PROTOCOL_RANGE_CHUNK_MAX_BYTES);
                    let s = size.saturating_sub(capped_suffix);
                    (s, size - 1)
                }
                _ => (0, size.saturating_sub(1).min(PROTOCOL_FULL_READ_MAX_BYTES - 1)),
            };
            if start >= size || start > end {
                return tauri::http::Response::builder()
                    .status(416)
                    .header("Access-Control-Allow-Origin", "*")
                    .header("Content-Range", format!("bytes */{size}"))
                    .body(Vec::new())
                    .unwrap();
            }
            let len = (end - start + 1) as usize;
            let mut buf = vec![0u8; len];
            if file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut buf).is_err() {
                return build_protocol_error(500, "Read failed");
            }
            return tauri::http::Response::builder()
                .status(206)
                .header("Access-Control-Allow-Origin", "*")
                .header("Content-Type", mime)
                .header("Accept-Ranges", "bytes")
                .header("Content-Range", format!("bytes {start}-{end}/{size}"))
                .header("Content-Length", len.to_string())
                .body(buf)
                .unwrap();
        }
    }

    if size > PROTOCOL_FULL_READ_MAX_BYTES {
        let len = PROTOCOL_FULL_READ_MAX_BYTES as usize;
        let end = PROTOCOL_FULL_READ_MAX_BYTES - 1;
        let mut buf = vec![0u8; len];
        if file.read_exact(&mut buf).is_err() {
            return build_protocol_error(500, "Read failed");
        }
        return tauri::http::Response::builder()
            .status(206)
            .header("Access-Control-Allow-Origin", "*")
            .header("Content-Type", mime)
            .header("Accept-Ranges", "bytes")
            .header("Content-Range", format!("bytes 0-{end}/{size}"))
            .header("Content-Length", len.to_string())
            .body(buf)
            .unwrap();
    }

    let mut buf = Vec::with_capacity(size as usize);
    if file.read_to_end(&mut buf).is_err() {
        return build_protocol_error(500, "Read failed");
    }
    tauri::http::Response::builder()
        .status(200)
        .header("Access-Control-Allow-Origin", "*")
        .header("Content-Type", mime)
        .header("Accept-Ranges", "bytes")
        .header("Content-Length", buf.len().to_string())
        .body(buf)
        .unwrap()
}

fn parse_wallpaper_scheme_request(
    uri: &tauri::http::Uri,
) -> Result<(String, String, String), &'static str> {
    let segs = split_scheme_segments(uri);
    let query = parse_query_map(uri.query());
    let cap = query
        .get("cap")
        .or_else(|| query.get("token"))
        .cloned()
        .unwrap_or_default();

    if segs.len() >= 2 && segs[0] == "media" {
        let id = segs[1].clone();
        let rel_path = query
            .get("path")
            .filter(|s| !s.trim().is_empty())
            .cloned()
            .unwrap_or_else(|| {
                if segs.len() >= 3 {
                    segs[2..].join("/")
                } else {
                    String::new()
                }
            });
        if rel_path.trim().is_empty() {
            return Err("Invalid wallpaper asset path");
        }
        return Ok((id, rel_path, cap));
    }

    if segs.len() < 3 {
        return Err("Invalid wallpaper asset path");
    }
    let (id, rel_slice) = if segs[0] == "project" || segs[0] == "asset" {
        (segs[1].clone(), &segs[2..])
    } else {
        (segs[0].clone(), &segs[1..])
    };
    Ok((id, rel_slice.join("/"), cap))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .register_uri_scheme_protocol("mineradio-local", |ctx, req| {
            let state = ctx.app_handle().state::<Arc<TauriAppState>>();
            let segs = split_scheme_segments(req.uri());
            if segs.len() < 2 {
                return build_protocol_error(400, "Invalid local media path");
            }
            let kind = &segs[0];
            let id = &segs[1];
            let query = parse_query_map(req.uri().query());
            let cap = query
                .get("cap")
                .or_else(|| query.get("token"))
                .map(String::as_str)
                .unwrap_or("");
            let Some((path, mime)) = state.backend.local_library.resolve_media_file(kind, id, cap) else {
                return build_protocol_error(403, "Forbidden");
            };
            let range = req
                .headers()
                .get("range")
                .and_then(|v| v.to_str().ok());
            build_range_file_protocol_response(&path, &mime, range)
        })
        .register_uri_scheme_protocol("mineradio-wallpaper", |ctx, req| {
            let state = ctx.app_handle().state::<Arc<TauriAppState>>();
            let (id, rel_path, cap) = match parse_wallpaper_scheme_request(req.uri()) {
                Ok(parsed) => parsed,
                Err(msg) => return build_protocol_error(400, msg),
            };
            let expected = state.backend.wallpaper_engine.media_token();
            if expected.is_empty() || !crate::desktop::local_library::constant_time_eq(cap.trim(), &expected) {
                return build_protocol_error(403, "Forbidden");
            }
            let Ok(path) = state.backend.wallpaper_engine.resolve_project_file(
                &id,
                &rel_path,
                WallpaperFileCapability::AnySafe,
            ) else {
                return build_protocol_error(404, "Not found");
            };
            let mime = mime_for_wallpaper_path(&path);
            let range = req
                .headers()
                .get("range")
                .and_then(|v| v.to_str().ok());
            build_range_file_protocol_response(&path, mime, range)
        })
        .setup(|app| {
            let config = Arc::new(ConfigManager::discover());
            let backend = AppBackendState::new(config);
            let tauri_state = Arc::new(TauriAppState::new(backend.clone()));

            let port = tauri::async_runtime::block_on(start_local_server(backend))
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            tauri_state.http_port.store(port, Ordering::Release);
            app.manage(tauri_state.clone());

            // 托盘菜单与图标
            let show_item = MenuItemBuilder::with_id("tray_show", "显示主窗口").build(app)?;
            let lyrics_item = MenuItemBuilder::with_id("tray_lyrics", "切换桌面歌词").build(app)?;
            let exit_desktop_item =
                MenuItemBuilder::with_id("tray_exit_desktop_mode", "退出壁纸模式").build(app)?;
            let quit_item = MenuItemBuilder::with_id("tray_quit", "退出 MineradioX").build(app)?;
            let tray_menu = MenuBuilder::new(app)
                .items(&[&show_item, &lyrics_item, &exit_desktop_item, &quit_item])
                .build()?;

            let icon_bytes = include_bytes!("../icons/icon.png");
            if let Ok(tray_icon_img) = tauri::image::Image::from_bytes(icon_bytes) {
                let _tray = TrayIconBuilder::with_id("mineradio-tray")
                    .icon(tray_icon_img)
                    .tooltip("MineradioX｜左键显示窗口；若右键菜单无法弹出，请在窗口内 FX 控制台→系统→退出应用 彻底退出")
                    .menu(&tray_menu)
                    .on_menu_event(|app, event| match event.id().as_ref() {
                        "tray_show" => {
                            if let Some(win) = app.get_webview_window("main") {
                                let _ = win.unminimize();
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                        "tray_lyrics" => {
                            let state = app.state::<Arc<TauriAppState>>();
                            let next = !state.desktop_lyrics_enabled.load(Ordering::Relaxed);
                            let _ = commands::set_desktop_lyrics_enabled(
                                app.clone(),
                                state,
                                next,
                                None,
                            );
                        }
                        "tray_exit_desktop_mode" => {
                            let state = app.state::<Arc<TauriAppState>>();
                            let _ = commands::set_wallpaper_mode(
                                app.clone(),
                                state.clone(),
                                false,
                                None,
                            );
                            if !state.desktop_icons_visible.load(Ordering::Acquire)
                                && crate::desktop::win32::set_desktop_icons_visible(true).is_ok()
                            {
                                state.desktop_icons_visible.store(true, Ordering::Release);
                            }
                            if let Some(win) = app.get_webview_window("main") {
                                let _ = win.unminimize();
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                        "tray_quit" => {
                            let state = app.state::<Arc<TauriAppState>>();
                            commands::cleanup_before_app_exit(app, &state);
                            commands::spawn_exit_watchdog();
                            app.exit(0);
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            if let Some(win) = tray.app_handle().get_webview_window("main") {
                                let _ = win.unminimize();
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    })
                    .build(app)?;
            }

            // 创建主窗口（无边框透明）
            let main_win = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App("index.html".into()),
            )
            .title("MineradioX")
            .inner_size(1280.0, 820.0)
            .min_inner_size(960.0, 620.0)
            .decorations(false)
            .transparent(true)
            .visible(true)
            .focused(true)
            .center()
            .build()?;

            let _ = main_win.show();
            let _ = main_win.set_focus();

            let app_handle = app.handle().clone();
            let state_for_close = tauri_state.clone();
            main_win.on_window_event(move |event| match event {
                WindowEvent::CloseRequested { api, .. } => {
                    let behavior = commands::lock_unpoisoned(&state_for_close.close_behavior).clone();
                    if behavior != "quit" {
                        api.prevent_close();
                        if let Some(win) = app_handle.get_webview_window("main") {
                            let _ = win.hide();
                        }
                    } else {
                        commands::cleanup_before_app_exit(&app_handle, &state_for_close);
                    }
                }
                WindowEvent::Resized(_) => {
                    let _ = app_handle.emit(
                        "desktop-window-state",
                        commands::build_window_state_payload(&app_handle, &state_for_close),
                    );
                }
                _ => {}
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_runtime_endpoints,
            commands::desktop_window_minimize,
            commands::desktop_window_restore,
            commands::desktop_window_toggle_maximize,
            commands::desktop_window_toggle_fullscreen,
            commands::desktop_window_exit_fullscreen_windowed,
            commands::desktop_window_close,
            commands::desktop_window_get_state,
            commands::desktop_window_get_close_behavior,
            commands::desktop_window_set_close_behavior,
            commands::get_login_easter_egg_status,
            commands::unlock_login_easter_egg,
            commands::reset_login_easter_egg,
            commands::list_built_in_playlists,
            commands::read_built_in_playlist,
            commands::create_built_in_playlist,
            commands::rename_built_in_playlist,
            commands::delete_built_in_playlist,
            commands::add_built_in_playlist_track,
            commands::remove_built_in_playlist_track,
            commands::reorder_built_in_playlist_track,
            commands::choose_local_music_files,
            commands::list_local_music_library,
            commands::read_local_music_lyric,
            commands::authorize_local_music,
            commands::import_local_music,
            commands::get_cache_settings,
            commands::set_cache_settings,
            commands::choose_cache_directory,
            commands::read_current_fx_autosave,
            commands::save_current_fx_autosave,
            commands::read_lyric_cache,
            commands::write_lyric_cache,
            commands::get_memory_snapshot,
            commands::trim_app_memory,
            commands::purge_system_memory,
            commands::configure_memory_reduct,
            commands::desktop_lyrics_get_state,
            commands::set_desktop_lyrics_enabled,
            commands::update_desktop_lyrics,
            commands::set_desktop_lyrics_lock_state,
            commands::move_desktop_lyrics_by,
            commands::open_update_page,
            commands::copy_text,
            commands::read_text,
            commands::export_json_file,
            commands::import_json_file,
            commands::list_wallpaper_engine_projects,
            commands::get_wallpaper_engine_project_details,
            commands::open_wallpaper_engine_project_details,
            commands::choose_wallpaper_engine_directory,
            commands::choose_wallpaper_engine_project_file,
            commands::remove_wallpaper_engine_directory,
            commands::get_wallpaper_engine_runtime_status,
            commands::start_wallpaper_engine_scene,
            commands::stop_wallpaper_engine_scene,
            commands::set_wallpaper_mode,
            commands::update_wallpaper_mode,
            commands::get_wallpaper_mode_status,
            commands::set_desktop_software_locked,
            commands::set_desktop_icons_visible,
            commands::request_desktop_keyboard_focus,
            commands::update_desktop_pointer_route,
            commands::update_desktop_icon_shields,
            commands::configure_global_hotkeys,
            commands::get_gpu_diagnostics,
            commands::request_gesture_camera_permission,
            commands::restart_app,
            commands::open_netease_music_login,
            commands::open_qq_music_login,
            commands::open_kugou_music_login,
            commands::open_qishui_auth_login,
            commands::clear_platform_login_session,
            commands::close_platform_login_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MineradioX");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wallpaper_scheme_supports_media_query_and_legacy_project_paths() {
        let media_uri: tauri::http::Uri =
            "mineradio-wallpaper://media/abcdef0123456789abcdef01?path=sub%2Floop%2Emp4&cap=tok123"
                .parse()
                .unwrap();
        let (id, rel, cap) = parse_wallpaper_scheme_request(&media_uri).unwrap();
        assert_eq!(id, "abcdef0123456789abcdef01");
        assert_eq!(rel, "sub/loop.mp4");
        assert_eq!(cap, "tok123");

        let legacy_uri: tauri::http::Uri =
            "mineradio-wallpaper://project/abcdef0123456789abcdef01/assets/preview.png?token=tok456"
                .parse()
                .unwrap();
        let (id2, rel2, cap2) = parse_wallpaper_scheme_request(&legacy_uri).unwrap();
        assert_eq!(id2, "abcdef0123456789abcdef01");
        assert_eq!(rel2, "assets/preview.png");
        assert_eq!(cap2, "tok456");
    }

    #[test]
    fn large_protocol_files_chunk_without_full_memory_read_and_parse_case_insensitive_range() {
        let dir = tempfile::TempDir::new().unwrap();
        let big_path = dir.path().join("big.mp4");
        {
            let f = std::fs::File::create(&big_path).unwrap();
            f.set_len(PROTOCOL_FULL_READ_MAX_BYTES + 1024).unwrap();
        }
        let no_range_resp = build_range_file_protocol_response(&big_path, "video/mp4", None);
        assert_eq!(no_range_resp.status().as_u16(), 206);
        assert_eq!(no_range_resp.body().len() as u64, PROTOCOL_FULL_READ_MAX_BYTES);

        let small_path = dir.path().join("small.txt");
        std::fs::write(&small_path, b"0123456789ABCDEF").unwrap();
        let ci_range_resp =
            build_range_file_protocol_response(&small_path, "text/plain", Some("BYTES=2-5"));
        assert_eq!(ci_range_resp.status().as_u16(), 206);
        assert_eq!(ci_range_resp.body().as_slice(), b"2345");
    }
}
