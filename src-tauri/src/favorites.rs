//! Morceaux « aimés » (favoris) : un simple ensemble d'identifiants de pistes,
//! persisté en JSON sur disque (même schéma que `playlists.rs`). Les pistes sont
//! référencées par leur `id` stable (`library::track_id_for_path`), donc un rescan
//! de la bibliothèque ne perd pas les favoris tant que les fichiers restent au même endroit.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FavoritesStore {
    pub track_ids: HashSet<String>,
}

impl FavoritesStore {
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

    pub fn is_favorite(&self, track_id: &str) -> bool {
        self.track_ids.contains(track_id)
    }

    /// Inverse l'état d'une piste (aimée / plus aimée) ; renvoie le nouvel état.
    pub fn toggle(&mut self, track_id: &str) -> bool {
        if self.track_ids.remove(track_id) {
            false
        } else {
            self.track_ids.insert(track_id.to_string());
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toggle_adds_then_removes() {
        let mut store = FavoritesStore::default();
        assert!(!store.is_favorite("t1"));
        assert!(store.toggle("t1"));
        assert!(store.is_favorite("t1"));
        assert!(!store.toggle("t1"));
        assert!(!store.is_favorite("t1"));
    }

    #[test]
    fn persist_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("favorites.json");

        let mut store = FavoritesStore::load(&path); // fichier absent -> vide
        assert!(store.track_ids.is_empty());

        store.toggle("a");
        store.toggle("b");
        store.save(&path).unwrap();

        let reloaded = FavoritesStore::load(&path);
        assert_eq!(reloaded.track_ids.len(), 2);
        assert!(reloaded.is_favorite("a"));
        assert!(reloaded.is_favorite("b"));
    }

    #[test]
    fn load_from_corrupted_file_falls_back_to_empty_store() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("favorites.json");
        fs::write(&path, b"{ceci n'est pas du json valide").unwrap();
        let store = FavoritesStore::load(&path);
        assert!(store.track_ids.is_empty());
    }
}
