//! Suppression des doublons choisis dans l'interface (la détection, rapide, se fait côté
//! page) : chaque copie retirée part à la corbeille de l'ordinateur (récupérable), et les
//! playlists et titres aimés qui la citaient pointent désormais vers la copie gardée.
//!
//! Sur Android, l'appli ne peut pas toujours effacer un fichier qu'elle n'a pas créé : ces
//! fichiers sont renvoyés dans `failed`, l'interface demande l'accord du système
//! (MediaStore) puis rappelle `apply`, qui constate leur disparition et termine le travail.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;

use crate::favorites::FavoritesStore;
use crate::library::Track;
use crate::playlists::PlaylistStore;

/// Un groupe de doublons : la copie gardée et celles à retirer (identifiants de pistes).
#[derive(Debug, Clone, Deserialize)]
pub struct Removal {
    pub keep: String,
    pub remove: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Outcome {
    /// Copies retirées (fichier supprimé, références redirigées).
    pub removed: usize,
    /// Fichiers que l'appli n'a pas pu supprimer elle-même (chemins).
    pub failed: Vec<String>,
}

/// Met le fichier à la corbeille (ordinateur) ou l'efface (téléphone, pas de corbeille).
pub fn discard(path: &Path) -> Result<(), String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        trash::delete(path).map_err(|e| e.to_string())
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        std::fs::remove_file(path).map_err(|e| e.to_string())
    }
}

/// Retire les copies demandées. Seules des pistes de la bibliothèque sont touchées, jamais la
/// copie gardée ; une copie dont le fichier a déjà disparu est simplement oubliée.
pub fn apply(
    library: &mut Vec<Track>,
    playlists: &mut PlaylistStore,
    favorites: &mut FavoritesStore,
    removals: &[Removal],
    remove_file: impl Fn(&Path) -> Result<(), String>,
) -> Outcome {
    let mut outcome = Outcome::default();
    let mut gone: HashSet<String> = HashSet::new();
    for group in removals {
        if !library.iter().any(|t| t.id == group.keep) {
            continue;
        }
        for id in group.remove.iter().filter(|id| **id != group.keep) {
            let Some(track) = library.iter().find(|t| &t.id == id) else { continue };
            let path = Path::new(&track.path);
            if path.exists() {
                let _ = remove_file(path);
            }
            if path.exists() {
                outcome.failed.push(track.path.clone());
                continue;
            }
            relink(playlists, favorites, id, &group.keep);
            gone.insert(id.clone());
            outcome.removed += 1;
        }
    }
    library.retain(|t| !gone.contains(&t.id));
    outcome
}

/// Les playlists et les titres aimés qui citaient `old` citent `new` (sans doublon dans une
/// même playlist).
fn relink(playlists: &mut PlaylistStore, favorites: &mut FavoritesStore, old: &str, new: &str) {
    for playlist in &mut playlists.playlists {
        if !playlist.track_ids.iter().any(|t| t == old) {
            continue;
        }
        let has_new = playlist.track_ids.iter().any(|t| t == new);
        if has_new {
            playlist.track_ids.retain(|t| t != old);
        } else {
            for t in &mut playlist.track_ids {
                if t == old {
                    *t = new.to_string();
                }
            }
        }
    }
    if favorites.track_ids.remove(old) {
        favorites.track_ids.insert(new.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::track_id_for_path;

    fn track(path: &Path) -> Track {
        Track {
            id: track_id_for_path(path),
            path: path.to_string_lossy().to_string(),
            title: "Titre".into(),
            artist: "Artiste".into(),
            album: "Album".into(),
            album_artist: "Artiste".into(),
            track_no: None,
            disc_no: None,
            year: None,
            genre: None,
            duration_secs: 180.0,
            has_cover: false,
            added_secs: 0,
            damage: None,
        }
    }

    #[test]
    fn removes_copies_and_relinks_playlists_and_favorites() {
        let dir = tempfile::tempdir().unwrap();
        let paths: Vec<_> = ["a.mp3", "b.mp3", "c.mp3"].iter().map(|n| dir.path().join(n)).collect();
        for p in &paths {
            std::fs::write(p, b"x").unwrap();
        }
        let tracks: Vec<Track> = paths.iter().map(|p| track(p)).collect();
        let (a, b, c) = (tracks[0].id.clone(), tracks[1].id.clone(), tracks[2].id.clone());
        let mut library = tracks.clone();
        let mut playlists = PlaylistStore::default();
        let p1 = playlists.create("Soir".into(), None);
        playlists.add_tracks(&p1, vec![b.clone(), c.clone()]).unwrap();
        let p2 = playlists.create("Matin".into(), None);
        playlists.add_tracks(&p2, vec![a.clone(), b.clone()]).unwrap();
        let mut favorites = FavoritesStore::default();
        favorites.toggle(&b);

        let outcome = apply(
            &mut library,
            &mut playlists,
            &mut favorites,
            &[Removal { keep: a.clone(), remove: vec![b.clone(), a.clone()] }],
            |p| std::fs::remove_file(p).map_err(|e| e.to_string()),
        );
        assert_eq!(outcome, Outcome { removed: 1, failed: vec![] });
        assert!(!paths[1].exists() && paths[0].exists());
        assert_eq!(library.len(), 2);
        assert_eq!(playlists.get(&p1).unwrap().track_ids, vec![a.clone(), c]);
        assert_eq!(playlists.get(&p2).unwrap().track_ids, vec![a.clone()]);
        assert!(favorites.is_favorite(&a) && !favorites.is_favorite(&b));
    }

    #[test]
    fn a_file_that_cannot_be_removed_is_reported_and_kept() {
        let dir = tempfile::tempdir().unwrap();
        let (pa, pb) = (dir.path().join("a.mp3"), dir.path().join("b.mp3"));
        std::fs::write(&pa, b"x").unwrap();
        std::fs::write(&pb, b"x").unwrap();
        let mut library = vec![track(&pa), track(&pb)];
        let (a, b) = (library[0].id.clone(), library[1].id.clone());
        let outcome = apply(
            &mut library,
            &mut PlaylistStore::default(),
            &mut FavoritesStore::default(),
            &[Removal { keep: a, remove: vec![b] }],
            |_| Err("refusé".into()),
        );
        assert_eq!(outcome.removed, 0);
        assert_eq!(outcome.failed, vec![pb.to_string_lossy().to_string()]);
        assert_eq!(library.len(), 2);
    }

    #[test]
    fn an_already_deleted_copy_is_just_forgotten() {
        let dir = tempfile::tempdir().unwrap();
        let (pa, pb) = (dir.path().join("a.mp3"), dir.path().join("b.mp3"));
        std::fs::write(&pa, b"x").unwrap();
        let mut library = vec![track(&pa), track(&pb)];
        let (a, b) = (library[0].id.clone(), library[1].id.clone());
        let outcome = apply(
            &mut library,
            &mut PlaylistStore::default(),
            &mut FavoritesStore::default(),
            &[Removal { keep: a, remove: vec![b] }],
            |_| panic!("rien à effacer"),
        );
        assert_eq!(outcome.removed, 1);
        assert_eq!(library.len(), 1);
    }
}
