//! État partagé de l'application, géré par Tauri (`app.manage(...)`) et
//! accessible depuis chaque commande via `tauri::State<AppState>`.

use crate::audio::AudioHandle;
use crate::eq::{new_eq_gains, EqGains};
use crate::library::Track;
use crate::playlists::PlaylistStore;
use crate::queue::Queue;
use std::path::PathBuf;
use std::sync::Mutex;

pub struct AppState {
    pub audio: AudioHandle,
    pub queue: Mutex<Queue>,
    pub library: Mutex<Vec<Track>>,
    pub library_root: Mutex<Option<String>>,
    pub playlists: Mutex<PlaylistStore>,
    pub eq_gains: EqGains,
    pub volume: Mutex<f32>,
    /// Dossier de données de l'app (résolu par Tauri au démarrage), où
    /// vivent `playlists.json` et `session.json`.
    pub data_dir: PathBuf,
}

impl AppState {
    pub fn new(data_dir: PathBuf) -> Self {
        let eq_gains = new_eq_gains([0.0, 0.0, 0.0]);
        Self {
            audio: AudioHandle::spawn(eq_gains.clone()),
            queue: Mutex::new(Queue::new()),
            library: Mutex::new(Vec::new()),
            library_root: Mutex::new(None),
            playlists: Mutex::new(PlaylistStore::default()),
            eq_gains,
            volume: Mutex::new(1.0),
            data_dir,
        }
    }

    pub fn playlists_path(&self) -> PathBuf {
        self.data_dir.join("playlists.json")
    }

    pub fn session_path(&self) -> PathBuf {
        self.data_dir.join("session.json")
    }

    pub fn find_track(&self, id: &str) -> Option<Track> {
        self.library.lock().unwrap().iter().find(|t| t.id == id).cloned()
    }
}
