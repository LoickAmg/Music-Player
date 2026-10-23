pub mod appearance;
pub mod audio;
pub mod commands;
pub mod eq;
pub mod favorites;
pub mod ffmpeg;
pub mod library;
pub mod listening;
pub mod lyrics;
pub mod playlists;
pub mod queue;
pub mod session;
pub mod sharing;
pub mod shortcut_icon;
pub mod state;
pub mod updater;

use state::AppState;
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init());
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
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
            // Écoute laissée en cours à la dernière fermeture : enregistrée maintenant.
            listening::recover_pending(&data_dir);
            let mut tracker = listening::Tracker::default();
            let mut ticks: u32 = 0;
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_millis(300));
                let state = handle.state::<AppState>();
                // Journal d'écoute (rétrospective du mois et de l'année) : temps réellement écouté.
                {
                    let status = state.audio.status();
                    let playing = status.current_path.is_some() && !status.is_paused && !status.finished;
                    let current = state.queue.lock().unwrap().current().cloned().and_then(|id| state.find_track(&id));
                    let shown = if status.current_path.is_some() { current.as_ref() } else { None };
                    if let Some(done) = tracker.tick(shown, playing) {
                        let _ = listening::record(&state.data_dir, &done);
                        listening::save_pending(&state.data_dir, None);
                    }
                    ticks = ticks.wrapping_add(1);
                    if ticks.is_multiple_of(50) && playing {
                        listening::save_pending(&state.data_dir, tracker.current());
                    }
                }
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
            commands::open_audio_file,
            commands::get_cover,
            commands::get_lyrics,
            commands::upgrade_lyrics,
            commands::lyrics_query,
            commands::search_lyrics,
            commands::choose_lyrics,
            commands::dismiss_lyrics,
            commands::play_queue,
            commands::play_track_now,
            commands::toggle_play_pause,
            commands::next_track,
            commands::previous_track,
            commands::seek,
            commands::set_volume,
            commands::set_shuffle,
            commands::set_repeat,
            commands::sync_app_icon,
            commands::get_listens,
            commands::save_image,
            commands::queue_play_next,
            commands::queue_append,
            commands::remove_from_queue,
            commands::get_queue,
            commands::get_playback_status,
            commands::poll_auto_advance,
            commands::list_playlists,
            commands::create_playlist,
            commands::delete_playlist,
            commands::rename_playlist,
            commands::set_playlist_theme,
            commands::set_playlist_style,
            commands::set_appearance,
            commands::import_asset,
            commands::delete_asset,
            commands::add_to_playlist,
            commands::add_tracks_to_playlist,
            commands::remove_from_playlist,
            commands::move_track_in_playlist,
            commands::set_eq_gains,
            commands::get_eq_gains,
            commands::get_initial_state,
            commands::save_session,
            commands::toggle_favorite,
            commands::list_favorites,
            commands::export_track,
            commands::export_playlist,
            commands::pick_share_file,
            commands::import_share_bundle,
            updater::check_update,
            updater::install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
