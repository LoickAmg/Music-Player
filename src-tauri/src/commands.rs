//! Commandes Tauri exposées au frontend (`invoke("...")`). Cette couche
//! ne fait que de la coordination : la vraie logique vit dans les modules
//! `queue`, `library`, `playlists`, `session`, `eq` et `audio`.

use crate::library::{self, Track};
use crate::lyrics::{self, Lyrics};
use crate::playlists::Playlist;
use crate::queue::RepeatMode;
use crate::session::SessionState;
use crate::state::AppState;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
#[cfg(not(target_os = "android"))]
use tauri_plugin_dialog::DialogExt;

#[derive(Debug, Serialize)]
pub struct PlaybackStatus {
    pub current_track: Option<Track>,
    pub position_secs: f64,
    pub is_paused: bool,
    pub volume: f32,
}

#[derive(Debug, Serialize)]
pub struct QueueView {
    pub track_ids: Vec<String>,
    pub position: Option<usize>,
    pub shuffle: bool,
    pub repeat: RepeatMode,
}

fn start_playback(state: &State<AppState>, path: &str) -> Result<(), String> {
    let volume = *state.volume.lock().unwrap();
    state.audio.play(path, volume)
}

fn track_or_stop(state: &State<AppState>, id: Option<String>) -> Result<Option<Track>, String> {
    match id {
        None => {
            state.audio.stop();
            Ok(None)
        }
        Some(id) => {
            let track = state
                .find_track(&id)
                .ok_or("Piste introuvable dans la bibliothèque.")?;
            start_playback(state, &track.path)?;
            // Nouveau morceau lancé : l'ancienne position de reprise ne vaut plus.
            *state.resume_at.lock().unwrap() = 0.0;
            Ok(Some(track))
        }
    }
}

// ---------------------------------------------------------------------
// Bibliothèque
// ---------------------------------------------------------------------

#[tauri::command]
pub async fn pick_library_folder(app: tauri::AppHandle) -> Option<String> {
    // Sur Android, le sélecteur de dossier renvoie des adresses « content:// » qu'on ne
    // peut pas parcourir comme des fichiers : on analyse directement le stockage
    // partagé du téléphone (Musique, Téléchargements…), avec la permission d'accès
    // aux fichiers audio demandée au lancement.
    #[cfg(target_os = "android")]
    {
        let _ = app;
        Some(ANDROID_STORAGE.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        app.dialog().file().pick_folder(move |folder| {
            let _ = tx.send(folder);
        });
        rx.recv().ok().flatten().map(|p| p.to_string())
    }
}

/// Racine du stockage partagé sur Android.
#[cfg(target_os = "android")]
const ANDROID_STORAGE: &str = "/storage/emulated/0";

#[derive(Clone, Serialize)]
struct ScanProgress {
    done: usize,
    total: usize,
}

/// Scanne `root` (hors du fil de l'interface), met à jour la bibliothèque et son cache,
/// et diffuse l'avancement (`scan-progress`) puis le résultat (`library-updated`).
pub fn run_scan(app: &AppHandle, root: &str) -> Result<Vec<Track>, String> {
    let state = app.state::<AppState>();
    if state.scanning.swap(true, Ordering::SeqCst) {
        return Err("Un scan de la bibliothèque est déjà en cours.".to_string());
    }
    let _ = app.emit("scan-progress", ScanProgress { done: 0, total: 0 });
    // Même dossier : les morceaux déjà connus et inchangés ne sont pas relus.
    let previous = if state.library_root.lock().unwrap().as_deref() == Some(root) {
        state.library.lock().unwrap().clone()
    } else {
        Vec::new()
    };
    let tracks = library::scan_library_incremental(Path::new(root), &previous, |done, total| {
        let _ = app.emit("scan-progress", ScanProgress { done, total });
    });
    *state.library.lock().unwrap() = tracks.clone();
    *state.library_root.lock().unwrap() = Some(root.to_string());
    let _ = library::save_cache(&state.library_cache_path(), root, &tracks);
    state.scanning.store(false, Ordering::SeqCst);
    let _ = app.emit("library-updated", &tracks);
    Ok(tracks)
}

#[tauri::command(async)]
pub fn scan_library(app: AppHandle, root: String) -> Result<Vec<Track>, String> {
    run_scan(&app, &root)
}

/// Ouvre un fichier audio donné par le système (« Ouvrir avec Music Player ») : lu tout de
/// suite, et ajouté à la bibliothèque s'il n'y était pas encore.
#[tauri::command(async)]
pub fn open_audio_file(app: AppHandle, path: String) -> Result<Option<Track>, String> {
    let state = app.state::<AppState>();
    let track = match state
        .library
        .lock()
        .unwrap()
        .iter()
        .find(|t| t.path == path)
        .cloned()
    {
        Some(track) => track,
        None => {
            let track = library::read_track(Path::new(&path))
                .ok_or("Ce fichier n'est pas un fichier audio lisible.")?;
            let tracks = {
                let mut library = state.library.lock().unwrap();
                library.push(track.clone());
                library.clone()
            };
            if let Some(root) = state.library_root.lock().unwrap().clone() {
                let _ = library::save_cache(&state.library_cache_path(), &root, &tracks);
            }
            let _ = app.emit("library-updated", &tracks);
            track
        }
    };
    {
        let mut queue = state.queue.lock().unwrap();
        queue.set_items(vec![track.id.clone()], Some(&track.id));
    }
    track_or_stop(&state, Some(track.id))
}

#[tauri::command]
pub fn get_library(state: State<AppState>) -> Vec<Track> {
    state.library.lock().unwrap().clone()
}

/// Chemin d'un fichier image de pochette (extrait dans le cache), ou `None`.
#[tauri::command(async)]
pub fn get_cover(
    state: State<'_, AppState>,
    path: String,
    track_id: String,
) -> Result<Option<String>, String> {
    Ok(
        library::cover_file(Path::new(&path), &track_id, &state.covers_dir())
            .map(|p| p.to_string_lossy().to_string()),
    )
}

#[tauri::command(async)]
pub fn get_lyrics(
    state: State<'_, AppState>,
    track_id: String,
    allow_online: bool,
    refresh: Option<bool>,
) -> Result<Option<Lyrics>, String> {
    let track = state
        .find_track(&track_id)
        .ok_or("Piste introuvable dans la bibliothèque.")?;
    lyrics::lyrics_for(
        &track,
        &state.lyrics_dir(),
        allow_online,
        refresh.unwrap_or(false),
    )
}

/// Texte proposé d'office dans la recherche manuelle de paroles.
#[tauri::command]
pub fn lyrics_query(state: State<'_, AppState>, track_id: String) -> Result<String, String> {
    let track = state
        .find_track(&track_id)
        .ok_or("Piste introuvable dans la bibliothèque.")?;
    Ok(lyrics::default_query(&track))
}

#[tauri::command(async)]
pub fn search_lyrics(
    state: State<'_, AppState>,
    track_id: String,
    query: String,
) -> Result<Vec<lyrics::LyricsCandidate>, String> {
    let duration = state
        .find_track(&track_id)
        .map(|t| t.duration_secs)
        .unwrap_or(0.0);
    lyrics::search_candidates(&query, duration)
}

#[tauri::command(async)]
pub fn choose_lyrics(
    state: State<'_, AppState>,
    track_id: String,
    lyrics_id: u64,
) -> Result<Lyrics, String> {
    let track = state
        .find_track(&track_id)
        .ok_or("Piste introuvable dans la bibliothèque.")?;
    lyrics::choose(&track, &state.lyrics_dir(), lyrics_id)
}

#[tauri::command]
pub fn dismiss_lyrics(state: State<'_, AppState>, track_id: String) -> Result<(), String> {
    let track = state
        .find_track(&track_id)
        .ok_or("Piste introuvable dans la bibliothèque.")?;
    lyrics::dismiss(&track, &state.lyrics_dir());
    Ok(())
}

// ---------------------------------------------------------------------
// Lecture / file d'attente
// ---------------------------------------------------------------------

#[tauri::command(async)]
pub fn play_queue(
    state: State<'_, AppState>,
    track_ids: Vec<String>,
    start_id: Option<String>,
) -> Result<Option<Track>, String> {
    {
        let mut queue = state.queue.lock().unwrap();
        queue.set_items(track_ids, start_id.as_deref());
    }
    let current = state.queue.lock().unwrap().current().cloned();
    track_or_stop(&state, current)
}

#[tauri::command(async)]
pub fn play_track_now(
    state: State<'_, AppState>,
    track_id: String,
) -> Result<Option<Track>, String> {
    let already_queued = {
        let mut queue = state.queue.lock().unwrap();
        queue.jump_to(&track_id)
    };
    if !already_queued {
        let mut queue = state.queue.lock().unwrap();
        queue.set_items(vec![track_id.clone()], Some(&track_id));
    }
    track_or_stop(&state, Some(track_id))
}

#[tauri::command(async)]
pub fn toggle_play_pause(state: State<'_, AppState>) -> Result<bool, String> {
    let status = state.audio.status();
    if status.current_path.is_none() {
        // Réouverture de l'appli : le dernier morceau est affiché mais pas encore chargé.
        // « Lecture » le charge et reprend là où l'écoute s'était arrêtée.
        let current = state.queue.lock().unwrap().current().cloned();
        let track = current
            .and_then(|id| state.find_track(&id))
            .ok_or("Aucune piste chargée.")?;
        start_playback(&state, &track.path)?;
        let resume_at = std::mem::take(&mut *state.resume_at.lock().unwrap());
        if resume_at > 1.0 && resume_at < track.duration_secs - 1.0 {
            state.audio.seek(Duration::from_secs_f64(resume_at));
        }
        return Ok(false);
    }
    if status.is_paused {
        state.audio.resume();
        Ok(false)
    } else {
        state.audio.pause();
        Ok(true)
    }
}

#[tauri::command(async)]
pub fn next_track(state: State<'_, AppState>) -> Result<Option<Track>, String> {
    let next_id = state.queue.lock().unwrap().skip().cloned();
    track_or_stop(&state, next_id)
}

#[tauri::command(async)]
pub fn previous_track(state: State<'_, AppState>) -> Result<Option<Track>, String> {
    let prev_id = state.queue.lock().unwrap().previous().cloned();
    track_or_stop(&state, prev_id)
}

#[tauri::command]
pub fn seek(state: State<AppState>, position_secs: f64) -> Result<(), String> {
    if state.audio.status().current_path.is_none() {
        // Rien de chargé (réouverture) : la lecture démarrera à cette position.
        *state.resume_at.lock().unwrap() = position_secs.max(0.0);
        return Ok(());
    }
    state
        .audio
        .seek(Duration::from_secs_f64(position_secs.max(0.0)));
    Ok(())
}

#[tauri::command]
pub fn set_volume(state: State<AppState>, volume: f32) -> Result<(), String> {
    let volume = volume.clamp(0.0, 1.0);
    *state.volume.lock().unwrap() = volume;
    state.audio.set_volume(volume);
    Ok(())
}

#[tauri::command]
pub fn set_shuffle(state: State<AppState>, on: bool) -> Result<(), String> {
    state.queue.lock().unwrap().set_shuffle(on);
    Ok(())
}

#[tauri::command]
pub fn set_repeat(state: State<AppState>, mode: RepeatMode) -> Result<(), String> {
    state.queue.lock().unwrap().set_repeat(mode);
    Ok(())
}

#[tauri::command]
pub fn remove_from_queue(state: State<AppState>, index: usize) -> Result<(), String> {
    state.queue.lock().unwrap().remove_at(index);
    Ok(())
}

#[tauri::command]
pub fn get_queue(state: State<AppState>) -> QueueView {
    let queue = state.queue.lock().unwrap();
    QueueView {
        track_ids: queue.playback_order().to_vec(),
        position: queue.position(),
        shuffle: queue.shuffle_enabled(),
        repeat: queue.repeat(),
    }
}

#[tauri::command]
pub fn get_playback_status(state: State<AppState>) -> PlaybackStatus {
    let status = state.audio.status();
    let current_id = state.queue.lock().unwrap().current().cloned();
    let current_track = current_id.and_then(|id| state.find_track(&id));
    PlaybackStatus {
        current_track,
        position_secs: status.position_now(),
        // Aucune piste chargée (démarrage, fin de file) = rien ne joue.
        is_paused: status.is_paused || status.current_path.is_none(),
        volume: *state.volume.lock().unwrap(),
    }
}

/// À appeler périodiquement par le frontend (ex : toutes les secondes) :
/// détecte la fin de piste côté rodio et avance automatiquement à la
/// suivante selon la file/le mode de répétition. Retourne la nouvelle
/// piste si elle a changé, `None` si rien n'a changé ou si la file est
/// terminée.
#[tauri::command(async)]
pub fn poll_auto_advance(state: State<'_, AppState>) -> Result<Option<Track>, String> {
    auto_advance(&state).transpose().map(Option::flatten)
}

/// Évite qu'un morceau terminé soit enchaîné deux fois (fil de fond et interface).
static ADVANCE: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Enchaîne le morceau suivant quand le précédent est terminé : `None` si rien n'a changé,
/// sinon la nouvelle piste (ou `None` en fin de file). Appelé par un fil Rust, car les
/// minuteurs JavaScript sont ralentis, voire suspendus, écran éteint sur Android.
pub fn auto_advance(state: &State<AppState>) -> Option<Result<Option<Track>, String>> {
    let _guard = ADVANCE.lock().unwrap_or_else(|e| e.into_inner());
    if !state.audio.status().finished {
        return None;
    }
    state.audio.clear_finished();
    let next_id = state.queue.lock().unwrap().next().cloned();
    Some(track_or_stop(state, next_id))
}

// ---------------------------------------------------------------------
// Playlists
// ---------------------------------------------------------------------

#[tauri::command]
pub fn list_playlists(state: State<AppState>) -> Vec<Playlist> {
    state.playlists.lock().unwrap().playlists.clone()
}

#[tauri::command]
pub fn create_playlist(state: State<AppState>, name: String, theme: Option<String>) -> String {
    let mut store = state.playlists.lock().unwrap();
    let id = store.create(name, theme);
    let _ = store.save(&state.playlists_path());
    id
}

#[tauri::command]
pub fn delete_playlist(state: State<AppState>, id: String) -> Result<(), String> {
    let mut store = state.playlists.lock().unwrap();
    store.delete(&id);
    store
        .save(&state.playlists_path())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_playlist(state: State<AppState>, id: String, name: String) -> Result<(), String> {
    let mut store = state.playlists.lock().unwrap();
    store
        .rename(&id, name)
        .map_err(|_| "Playlist introuvable.".to_string())?;
    store
        .save(&state.playlists_path())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_playlist_theme(state: State<AppState>, id: String, theme: String) -> Result<(), String> {
    let mut store = state.playlists.lock().unwrap();
    store
        .set_theme(&id, theme)
        .map_err(|_| "Playlist introuvable.".to_string())?;
    store
        .save(&state.playlists_path())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_to_playlist(
    state: State<AppState>,
    playlist_id: String,
    track_id: String,
) -> Result<(), String> {
    let mut store = state.playlists.lock().unwrap();
    store
        .add_track(&playlist_id, track_id)
        .map_err(|_| "Playlist introuvable.".to_string())?;
    store
        .save(&state.playlists_path())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_tracks_to_playlist(
    state: State<AppState>,
    playlist_id: String,
    track_ids: Vec<String>,
) -> Result<usize, String> {
    let mut store = state.playlists.lock().unwrap();
    let added = store
        .add_tracks(&playlist_id, track_ids)
        .map_err(|_| "Playlist introuvable.".to_string())?;
    store
        .save(&state.playlists_path())
        .map_err(|e| e.to_string())?;
    Ok(added)
}

#[tauri::command]
pub fn remove_from_playlist(
    state: State<AppState>,
    playlist_id: String,
    track_id: String,
) -> Result<(), String> {
    let mut store = state.playlists.lock().unwrap();
    store
        .remove_track(&playlist_id, &track_id)
        .map_err(|_| "Playlist introuvable.".to_string())?;
    store
        .save(&state.playlists_path())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn move_track_in_playlist(
    state: State<AppState>,
    playlist_id: String,
    from: usize,
    to: usize,
) -> Result<(), String> {
    let mut store = state.playlists.lock().unwrap();
    store
        .move_track(&playlist_id, from, to)
        .map_err(|_| "Playlist introuvable.".to_string())?;
    store
        .save(&state.playlists_path())
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------
// Égaliseur
// ---------------------------------------------------------------------

#[tauri::command]
pub fn set_eq_gains(state: State<AppState>, gains: [f32; 3]) -> Result<(), String> {
    let clamped = gains.map(|g| g.clamp(-12.0, 12.0));
    *state.eq_gains.lock().unwrap() = clamped;
    Ok(())
}

#[tauri::command]
pub fn get_eq_gains(state: State<AppState>) -> [f32; 3] {
    *state.eq_gains.lock().unwrap()
}

// ---------------------------------------------------------------------
// Session (persistance entre lancements)
// ---------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct InitialState {
    pub library_root: Option<String>,
    pub library: Vec<Track>,
    pub queue: QueueView,
    pub current_track: Option<Track>,
    pub position_secs: f64,
    pub volume: f32,
    pub eq_gains: [f32; 3],
    pub playlists: Vec<Playlist>,
    /// Un scan tourne en arrière-plan : la bibliothèque affichée vient du cache.
    pub scanning: bool,
}

#[tauri::command]
pub fn get_initial_state(state: State<AppState>) -> InitialState {
    let library = state.library.lock().unwrap().clone();
    let queue = state.queue.lock().unwrap();
    let current_id = queue.current().cloned();
    InitialState {
        library_root: state.library_root.lock().unwrap().clone(),
        library,
        queue: QueueView {
            track_ids: queue.playback_order().to_vec(),
            position: queue.position(),
            shuffle: queue.shuffle_enabled(),
            repeat: queue.repeat(),
        },
        current_track: current_id.and_then(|id| state.find_track(&id)),
        // La lecture n'est pas relancée automatiquement au démarrage ; l'interface affiche
        // la position où elle reprendra.
        position_secs: *state.resume_at.lock().unwrap(),
        volume: *state.volume.lock().unwrap(),
        eq_gains: *state.eq_gains.lock().unwrap(),
        playlists: state.playlists.lock().unwrap().playlists.clone(),
        scanning: state.scanning.load(Ordering::SeqCst),
    }
}

#[tauri::command]
pub fn save_session(state: State<AppState>) -> Result<(), String> {
    persist_session(&state).map_err(|e| e.to_string())
}

pub fn persist_session(state: &State<AppState>) -> std::io::Result<()> {
    let queue = state.queue.lock().unwrap();
    let status = state.audio.status();
    // Morceau pas encore relancé depuis l'ouverture : on garde la position de reprise
    // (sinon la sauvegarde automatique l'écrasait par 0).
    let position_secs = if status.current_path.is_some() {
        status.position_secs
    } else {
        *state.resume_at.lock().unwrap()
    };

    let session = SessionState {
        library_root: state.library_root.lock().unwrap().clone(),
        queue: queue.playback_order().to_vec(),
        current_track_id: queue.current().cloned(),
        position_secs,
        volume: *state.volume.lock().unwrap(),
        shuffle: queue.shuffle_enabled(),
        repeat: queue.repeat(),
        eq_gains: *state.eq_gains.lock().unwrap(),
    };
    session.save(&state.session_path())
}

/// Reconstruit l'état applicatif au démarrage à partir de `session.json`, `playlists.json`
/// et du cache `library.json` (affichage instantané, sans attendre un scan complet).
/// Retourne le dossier de la bibliothèque, à rescanner ensuite en arrière-plan.
pub fn restore_state(state: &AppState, data_dir: &Path) -> Option<String> {
    let playlists =
        crate::playlists::PlaylistStore::load(&PathBuf::from(data_dir).join("playlists.json"));
    *state.playlists.lock().unwrap() = playlists;

    let session = SessionState::load(&PathBuf::from(data_dir).join("session.json"));
    *state.volume.lock().unwrap() = session.volume;
    *state.eq_gains.lock().unwrap() = session.eq_gains;

    if let Some(root) = &session.library_root {
        let cached = library::load_cache(&state.library_cache_path(), root).unwrap_or_default();
        *state.library.lock().unwrap() = cached;
        *state.library_root.lock().unwrap() = Some(root.clone());
    }

    let mut queue = state.queue.lock().unwrap();
    if !session.queue.is_empty() {
        queue.set_items(session.queue, session.current_track_id.as_deref());
        *state.resume_at.lock().unwrap() = session.position_secs.max(0.0);
        // Remarque : si le shuffle était actif à la fermeture, l'ordre exact
        // n'est pas restauré tel quel (on retire un nouveau tirage aléatoire
        // plutôt que l'ordre sauvegardé) — simplification volontaire, sans
        // impact fonctionnel puisque le shuffle reste actif.
        queue.set_shuffle(session.shuffle);
        queue.set_repeat(session.repeat);
    }
    session.library_root
}
