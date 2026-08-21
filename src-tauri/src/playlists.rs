//! Playlists nommées, persistées en JSON sur disque (dossier de données de
//! l'application). Les pistes sont référencées par leur `id` stable
//! (`library::track_id_for_path`), donc un rescan de la bibliothèque ne
//! casse pas les playlists tant que les fichiers restent au même endroit.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Playlist {
    pub id: String,
    pub name: String,
    pub track_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PlaylistStore {
    pub playlists: Vec<Playlist>,
}

#[derive(Debug)]
pub enum PlaylistError {
    NotFound,
}

impl PlaylistStore {
    pub fn load(path: &Path) -> Self {
        match fs::read_to_string(path) {
            Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(self).unwrap();
        fs::write(path, json)
    }

    pub fn create(&mut self, name: String) -> String {
        let id = Uuid::new_v4().to_string();
        self.playlists.push(Playlist {
            id: id.clone(),
            name,
            track_ids: Vec::new(),
        });
        id
    }

    pub fn delete(&mut self, id: &str) -> bool {
        let before = self.playlists.len();
        self.playlists.retain(|p| p.id != id);
        self.playlists.len() != before
    }

    pub fn rename(&mut self, id: &str, name: String) -> Result<(), PlaylistError> {
        let playlist = self
            .playlists
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or(PlaylistError::NotFound)?;
        playlist.name = name;
        Ok(())
    }

    pub fn add_track(&mut self, id: &str, track_id: String) -> Result<(), PlaylistError> {
        let playlist = self
            .playlists
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or(PlaylistError::NotFound)?;
        if !playlist.track_ids.contains(&track_id) {
            playlist.track_ids.push(track_id);
        }
        Ok(())
    }

    pub fn remove_track(&mut self, id: &str, track_id: &str) -> Result<(), PlaylistError> {
        let playlist = self
            .playlists
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or(PlaylistError::NotFound)?;
        playlist.track_ids.retain(|t| t != track_id);
        Ok(())
    }

    /// Déplace une piste d'un index à un autre dans la playlist (drag & drop
    /// côté frontend, remontée sous forme d'un simple couple d'indices).
    pub fn move_track(&mut self, id: &str, from: usize, to: usize) -> Result<(), PlaylistError> {
        let playlist = self
            .playlists
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or(PlaylistError::NotFound)?;
        if from >= playlist.track_ids.len() || to >= playlist.track_ids.len() {
            return Ok(());
        }
        let track = playlist.track_ids.remove(from);
        playlist.track_ids.insert(to, track);
        Ok(())
    }

    pub fn get(&self, id: &str) -> Option<&Playlist> {
        self.playlists.iter().find(|p| p.id == id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_add_and_persist_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("playlists.json");

        let mut store = PlaylistStore::load(&path); // fichier absent -> vide
        assert!(store.playlists.is_empty());

        let id = store.create("Route de vacances".to_string());
        store.add_track(&id, "track-1".to_string()).unwrap();
        store.add_track(&id, "track-2".to_string()).unwrap();
        store.save(&path).unwrap();

        let reloaded = PlaylistStore::load(&path);
        let playlist = reloaded.get(&id).unwrap();
        assert_eq!(playlist.name, "Route de vacances");
        assert_eq!(playlist.track_ids, vec!["track-1", "track-2"]);
    }

    #[test]
    fn add_track_is_idempotent() {
        let mut store = PlaylistStore::default();
        let id = store.create("Test".to_string());
        store.add_track(&id, "t1".to_string()).unwrap();
        store.add_track(&id, "t1".to_string()).unwrap();
        assert_eq!(store.get(&id).unwrap().track_ids.len(), 1);
    }

    #[test]
    fn remove_track_and_delete_playlist() {
        let mut store = PlaylistStore::default();
        let id = store.create("Test".to_string());
        store.add_track(&id, "t1".to_string()).unwrap();
        store.remove_track(&id, "t1").unwrap();
        assert!(store.get(&id).unwrap().track_ids.is_empty());

        assert!(store.delete(&id));
        assert!(store.get(&id).is_none());
        assert!(!store.delete(&id)); // déjà supprimée
    }

    #[test]
    fn move_track_reorders_within_playlist() {
        let mut store = PlaylistStore::default();
        let id = store.create("Test".to_string());
        for t in ["a", "b", "c"] {
            store.add_track(&id, t.to_string()).unwrap();
        }
        store.move_track(&id, 0, 2).unwrap();
        assert_eq!(store.get(&id).unwrap().track_ids, vec!["b", "c", "a"]);
    }

    #[test]
    fn operations_on_unknown_playlist_return_not_found() {
        let mut store = PlaylistStore::default();
        assert!(matches!(
            store.add_track("nope", "t1".to_string()),
            Err(PlaylistError::NotFound)
        ));
    }

    #[test]
    fn load_from_corrupted_file_falls_back_to_empty_store() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("playlists.json");
        fs::write(&path, b"{ceci n'est pas du json valide").unwrap();
        let store = PlaylistStore::load(&path);
        assert!(store.playlists.is_empty());
    }
}
