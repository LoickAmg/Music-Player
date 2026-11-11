//! Commandes Tauri et traitement en arrière-plan de la file de téléchargements.
//!
//! Un seul fil de travail à la fois. Règle du projet : jamais deux verrous tenus en même
//! temps (file, annulations, bibliothèque, racine, playlists) ; les événements partent une
//! fois les verrous relâchés.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::Serialize;
use tauri::{Emitter, Manager};

use crate::fetch::import::download_and_import;
use crate::fetch::queue::{QueueItem, QueueStore};
use crate::fetch::source::Source;
use crate::fetch::spotdl::SpotDlSource;
use crate::fetch::ytdlp::YtDlpSource;
use crate::fetch::{JobError, JobState, Wanted};
use crate::library::Track;
use crate::state::{AppState, Locked};

const QUEUE_EVENT: &str = "fetch-queue-updated";
const JOB_EVENT: &str = "fetch-job-updated";
const QUEUE_FILE: &str = "telechargements.json";

/// État partagé de la file, enregistré dans Tauri sous `Arc<FetchRuntime>`.
pub struct FetchRuntime {
    queue: Mutex<QueueStore>,
    cancellations: Mutex<HashMap<String, Arc<AtomicBool>>>,
    worker_running: AtomicBool,
}

impl FetchRuntime {
    /// Ouvre la file enregistrée. Fichier illisible pour une raison système : file vide (et le
    /// message), pour que l'appli démarre quand même.
    pub fn open(data_dir: &Path) -> (Self, Option<String>) {
        let path = data_dir.join(QUEUE_FILE);
        let (queue, problem) = match QueueStore::open(&path) {
            Ok(queue) => (queue, None),
            Err(error) => (QueueStore::empty(&path), Some(format!("File de téléchargements illisible, repartie à vide : {error}"))),
        };
        let runtime = Self { queue: Mutex::new(queue), cancellations: Mutex::new(HashMap::new()), worker_running: AtomicBool::new(false) };
        (runtime, problem)
    }
}

#[derive(Debug, Serialize)]
pub struct FetchAvailability {
    pub spotdl: bool,
    pub ytdlp: bool,
}

#[derive(Clone, Debug, Serialize)]
struct JobUpdate<'a> {
    id: &'a str,
    state: JobState,
    error: &'a Option<String>,
}

#[tauri::command(async)]
pub fn fetch_availability() -> FetchAvailability {
    FetchAvailability { spotdl: SpotDlSource.available(), ytdlp: YtDlpSource.available() }
}

#[tauri::command]
pub fn fetch_jobs(runtime: tauri::State<'_, Arc<FetchRuntime>>) -> Vec<QueueItem> {
    runtime.queue.locked().items().to_vec()
}

#[tauri::command]
pub fn fetch_enqueue(app: tauri::AppHandle, runtime: tauri::State<'_, Arc<FetchRuntime>>, wanted: Vec<Wanted>) -> Result<Vec<String>, String> {
    if wanted.is_empty() {
        return Ok(Vec::new());
    }
    let ids = runtime.queue.locked().enqueue_many(wanted).map_err(|error| error.to_string())?;
    emit_queue(&app, runtime.inner());
    start_worker(app, Arc::clone(runtime.inner()));
    Ok(ids)
}

#[tauri::command]
pub fn fetch_cancel(app: tauri::AppHandle, runtime: tauri::State<'_, Arc<FetchRuntime>>, id: String) -> Result<(), String> {
    let active = runtime.cancellations.locked().get(&id).cloned();
    if let Some(cancel) = active {
        cancel.store(true, Ordering::Relaxed);
        return Ok(());
    }
    {
        let mut queue = runtime.queue.locked();
        let item = queue.items().iter().find(|item| item.id == id).ok_or_else(|| "Tâche de téléchargement introuvable.".to_owned())?;
        if item.state != JobState::Queued {
            return Err("Cette tâche ne peut plus être annulée.".to_owned());
        }
        queue.set_state(&id, JobState::Cancelled, Some("Arrêt demandé.".to_owned())).map_err(|error| error.to_string())?;
    }
    emit_job(&app, runtime.inner(), &id);
    emit_queue(&app, runtime.inner());
    Ok(())
}

#[tauri::command]
pub fn fetch_clear_finished(app: tauri::AppHandle, runtime: tauri::State<'_, Arc<FetchRuntime>>) -> Result<usize, String> {
    let removed = runtime.queue.locked().remove_finished().map_err(|error| error.to_string())?;
    emit_queue(&app, runtime.inner());
    Ok(removed)
}

/// Lance le fil de travail s'il ne tourne pas déjà.
pub fn start_worker(app: tauri::AppHandle, runtime: Arc<FetchRuntime>) {
    if runtime.worker_running.swap(true, Ordering::AcqRel) {
        return;
    }
    thread::spawn(move || worker_loop(app, runtime));
}

fn worker_loop(app: tauri::AppHandle, runtime: Arc<FetchRuntime>) {
    loop {
        let next = {
            let mut queue = runtime.queue.locked();
            let Some(item) = queue.next_queued() else {
                // Remis à faux file verrouillée : un ajout concurrent relancera un fil.
                runtime.worker_running.store(false, Ordering::Release);
                return;
            };
            let (id, wanted) = (item.id.clone(), item.wanted.clone());
            if let Err(error) = queue.set_state(&id, JobState::Running, None) {
                runtime.worker_running.store(false, Ordering::Release);
                drop(queue);
                let _ = app.emit("fetch-error", format!("Impossible de démarrer la tâche : {error}"));
                return;
            }
            (id, wanted)
        };
        let (id, wanted) = next;
        let cancel = Arc::new(AtomicBool::new(false));
        runtime.cancellations.locked().insert(id.clone(), Arc::clone(&cancel));
        emit_job(&app, &runtime, &id);
        emit_queue(&app, &runtime);

        let (state, error) = match run_job(&app, &wanted, &cancel) {
            Ok(track) => match add_imported_track(&app, &wanted, track) {
                Ok(()) => (JobState::Done, None),
                Err(detail) => (JobState::Failed, Some(detail)),
            },
            Err(JobError::Cancelled) => (JobState::Cancelled, Some("Arrêt demandé.".to_owned())),
            Err(error) => (JobState::Failed, Some(error.to_string())),
        };

        runtime.cancellations.locked().remove(&id);
        let saved = runtime.queue.locked().set_state(&id, state, error);
        if let Err(save_error) = saved {
            let _ = app.emit("fetch-error", format!("Impossible d'enregistrer l'état de la tâche : {save_error}"));
        }
        emit_job(&app, &runtime, &id);
        emit_queue(&app, &runtime);
    }
}

/// spotDL d'abord ; yt-dlp s'il est absent, ne trouve rien ou se trompe de morceau.
fn run_job(app: &tauri::AppHandle, wanted: &Wanted, cancel: &AtomicBool) -> Result<Track, JobError> {
    let root = app
        .state::<AppState>()
        .library_root
        .locked()
        .clone()
        .ok_or_else(|| JobError::Failed("Choisissez d'abord le dossier de votre bibliothèque.".to_owned()))?;
    let root = PathBuf::from(root);
    match download_and_import(&SpotDlSource, wanted, &root, cancel) {
        Err(JobError::NotFound | JobError::Failed(_) | JobError::ToolMissing(_)) if !cancel.load(Ordering::Relaxed) => {
            download_and_import(&YtDlpSource, wanted, &root, cancel)
        }
        other => other,
    }
}

/// Morceau importé : bibliothèque, playlist demandée, cache, puis l'interface prévenue.
/// Un verrou à la fois (la racine est lue avant de toucher à la bibliothèque).
fn add_imported_track(app: &tauri::AppHandle, wanted: &Wanted, track: Track) -> Result<(), String> {
    let state = app.state::<AppState>();
    let track_id = track.id.clone();
    {
        let mut library = state.library.locked();
        if !library.iter().any(|existing| existing.id == track.id) {
            library.push(track);
        }
    }
    if let Some(playlist_id) = &wanted.playlist_id {
        let mut playlists = state.playlists.locked();
        playlists
            .add_tracks(playlist_id, vec![track_id])
            .map_err(|_| "Playlist introuvable ; morceau conservé dans la bibliothèque.".to_owned())?;
        playlists.save(&state.playlists_path()).map_err(|error| format!("Morceau importé, mais playlist non enregistrée : {error}"))?;
    }
    let root = state.library_root.locked().clone();
    if let Some(root) = root {
        let library = state.library.locked();
        let _ = crate::library::save_cache(&state.library_cache_path(), &root, &library);
    }
    let _ = app.emit("library-updated", &*state.library.locked());
    Ok(())
}

fn emit_job(app: &tauri::AppHandle, runtime: &FetchRuntime, id: &str) {
    let queue = runtime.queue.locked();
    if let Some(item) = queue.items().iter().find(|item| item.id == id) {
        let _ = app.emit(JOB_EVENT, JobUpdate { id: &item.id, state: item.state, error: &item.last_error });
    }
}

fn emit_queue(app: &tauri::AppHandle, runtime: &FetchRuntime) {
    let _ = app.emit(QUEUE_EVENT, runtime.queue.locked().items());
}
