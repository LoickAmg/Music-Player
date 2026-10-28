//! Commandes Tauri exposées au frontend (`invoke("...")`). Cette couche
//! ne fait que de la coordination : la vraie logique vit dans les modules
//! `queue`, `library`, `playlists`, `session`, `eq` et `audio`.

use crate::library::{self, Track};
use crate::lyrics::{self, Lyrics};
use crate::playlists::Playlist;
use crate::queue::RepeatMode;
use crate::session::SessionState;
use crate::sharing::{self, ImportResult};
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
    // Morceaux reçus par partage : hors du dossier de musique, mais dans la bibliothèque.
    let extras = [crate::sharing::imports_dir(&state.data_dir)];
    let tracks = library::scan_library_with_extras(Path::new(root), &extras, &previous, |done, total| {
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
/// suite, et ajouté à la bibliothèque s'il n'y était pas encore. Les archives de partage
/// (`.mpshare`) passent par `import_share_bundle` à la place (voir `App.vue::openFile`,
/// qui distingue les deux selon l'extension avant d'appeler l'une ou l'autre).
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
        || {
            // Doublons du morceau dans la bibliothèque (même chanson, autre fichier).
            let Some(key) = lyrics::song_key(&track) else {
                return Vec::new();
            };
            state
                .library
                .lock()
                .unwrap()
                .iter()
                .filter(|t| {
                    t.id != track.id && lyrics::song_key(t).as_deref() == Some(key.as_str())
                })
                .cloned()
                .collect()
        },
    )
}

/// Passe automatique d'amélioration : version synchronisée recherchée en arrière-plan quand
/// les paroles affichées n'ont pas de minutage (voir `lyrics::upgrade_to_synced`).
#[tauri::command(async)]
pub fn upgrade_lyrics(
    state: State<'_, AppState>,
    track_id: String,
    force: Option<bool>,
) -> Result<lyrics::Upgrade, String> {
    let track = state
        .find_track(&track_id)
        .ok_or("Piste introuvable dans la bibliothèque.")?;
    Ok(lyrics::upgrade_to_synced(
        &track,
        &state.lyrics_dir(),
        force.unwrap_or(false),
    ))
}

/// Une seule synchronisation automatique ou installation du modèle à la fois : c'est un calcul
/// lourd (tous les cœurs du processeur), inutile d'en lancer deux.
static ALIGN_BUSY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

struct AlignGuard;
impl AlignGuard {
    fn take() -> Result<Self, String> {
        if ALIGN_BUSY.swap(true, Ordering::SeqCst) {
            return Err("Une synchronisation est déjà en cours.".into());
        }
        crate::align::reset_cancel();
        Ok(Self)
    }
}
impl Drop for AlignGuard {
    fn drop(&mut self) {
        ALIGN_BUSY.store(false, Ordering::SeqCst);
    }
}

/// Arrête la synchronisation en cours (le morceau affiché a changé).
#[tauri::command]
pub fn cancel_align() {
    if ALIGN_BUSY.load(Ordering::SeqCst) {
        crate::align::cancel();
    }
}

#[derive(Serialize)]
pub struct AlignModelStatus {
    pub installed: bool,
    /// Taille du téléchargement (octets).
    pub bytes: u64,
}

#[tauri::command]
pub fn alignment_model_status(state: State<'_, AppState>) -> AlignModelStatus {
    AlignModelStatus {
        installed: crate::align::installed(&state.data_dir),
        bytes: crate::align::MODEL_BYTES,
    }
}

#[derive(Clone, Serialize)]
struct Progress {
    done: u64,
    total: u64,
}

/// Télécharge le modèle de synchronisation (une fois), avec l'avancement en événements
/// « align-model-progress ».
#[tauri::command(async)]
pub fn install_alignment_model(app: AppHandle) -> Result<(), String> {
    let _busy = AlignGuard::take()?;
    let data_dir = app.state::<AppState>().data_dir.clone();
    let mut last = 0u64;
    crate::align::install(&data_dir, |done, total| {
        // Un événement par Mo environ : pas de quoi saturer l'interface.
        if done - last >= 1_000_000 || done == total {
            last = done;
            let _ = app.emit("align-model-progress", Progress { done, total });
        }
    })
}

#[tauri::command]
pub fn remove_alignment_model(state: State<'_, AppState>) {
    crate::align::remove(&state.data_dir);
}

#[derive(Clone, Serialize)]
struct AlignProgress {
    track_id: String,
    fraction: f32,
}

/// Synchronise automatiquement les paroles sans minutage du morceau (reconnaissance vocale
/// locale) ; renvoie les paroles synchronisées, ou `None` s'il n'y a rien à synchroniser.
/// Avancement en événements « align-progress ».
#[tauri::command(async)]
pub fn align_lyrics(app: AppHandle, track_id: String) -> Result<Option<Lyrics>, String> {
    let state = app.state::<AppState>();
    let track = state
        .find_track(&track_id)
        .ok_or("Piste introuvable dans la bibliothèque.")?;
    let Some(text) = lyrics::unsynced_text(&track, &state.lyrics_dir()) else {
        return Ok(None);
    };
    let _busy = AlignGuard::take()?;
    let plain = text.plain.clone().unwrap_or_default();
    let mut last = -1.0f32;
    let lines = crate::align::synchronize(
        &state.data_dir,
        Path::new(&track.path),
        track.duration_secs,
        &plain,
        |fraction| {
            if fraction - last >= 0.02 || fraction >= 1.0 {
                last = fraction;
                let _ = app.emit("align-progress", AlignProgress { track_id: track_id.clone(), fraction });
            }
        },
    )?;
    Ok(Some(lyrics::store_aligned(&track, &state.lyrics_dir(), text, lines)))
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

/// Journal d'écoute complet (rétrospective du mois et de l'année, calculée par l'interface,
/// qui connaît l'heure locale). Y compris l'écoute en cours si elle compte déjà.
#[tauri::command(async)]
pub fn get_listens(state: State<'_, AppState>) -> Vec<crate::listening::Listen> {
    crate::listening::load_all(&state.data_dir)
}

/// Enregistre une image (carte de la rétrospective) dans « Images/Music Player » et renvoie
/// son chemin. Le nom est réduit à des caractères sûrs ; un nom déjà pris reçoit un numéro.
#[tauri::command(async)]
pub fn save_image(app: AppHandle, png: String, name: String) -> Result<String, String> {
    let bytes = crate::appearance::decode_base64(&png)?;
    if !bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Err("Image invalide.".into());
    }
    let dir = app
        .path()
        .picture_dir()
        .map_err(|_| "Dossier Images introuvable sur cet appareil.".to_string())?
        .join("Music Player");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem: String = name
        .trim_end_matches(".png")
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == ' ' { c } else { '-' })
        .collect::<String>()
        .trim()
        .chars()
        .take(60)
        .collect();
    let stem = if stem.is_empty() { "retrospective".to_string() } else { stem };
    let mut path = dir.join(format!("{stem}.png"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{stem} ({n}).png"));
        n += 1;
    }
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

/// Icône de l'appli sur les raccourcis Windows (menu Démarrer, Bureau, barre des tâches).
/// `png` (base64) absent : icône d'origine. Renvoie le nombre de raccourcis mis à jour, ou
/// rien si c'était déjà fait.
#[tauri::command(async)]
pub fn sync_app_icon(state: State<'_, AppState>, png: Option<String>, force: Option<bool>) -> Result<Option<usize>, String> {
    let bytes = png.as_deref().map(crate::appearance::decode_base64).transpose()?;
    crate::shortcut_icon::sync(bytes.as_deref(), &state.app_icon_dir(), force.unwrap_or(false))
}

/// « Lire ensuite » : ces pistes passent juste après celle en cours. Si rien n'était prévu,
/// la lecture démarre sur la première (et la piste lancée est renvoyée).
#[tauri::command(async)]
pub fn queue_play_next(state: State<'_, AppState>, track_ids: Vec<String>) -> Result<Option<Track>, String> {
    let started = state.queue.lock().unwrap().play_next(&track_ids);
    start_if_needed(&state, started)
}

/// « Ajouter à la file d'attente » : à la fin de ce qui est prévu.
#[tauri::command(async)]
pub fn queue_append(state: State<'_, AppState>, track_ids: Vec<String>) -> Result<Option<Track>, String> {
    let started = state.queue.lock().unwrap().enqueue(&track_ids);
    start_if_needed(&state, started)
}

fn start_if_needed(state: &State<'_, AppState>, started: bool) -> Result<Option<Track>, String> {
    if !started {
        return Ok(None);
    }
    let current = state.queue.lock().unwrap().current().cloned();
    track_or_stop(state, current)
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
pub fn set_playlist_style(
    state: State<AppState>,
    id: String,
    style: Option<serde_json::Value>,
) -> Result<(), String> {
    let mut store = state.playlists.lock().unwrap();
    store
        .set_style(&id, style)
        .map_err(|_| "Playlist introuvable.".to_string())?;
    store
        .save(&state.playlists_path())
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------
// Personnalisation
// ---------------------------------------------------------------------

#[tauri::command]
pub fn set_appearance(state: State<AppState>, value: serde_json::Value) -> Result<(), String> {
    crate::appearance::save(&state.data_dir, &value).map_err(|e| e.to_string())
}

/// Fichier importé (police, image). Ordinateur : octets envoyés tels quels, en-têtes `x-kind`
/// (« font » ou « image ») et `x-ext` (extension). Android : la vue web n'y transmet pas
/// d'octets bruts, le fichier arrive en JSON `{ kind, ext, data }` (data en base64).
/// Renvoie le nom donné au fichier.
#[tauri::command(async)]
pub fn import_asset(
    state: State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => {
            let header = |name: &str| {
                request
                    .headers()
                    .get(name)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string()
            };
            crate::appearance::import(&state.data_dir, &header("x-kind"), &header("x-ext"), bytes)
        }
        tauri::ipc::InvokeBody::Json(value) => {
            let field = |name: &str| value.get(name).and_then(|v| v.as_str()).unwrap_or("");
            let bytes = crate::appearance::decode_base64(field("data"))?;
            crate::appearance::import(&state.data_dir, field("kind"), field("ext"), &bytes)
        }
    }
}

#[tauri::command]
pub fn delete_asset(state: State<AppState>, name: String) -> Result<(), String> {
    crate::appearance::remove(&state.data_dir, &name)
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
// Favoris
// ---------------------------------------------------------------------

/// Inverse l'état « aimé » d'un morceau ; renvoie le nouvel état.
#[tauri::command]
pub fn toggle_favorite(state: State<AppState>, track_id: String) -> Result<bool, String> {
    let mut store = state.favorites.lock().unwrap();
    let now = store.toggle(&track_id);
    store
        .save(&state.favorites_path())
        .map_err(|e| e.to_string())?;
    Ok(now)
}

/// Visualiseur : spectre du son joué à l'instant (32 bandes, 0 à 255 ; vide en pause).
#[tauri::command]
pub fn get_spectrum() -> Vec<u8> {
    crate::spectrum::bands()
}

/// Fichier audio reçu au lancement (« Ouvrir avec Music Player ») ; une seule fois.
#[tauri::command]
pub fn take_opened_file() -> Option<String> {
    crate::default_app::take_pending()
}

/// Windows : inscrit l'appli comme lecteur possible et ouvre « Applications par défaut ».
#[tauri::command]
pub fn make_default_player() -> Result<(), String> {
    crate::default_app::register_and_open_settings()
}

/// Retire les doublons choisis (corbeille sur ordinateur) ; playlists et titres aimés
/// suivent la copie gardée. Renvoie aussi les fichiers que l'appli n'a pas pu effacer.
#[tauri::command(async)]
pub fn remove_duplicates(
    app: AppHandle,
    state: State<AppState>,
    groups: Vec<crate::duplicates::Removal>,
) -> Result<crate::duplicates::Outcome, String> {
    let (outcome, tracks) = {
        let mut library = state.library.lock().unwrap();
        let mut playlists = state.playlists.lock().unwrap();
        let mut favorites = state.favorites.lock().unwrap();
        let outcome = crate::duplicates::apply(
            &mut library,
            &mut playlists,
            &mut favorites,
            &groups,
            crate::duplicates::discard,
        );
        if outcome.removed > 0 {
            playlists.save(&state.playlists_path()).map_err(|e| e.to_string())?;
            favorites.save(&state.favorites_path()).map_err(|e| e.to_string())?;
        }
        (outcome, library.clone())
    };
    if outcome.removed > 0 {
        if let Some(root) = state.library_root.lock().unwrap().clone() {
            let _ = library::save_cache(&state.library_cache_path(), &root, &tracks);
        }
        let _ = app.emit("library-updated", &tracks);
    }
    Ok(outcome)
}

/// Aime plusieurs morceaux d'un coup (import des titres likés) ; renvoie le nombre ajouté.
#[tauri::command]
pub fn add_favorites(state: State<AppState>, track_ids: Vec<String>) -> Result<usize, String> {
    let mut store = state.favorites.lock().unwrap();
    let added = track_ids.into_iter().filter(|id| store.track_ids.insert(id.clone())).count();
    if added > 0 {
        store.save(&state.favorites_path()).map_err(|e| e.to_string())?;
    }
    Ok(added)
}

#[tauri::command]
pub fn list_favorites(state: State<AppState>) -> Vec<String> {
    state.favorites.lock().unwrap().track_ids.iter().cloned().collect()
}

// ---------------------------------------------------------------------
// Partage (export / import d'archives .mpshare)
// ---------------------------------------------------------------------

/// Propose un emplacement (boîte de dialogue native, ordinateur seulement) puis écrit
/// l'archive ; `None` si la boîte de dialogue a été annulée. Android : voir
/// `sharing::EXTENSION` et le dossier `partages/`, exposés autrement (feuille de partage).
#[cfg(not(target_os = "android"))]
fn pick_save_path(app: &AppHandle, suggested_name: &str) -> Option<PathBuf> {
    pick_save_path_as(app, suggested_name, "Partage Music Player", sharing::EXTENSION)
}

/// Boîte « Enregistrer sous » pour un type de fichier donné (partage, sauvegarde).
#[cfg(not(target_os = "android"))]
fn pick_save_path_as(app: &AppHandle, suggested_name: &str, label: &str, ext: &str) -> Option<PathBuf> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_file_name(suggested_name)
        .add_filter(label, &[ext])
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    rx.recv().ok().flatten().and_then(|p| p.into_path().ok())
}

#[cfg(target_os = "android")]
fn pick_save_path_as(app: &AppHandle, suggested_name: &str, _label: &str, _ext: &str) -> Option<PathBuf> {
    pick_save_path(app, suggested_name)
}

#[cfg(target_os = "android")]
fn pick_save_path(app: &AppHandle, suggested_name: &str) -> Option<PathBuf> {
    // Pas de boîte « Enregistrer sous » ici : l'archive est préparée dans le cache de l'appli,
    // le seul dossier que le FileProvider de la feuille de partage expose (ShareBridge.kt).
    Some(share_temp_dir(app)?.join(suggested_name))
}

/// Dossier des archives temporaires (partage Android, envoi à proximité ou par code), dans le
/// cache de l'appli. Les archives de plus d'un jour y sont effacées à chaque appel.
pub fn share_temp_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_cache_dir().ok()?.join("partages");
    std::fs::create_dir_all(&dir).ok()?;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        let day = Duration::from_secs(24 * 60 * 60);
        for entry in entries.flatten() {
            let old = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age > day);
            if old {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    Some(dir)
}

fn bundle_filename(name: &str) -> String {
    let safe: String = name
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) { '_' } else { c })
        .collect();
    format!("{}.{}", safe.trim().chars().take(80).collect::<String>(), sharing::EXTENSION)
}

/// Exporte un morceau dans une archive de partage ; renvoie le chemin créé, ou `None` si
/// l'utilisateur a annulé (ordinateur).
#[tauri::command(async)]
pub fn export_track(app: AppHandle, track_id: String) -> Result<Option<String>, String> {
    let state = app.state::<AppState>();
    let track = state.find_track(&track_id).ok_or("Morceau introuvable.")?;
    let Some(dest) = pick_save_path(&app, &bundle_filename(&track.title)) else {
        return Ok(None);
    };
    sharing::export_track(&state, &dest, &track_id)?;
    Ok(Some(dest.to_string_lossy().to_string()))
}

/// Exporte une playlist entière dans une archive de partage.
#[tauri::command(async)]
pub fn export_playlist(app: AppHandle, playlist_id: String) -> Result<Option<String>, String> {
    let state = app.state::<AppState>();
    let name = state
        .playlists
        .lock()
        .unwrap()
        .get(&playlist_id)
        .ok_or("Playlist introuvable.")?
        .name
        .clone();
    let Some(dest) = pick_save_path(&app, &bundle_filename(&name)) else {
        return Ok(None);
    };
    sharing::export_playlist(&state, &dest, &playlist_id)?;
    Ok(Some(dest.to_string_lossy().to_string()))
}

// ---------------------------------------------------------------------
// Sauvegarde (fichier .mpsave : playlists, titres aimés, écoute, réglages)
// ---------------------------------------------------------------------

pub const BACKUP_EXTENSION: &str = "mpsave";
const BACKUP_MAX: u64 = 30 * 1024 * 1024;

/// Écrit la sauvegarde préparée par l'interface (JSON) ; ordinateur : « Enregistrer sous »,
/// Android : dans le cache, partagée ensuite par la feuille de partage. `None` : annulé.
#[tauri::command(async)]
pub fn save_backup(app: AppHandle, json: String, name: String) -> Result<Option<String>, String> {
    serde_json::from_str::<serde_json::Value>(&json).map_err(|_| "Sauvegarde invalide.".to_string())?;
    let file = bundle_filename(&name).replace(&format!(".{}", sharing::EXTENSION), &format!(".{BACKUP_EXTENSION}"));
    let Some(dest) = pick_save_path_as(&app, &file, "Sauvegarde Music Player", BACKUP_EXTENSION) else {
        return Ok(None);
    };
    std::fs::write(&dest, json).map_err(|e| e.to_string())?;
    Ok(Some(dest.to_string_lossy().to_string()))
}

/// Contenu d'une sauvegarde ouverte avec l'appli (« Ouvrir avec Music Player »).
#[tauri::command(async)]
pub fn read_backup(path: String) -> Result<String, String> {
    let path = PathBuf::from(path);
    if crate::ffmpeg::extension_of(&path) != BACKUP_EXTENSION {
        return Err("Ce fichier n'est pas une sauvegarde Music Player.".into());
    }
    if std::fs::metadata(&path).map_err(|e| e.to_string())?.len() > BACKUP_MAX {
        return Err("Sauvegarde trop volumineuse.".into());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Ajoute à l'historique d'écoute les écoutes d'une sauvegarde qui n'y sont pas déjà ;
/// renvoie le nombre ajouté.
#[tauri::command(async)]
pub fn import_listens(state: State<'_, AppState>, listens: Vec<crate::listening::Listen>) -> Result<usize, String> {
    crate::listening::merge(&state.data_dir, listens)
}

/// Propose de choisir une archive de partage à importer (boîte de dialogue, ordinateur
/// seulement : sur Android, un chemin choisi ainsi serait une adresse `content://` que
/// `import_share_bundle` ne sait pas lire — on y importe plutôt par « Ouvrir avec »).
#[tauri::command(async)]
pub fn pick_share_file(app: AppHandle) -> Option<String> {
    #[cfg(target_os = "android")]
    {
        let _ = app;
        None
    }
    #[cfg(not(target_os = "android"))]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        app.dialog()
            .file()
            .add_filter("Partage Music Player", &[sharing::EXTENSION])
            .pick_file(move |file| {
                let _ = tx.send(file);
            });
        rx.recv()
            .ok()
            .flatten()
            .and_then(|p| p.into_path().ok())
            .map(|p| p.to_string_lossy().to_string())
    }
}

// ---------------------------------------------------------------------
// Partage à proximité (même réseau) et à distance (par code)
// ---------------------------------------------------------------------

/// Rend l'appareil visible des voisins sous ce nom (relancé si le nom change).
#[tauri::command(async)]
pub fn nearby_start(app: AppHandle, name: String, code: Option<String>) -> Result<(), String> {
    let code = code.filter(|c| c.len() == 9 && c.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-'));
    crate::nearby::start(&app, &name, code.as_deref())
}

#[tauri::command(async)]
pub fn nearby_stop() {
    crate::nearby::stop();
}

/// Appareils avec Music Player ouvert sur le même réseau.
#[tauri::command(async)]
pub fn nearby_scan(app: AppHandle) -> Result<Vec<crate::nearby::Peer>, String> {
    crate::nearby::scan(&app, Duration::from_millis(2500))
}

/// Réponse à un envoi reçu d'un voisin (événement « nearby-offer »).
#[tauri::command]
pub fn nearby_answer(id: String, accept: bool) {
    crate::nearby::answer(&id, accept);
}

fn report(app: &AppHandle, id: &str) -> impl FnMut(&'static str, u64, u64) + Send + 'static {
    let app = app.clone();
    let id = id.to_string();
    move |stage, done, total| {
        crate::transfer::emit(&app, crate::transfer::Progress::new(&id, stage, done, total))
    }
}

fn finish_report(app: &AppHandle, id: &str, result: &Result<(), String>) {
    let mut p = crate::transfer::Progress::new(id, "fini", 0, 0);
    if let Err(e) = result {
        p.stage = if e.contains("refusé") { "refuse" } else { "erreur" };
        p.message = Some(e.clone());
    }
    crate::transfer::emit(app, p);
    crate::transfer::forget(id);
}

/// Envoie un morceau ou une playlist à un appareil voisin ; avancement en « share-progress ».
#[tauri::command(async)]
pub fn nearby_send(
    app: AppHandle,
    peer: crate::nearby::Peer,
    item: crate::transfer::Item,
    from: String,
    transfer_id: String,
) -> Result<(), String> {
    let cancel = crate::transfer::cancel_flag(&transfer_id);
    let result = crate::transfer::prepare(&app, &item, &from).and_then(|(path, offer)| {
        let sent = crate::nearby::send_to(&peer.addresses, &path, &offer, &cancel, report(&app, &transfer_id));
        let _ = std::fs::remove_file(&path);
        sent
    });
    finish_report(&app, &transfer_id, &result);
    result
}

fn relay_or_default(relay: Option<String>) -> Result<String, String> {
    relay
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty())
        .or_else(|| crate::remote::default_relay().map(str::to_string))
        .ok_or_else(|| "Aucun relais de partage n'est réglé (Réglages → Partage).".to_string())
}

/// Adresse du relais choisie à la construction de l'application, s'il y en a une.
#[tauri::command]
pub fn default_relay() -> Option<String> {
    crate::remote::default_relay().map(str::to_string)
}

#[derive(Serialize)]
pub struct RemoteStart {
    pub code: String,
}

/// Prépare l'archive et réserve une salle sur le relais ; renvoie le code à donner au
/// destinataire. L'envoi continue en arrière-plan (« share-progress ») jusqu'à ce qu'il le
/// saisisse (15 minutes au plus).
#[tauri::command(async)]
pub fn remote_send_start(
    app: AppHandle,
    item: crate::transfer::Item,
    from: String,
    relay: Option<String>,
    transfer_id: String,
) -> Result<RemoteStart, String> {
    let relay = relay_or_default(relay)?;
    let (path, offer) = crate::transfer::prepare(&app, &item, &from)?;
    let pending = match crate::remote::open_send(&relay) {
        Ok(p) => p,
        Err(e) => {
            let _ = std::fs::remove_file(&path);
            return Err(e);
        }
    };
    let code = pending.code.text();
    let cancel = crate::transfer::cancel_flag(&transfer_id);
    std::thread::spawn(move || {
        let result = pending.finish(&relay, &path, &offer, &cancel, report(&app, &transfer_id));
        let _ = std::fs::remove_file(&path);
        finish_report(&app, &transfer_id, &result);
    });
    Ok(RemoteStart { code })
}

/// Reçoit ce qui est envoyé avec ce code, puis l'importe dans la bibliothèque.
#[tauri::command(async)]
pub fn remote_receive(
    app: AppHandle,
    code: String,
    relay: Option<String>,
    transfer_id: String,
) -> Result<ImportResult, String> {
    let relay = relay_or_default(relay)?;
    let code = crate::remote::parse_code(&code)?;
    let dir = share_temp_dir(&app).ok_or("Dossier temporaire indisponible.")?;
    let dest = dir.join(format!("{transfer_id}.{}", sharing::EXTENSION));
    let cancel = crate::transfer::cancel_flag(&transfer_id);
    let result = crate::remote::receive(&relay, &code, &dest, &cancel, report(&app, &transfer_id))
        .and_then(|_| crate::transfer::import_received(&app, &dest));
    let _ = std::fs::remove_file(&dest);
    finish_report(&app, &transfer_id, &result.as_ref().map(|_| ()).map_err(Clone::clone));
    result
}

/// Annule un envoi ou une réception en cours.
#[tauri::command]
pub fn transfer_cancel(id: String) {
    crate::transfer::cancel(&id);
}

/// Importe une archive de partage reçue d'un autre appareil (choisie dans une boîte de
/// dialogue, ou ouverte depuis le système — voir `App.vue::openFile`).
#[tauri::command(async)]
pub fn import_share_bundle(app: AppHandle, path: String) -> Result<ImportResult, String> {
    let state = app.state::<AppState>();
    let result = sharing::import_bundle(&state, Path::new(&path))?;
    let _ = app.emit("library-updated", state.library.lock().unwrap().clone());
    Ok(result)
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
    /// Identifiants des morceaux aimés.
    pub favorites: Vec<String>,
    /// Un scan tourne en arrière-plan : la bibliothèque affichée vient du cache.
    pub scanning: bool,
    /// Réglages d'apparence enregistrés (`null` : apparence par défaut).
    pub appearance: serde_json::Value,
    /// Dossier des fichiers importés (polices, images), servis par le protocole « asset ».
    pub custom_dir: String,
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
        favorites: state.favorites.lock().unwrap().track_ids.iter().cloned().collect(),
        scanning: state.scanning.load(Ordering::SeqCst),
        appearance: crate::appearance::load(&state.data_dir),
        custom_dir: crate::appearance::custom_dir(&state.data_dir)
            .to_string_lossy()
            .to_string(),
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

    let favorites =
        crate::favorites::FavoritesStore::load(&PathBuf::from(data_dir).join("favorites.json"));
    *state.favorites.lock().unwrap() = favorites;

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
