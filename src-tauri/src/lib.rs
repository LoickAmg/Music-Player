pub mod audio;
pub mod commands;
pub mod eq;
pub mod ffmpeg;
pub mod library;
pub mod lyrics;
pub mod playlists;
pub mod queue;
pub mod session;
pub mod state;

use state::AppState;
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("music-player"));
            std::fs::create_dir_all(&data_dir).ok();

            let state = AppState::new(data_dir.clone());
            let library_root = commands::restore_state(&state, &data_dir);
            app.manage(state);

            // La bibliothèque s'affiche aussitôt depuis le cache ; le rescan (nouveaux
            // fichiers, étiquettes modifiées) se fait en arrière-plan.
            if let Some(root) = library_root {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let _ = commands::run_scan(&handle, &root);
                });
            }

            // Enchaînement des morceaux côté Rust : continue écran éteint (Android), quand
            // l'interface est en veille. L'interface est prévenue par un événement.
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_millis(300));
                let state = handle.state::<AppState>();
                match commands::auto_advance(&state) {
                    Some(Ok(track)) => {
                        let _ = handle.emit("track-changed", track);
                    }
                    Some(Err(e)) => {
                        let _ = handle.emit("playback-error", e);
                    }
                    None => {}
                }
            });

            // Sauvegarde la session quand la fenêtre principale se ferme,
            // pour retrouver piste/position/volume/EQ au prochain lancement.
            if let Some(window) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { .. } = event {
                        let state = app_handle.state::<AppState>();
                        let state_ref: tauri::State<AppState> = state;
                        let _ = commands::persist_session(&state_ref);
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::pick_library_folder,
            commands::scan_library,
            commands::get_library,
            commands::get_cover,
            commands::get_lyrics,
            commands::play_queue,
            commands::play_track_now,
            commands::toggle_play_pause,
            commands::next_track,
            commands::previous_track,
            commands::seek,
            commands::set_volume,
            commands::set_shuffle,
            commands::set_repeat,
            commands::remove_from_queue,
            commands::get_queue,
            commands::get_playback_status,
            commands::poll_auto_advance,
            commands::list_playlists,
            commands::create_playlist,
            commands::delete_playlist,
            commands::rename_playlist,
            commands::set_playlist_theme,
            commands::add_to_playlist,
            commands::remove_from_playlist,
            commands::move_track_in_playlist,
            commands::set_eq_gains,
            commands::get_eq_gains,
            commands::get_initial_state,
            commands::save_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
