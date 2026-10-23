//! Partage d'un morceau ou d'une playlist avec un autre appareil, à proximité (nearby.rs) ou
//! à distance par code (remote.rs) : archive préparée, offre décrite, avancement transmis à
//! l'interface, archive reçue importée. Les deux modes échangent la même archive `.mpshare`
//! (sharing.rs), qui contient les fichiers audio : le destinataire n'a pas besoin de les avoir.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use tauri::{AppHandle, Emitter, Manager};

use crate::sharing::{self, ImportResult};
use crate::state::AppState;

/// Ce que l'on partage, tel que l'interface le désigne : `{ "kind": "track", "id": "…" }`.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", content = "id", rename_all = "lowercase")]
pub enum Item {
    Track(String),
    Playlist(String),
}

/// Description d'un envoi, montrée à la personne qui reçoit avant qu'elle accepte.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Offer {
    /// Nom de profil de l'expéditeur (Réglages → Personnalisation).
    pub from: String,
    /// « track » ou « playlist ».
    pub kind: String,
    pub name: String,
    pub tracks: usize,
    /// Taille de l'archive (octets).
    pub size: u64,
}

/// Archive acceptée à la réception : 4 Go au plus.
pub const MAX_SIZE: u64 = 4 * 1024 * 1024 * 1024;
/// Morceaux d'archive envoyés un à un (le relais limite un message à 1 Mo).
pub const CHUNK: usize = 256 * 1024;

/// Avancement d'un envoi ou d'une réception, pour l'interface.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Progress {
    pub id: String,
    /// « attente » (du correspondant ou de son accord), « envoi », « reception », « fini »,
    /// « refuse », « erreur ».
    pub stage: &'static str,
    pub done: u64,
    pub total: u64,
    pub message: Option<String>,
}

impl Progress {
    pub fn new(id: &str, stage: &'static str, done: u64, total: u64) -> Self {
        Self { id: id.to_string(), stage, done, total, message: None }
    }
}

pub fn emit(app: &AppHandle, progress: Progress) {
    let _ = app.emit("share-progress", progress);
}

/// Prépare l'archive à envoyer dans le cache de l'appli, avec son offre.
pub fn prepare(app: &AppHandle, item: &Item, from: &str) -> Result<(PathBuf, Offer), String> {
    let state = app.state::<AppState>();
    let dir = crate::commands::share_temp_dir(app).ok_or("Dossier temporaire indisponible.")?;
    let path = dir.join(format!("{}.{}", uuid::Uuid::new_v4(), sharing::EXTENSION));
    let (kind, name, tracks) = match item {
        Item::Track(id) => {
            let track = state.find_track(id).ok_or("Morceau introuvable.")?;
            sharing::export_track(&state, &path, id)?;
            ("track", track.title, 1)
        }
        Item::Playlist(id) => {
            let (name, count) = {
                let store = state.playlists.lock().unwrap();
                let playlist = store.get(id).ok_or("Playlist introuvable.")?;
                (playlist.name.clone(), playlist.track_ids.len())
            };
            sharing::export_playlist(&state, &path, id)?;
            ("playlist", name, count)
        }
    };
    let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    let from = if from.trim().is_empty() { "Music Player" } else { from.trim() };
    Ok((
        path,
        Offer { from: from.chars().take(40).collect(), kind: kind.into(), name, tracks, size },
    ))
}

/// Archive reçue : importée dans la bibliothèque (puis effacée), interface prévenue.
pub fn import_received(app: &AppHandle, path: &Path) -> Result<ImportResult, String> {
    let state = app.state::<AppState>();
    let result = sharing::import_bundle(&state, path);
    let _ = std::fs::remove_file(path);
    let result = result?;
    let _ = app.emit("library-updated", state.library.lock().unwrap().clone());
    let _ = app.emit("share-received", &result);
    Ok(result)
}

static CANCEL: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = LazyLock::new(Default::default);

/// Drapeau d'annulation d'un transfert (créé au premier appel).
pub fn cancel_flag(id: &str) -> Arc<AtomicBool> {
    CANCEL.lock().unwrap().entry(id.to_string()).or_default().clone()
}

pub fn cancel(id: &str) {
    if let Some(flag) = CANCEL.lock().unwrap().get(id) {
        flag.store(true, Ordering::SeqCst);
    }
}

pub fn forget(id: &str) {
    CANCEL.lock().unwrap().remove(id);
}

pub fn cancelled(flag: &AtomicBool) -> Result<(), String> {
    if flag.load(Ordering::SeqCst) {
        Err("Partage annulé.".into())
    } else {
        Ok(())
    }
}

/// Recopie `size` octets de `from` vers `to`, avec l'avancement (au plus un appel par morceau).
pub fn copy_exact(
    from: &mut impl Read,
    to: &mut impl Write,
    size: u64,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64),
) -> Result<(), String> {
    let mut buffer = vec![0u8; CHUNK];
    let mut done = 0u64;
    while done < size {
        cancelled(cancel)?;
        let want = (size - done).min(CHUNK as u64) as usize;
        let n = from.read(&mut buffer[..want]).map_err(|e| format!("Transfert interrompu : {e}"))?;
        if n == 0 {
            return Err("Transfert interrompu : le correspondant s'est déconnecté.".into());
        }
        to.write_all(&buffer[..n]).map_err(|e| format!("Transfert interrompu : {e}"))?;
        done += n as u64;
        progress(done);
    }
    Ok(())
}
