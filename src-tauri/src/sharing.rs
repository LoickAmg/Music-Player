//! Partage de sons ou de playlists entre appareils ou utilisateurs : une archive
//! `.mpshare` (zip) qui embarque les fichiers audio avec leurs métadonnées essentielles,
//! à exporter depuis un appareil puis importer sur un autre (fichier transmis par
//! messagerie, câble, Bluetooth… ou la feuille de partage du système sur Android).

use crate::library::{self, Track};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use zip::write::SimpleFileOptions;

/// Extension des archives de partage (sans le point).
pub const EXTENSION: &str = "mpshare";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ManifestTrack {
    title: String,
    artist: String,
    album: String,
    album_artist: String,
    track_no: Option<u32>,
    disc_no: Option<u32>,
    year: Option<u32>,
    genre: Option<String>,
    duration_secs: f64,
    has_cover: bool,
    /// Nom du fichier dans l'archive (dossier « pistes/ »).
    file: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Manifest {
    /// « track » (un ou plusieurs sons) ou « playlist ».
    kind: String,
    name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    theme: Option<String>,
    tracks: Vec<ManifestTrack>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportResult {
    pub name: String,
    pub kind: String,
    pub added_tracks: usize,
    pub skipped_tracks: usize,
    pub playlist_id: Option<String>,
}

/// Remplace les caractères interdits dans un nom de fichier par `_`, et tronque.
fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim();
    let truncated: String = trimmed.chars().take(120).collect();
    if truncated.is_empty() {
        "Sans titre".to_string()
    } else {
        truncated
    }
}

fn write_bundle(
    dest: &Path,
    kind: &str,
    name: &str,
    theme: Option<String>,
    tracks: &[Track],
) -> Result<(), String> {
    let file = fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    // Pas de recompression : les fichiers audio sont déjà compressés (mp3, flac, ogg…).
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);

    let mut manifest_tracks = Vec::with_capacity(tracks.len());
    let mut used_names: HashSet<String> = HashSet::new();
    for (i, track) in tracks.iter().enumerate() {
        let source = Path::new(&track.path);
        let ext = source.extension().and_then(|e| e.to_str()).unwrap_or("audio");
        let base = format!(
            "{:03} - {} - {}",
            i + 1,
            sanitize_filename(&track.artist),
            sanitize_filename(&track.title)
        );
        let mut filename = format!("{base}.{ext}");
        let mut n = 1;
        while !used_names.insert(filename.clone()) {
            filename = format!("{base} ({n}).{ext}");
            n += 1;
        }

        let bytes = fs::read(source)
            .map_err(|e| format!("Lecture de « {} » impossible : {e}", track.title))?;
        zip.start_file(format!("pistes/{filename}"), options)
            .map_err(|e| e.to_string())?;
        zip.write_all(&bytes).map_err(|e| e.to_string())?;

        manifest_tracks.push(ManifestTrack {
            title: track.title.clone(),
            artist: track.artist.clone(),
            album: track.album.clone(),
            album_artist: track.album_artist.clone(),
            track_no: track.track_no,
            disc_no: track.disc_no,
            year: track.year,
            genre: track.genre.clone(),
            duration_secs: track.duration_secs,
            has_cover: track.has_cover,
            file: filename,
        });
    }

    let manifest = Manifest { kind: kind.to_string(), name: name.to_string(), theme, tracks: manifest_tracks };
    let json = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
    zip.start_file("manifest.json", options).map_err(|e| e.to_string())?;
    zip.write_all(&json).map_err(|e| e.to_string())?;

    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

/// Exporte un seul morceau dans une archive de partage.
pub fn export_track(state: &AppState, dest: &Path, track_id: &str) -> Result<(), String> {
    let track = state.find_track(track_id).ok_or("Morceau introuvable.")?;
    let name = track.title.clone();
    write_bundle(dest, "track", &name, None, std::slice::from_ref(&track))
}

/// Exporte une playlist entière (ses morceaux encore présents dans la bibliothèque).
pub fn export_playlist(state: &AppState, dest: &Path, playlist_id: &str) -> Result<(), String> {
    let (name, theme, tracks) = {
        let store = state.playlists.lock().unwrap();
        let playlist = store.get(playlist_id).ok_or("Playlist introuvable.")?;
        let library = state.library.lock().unwrap();
        let tracks: Vec<Track> = playlist
            .track_ids
            .iter()
            .filter_map(|id| library.iter().find(|t| &t.id == id).cloned())
            .collect();
        (playlist.name.clone(), Some(playlist.theme.clone()), tracks)
    };
    if tracks.is_empty() {
        return Err("Cette playlist est vide (ou ses morceaux ne sont plus dans la bibliothèque).".to_string());
    }
    write_bundle(dest, "playlist", &name, theme, &tracks)
}

/// Dossier des morceaux reçus par partage, ajouté aux dossiers parcourus par le scan.
pub fn imports_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("importes")
}

/// Importe une archive de partage : copie les fichiers audio dans un dossier dédié du
/// dossier de données de l'appli, les ajoute à la bibliothèque, et recrée la playlist
/// si l'archive en contenait une.
pub fn import_bundle(state: &AppState, source: &Path) -> Result<ImportResult, String> {
    let file = fs::File::open(source).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|_| "Ce fichier n'est pas une archive de partage valide.".to_string())?;

    let manifest: Manifest = {
        let mut entry = archive
            .by_name("manifest.json")
            .map_err(|_| "Archive de partage invalide (manifeste manquant).".to_string())?;
        let mut content = String::new();
        entry.read_to_string(&mut content).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).map_err(|e| e.to_string())?
    };
    drop(archive);
    // Réouverture : `by_name` emprunte l'archive, la boucle ci-dessous doit la reprendre en entier.
    let file = fs::File::open(source).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

    // Dossier où les morceaux importés sont enregistrés (persistant, parcouru à chaque scan).
    let dest_dir = imports_dir(&state.data_dir);
    fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;

    let mut imported_ids = Vec::new();
    let mut skipped = 0usize;
    // Morceaux déjà là avant cet import : deux fichiers distincts de l'archive aux mêmes
    // étiquettes (fréquent) ne sont jamais fusionnés entre eux.
    let before: Vec<(String, String, String, f64, String)> = state
        .library
        .lock()
        .unwrap()
        .iter()
        .map(|t| (t.title.clone(), t.artist.clone(), t.album.clone(), t.duration_secs, t.id.clone()))
        .collect();
    for entry in &manifest.tracks {
        // Déjà importé (même titre/artiste/album) : on réutilise la piste existante, sans
        // recopier le fichier ni créer un doublon (une même archive importée deux fois, ou
        // deux playlists qui partagent un morceau déjà reçu).
        let existing_id = before
            .iter()
            .find(|(title, artist, album, duration, _)| {
                *title == entry.title
                    && *artist == entry.artist
                    && *album == entry.album
                    && (duration - entry.duration_secs).abs() <= 2.0
            })
            .map(|(.., id)| id.clone());
        if let Some(id) = existing_id {
            imported_ids.push(id);
            continue;
        }

        let bytes = match archive.by_name(&format!("pistes/{}", entry.file)) {
            Ok(mut zip_file) => {
                let mut bytes = Vec::new();
                if zip_file.read_to_end(&mut bytes).is_err() {
                    skipped += 1;
                    continue;
                }
                bytes
            }
            Err(_) => {
                skipped += 1;
                continue;
            }
        };

        let safe_name = sanitize_filename(&format!("{} - {}", entry.artist, entry.title));
        let ext = Path::new(&entry.file).extension().and_then(|e| e.to_str()).unwrap_or("audio");
        let mut local_path = dest_dir.join(format!("{safe_name}.{ext}"));
        let mut n = 1;
        while local_path.exists() {
            local_path = dest_dir.join(format!("{safe_name} ({n}).{ext}"));
            n += 1;
        }
        if fs::write(&local_path, &bytes).is_err() {
            skipped += 1;
            continue;
        }

        // Les métadonnées viennent du manifeste (fiables : celles de la bibliothèque d'origine),
        // pas d'une relecture des étiquettes du fichier copié, qui se rabattrait sur le nom de
        // fichier local (différent de l'original) si elles manquent.
        let track_id = library::track_id_for_path(&local_path);
        let already_known = state.library.lock().unwrap().iter().any(|t| t.id == track_id);
        if !already_known {
            let track = Track {
                id: track_id.clone(),
                path: local_path.to_string_lossy().to_string(),
                title: entry.title.clone(),
                artist: entry.artist.clone(),
                album: entry.album.clone(),
                album_artist: entry.album_artist.clone(),
                track_no: entry.track_no,
                disc_no: entry.disc_no,
                year: entry.year,
                genre: entry.genre.clone(),
                duration_secs: entry.duration_secs,
                has_cover: entry.has_cover,
                added_secs: library::modified_secs(&local_path),
                damage: None,
            };
            state.library.lock().unwrap().push(track);
        }
        imported_ids.push(track_id);
    }

    if imported_ids.is_empty() {
        return Err("Aucune piste n'a pu être importée depuis cette archive.".to_string());
    }

    if let Some(root) = state.library_root.lock().unwrap().clone() {
        let tracks = state.library.lock().unwrap().clone();
        let _ = library::save_cache(&state.library_cache_path(), &root, &tracks);
    }

    let playlist_id = if manifest.kind == "playlist" {
        let mut store = state.playlists.lock().unwrap();
        let id = store.create(manifest.name.clone(), manifest.theme.clone());
        let _ = store.add_tracks(&id, imported_ids.clone());
        let _ = store.save(&state.playlists_path());
        Some(id)
    } else {
        None
    };

    Ok(ImportResult {
        name: manifest.name,
        kind: manifest.kind,
        added_tracks: imported_ids.len(),
        skipped_tracks: skipped,
        playlist_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::playlists::PlaylistStore;

    fn make_state(data_dir: &Path) -> AppState {
        AppState::new(data_dir.to_path_buf())
    }

    fn write_audio(dir: &Path, name: &str) -> String {
        let path = dir.join(name);
        // Contenu factice : les tests ne décodent jamais l'audio, juste les octets.
        fs::write(&path, b"fausses donnees audio").unwrap();
        path.to_string_lossy().to_string()
    }

    fn track_at(path: String, title: &str, artist: &str) -> Track {
        Track {
            id: library::track_id_for_path(Path::new(&path)),
            path,
            title: title.to_string(),
            artist: artist.to_string(),
            album: "Album".to_string(),
            album_artist: artist.to_string(),
            track_no: Some(1),
            disc_no: None,
            year: None,
            genre: None,
            duration_secs: 120.0,
            has_cover: false,
            added_secs: 0,
            damage: None,
        }
    }

    #[test]
    fn export_then_import_single_track_roundtrip() {
        let source_dir = tempfile::tempdir().unwrap();
        let path = write_audio(source_dir.path(), "chanson.mp3");
        let track = track_at(path, "Une chanson", "Une artiste");

        let state_dir = tempfile::tempdir().unwrap();
        let state = make_state(state_dir.path());
        *state.library.lock().unwrap() = vec![track.clone()];

        let bundle_dir = tempfile::tempdir().unwrap();
        let bundle_path = bundle_dir.path().join("partage.mpshare");
        export_track(&state, &bundle_path, &track.id).unwrap();
        assert!(bundle_path.exists());

        // Importé dans un autre état, comme sur un autre appareil.
        let other_dir = tempfile::tempdir().unwrap();
        let other_state = make_state(other_dir.path());
        let result = import_bundle(&other_state, &bundle_path).unwrap();
        assert_eq!(result.added_tracks, 1);
        assert_eq!(result.skipped_tracks, 0);
        assert_eq!(result.kind, "track");
        assert!(result.playlist_id.is_none());
        assert_eq!(other_state.library.lock().unwrap().len(), 1);
        assert_eq!(other_state.library.lock().unwrap()[0].title, "Une chanson");
    }

    #[test]
    fn export_then_import_playlist_recreates_it() {
        let source_dir = tempfile::tempdir().unwrap();
        let p1 = write_audio(source_dir.path(), "un.mp3");
        let p2 = write_audio(source_dir.path(), "deux.mp3");
        let t1 = track_at(p1, "Un", "Artiste");
        let t2 = track_at(p2, "Deux", "Artiste");

        let state_dir = tempfile::tempdir().unwrap();
        let state = make_state(state_dir.path());
        *state.library.lock().unwrap() = vec![t1.clone(), t2.clone()];
        {
            let mut store = PlaylistStore::default();
            let id = store.create("Ma Playlist".to_string(), Some("ocean".to_string()));
            store.add_tracks(&id, vec![t1.id.clone(), t2.id.clone()]).unwrap();
            *state.playlists.lock().unwrap() = store;
        }

        let bundle_dir = tempfile::tempdir().unwrap();
        let bundle_path = bundle_dir.path().join("playlist.mpshare");
        let playlist_id = state.playlists.lock().unwrap().playlists[0].id.clone();
        export_playlist(&state, &bundle_path, &playlist_id).unwrap();

        let other_dir = tempfile::tempdir().unwrap();
        let other_state = make_state(other_dir.path());
        let result = import_bundle(&other_state, &bundle_path).unwrap();
        assert_eq!(result.added_tracks, 2);
        assert_eq!(result.kind, "playlist");
        assert_eq!(result.name, "Ma Playlist");
        let new_id = result.playlist_id.unwrap();
        let store = other_state.playlists.lock().unwrap();
        let playlist = store.get(&new_id).unwrap();
        assert_eq!(playlist.name, "Ma Playlist");
        assert_eq!(playlist.theme, "ocean");
        assert_eq!(playlist.track_ids.len(), 2);
    }

    #[test]
    fn received_playlist_keeps_same_tagged_files_and_survives_a_rescan() {
        // Deux fichiers distincts aux mêmes étiquettes (fréquent) : la playlist reçue garde
        // les deux, et un nouveau scan de la bibliothèque ne perd pas les morceaux reçus.
        let source_dir = tempfile::tempdir().unwrap();
        let t1 = track_at(write_audio(source_dir.path(), "un.mp3"), "Même titre", "Artiste");
        let t2 = track_at(write_audio(source_dir.path(), "deux.mp3"), "Même titre", "Artiste");
        let state_dir = tempfile::tempdir().unwrap();
        let state = make_state(state_dir.path());
        *state.library.lock().unwrap() = vec![t1.clone(), t2.clone()];
        let playlist_id = state.playlists.lock().unwrap().create("J-Pop".to_string(), None);
        state.playlists.lock().unwrap().add_tracks(&playlist_id, vec![t1.id.clone(), t2.id.clone()]).unwrap();
        let bundle_dir = tempfile::tempdir().unwrap();
        let bundle_path = bundle_dir.path().join("playlist.mpshare");
        export_playlist(&state, &bundle_path, &playlist_id).unwrap();

        let other_dir = tempfile::tempdir().unwrap();
        let other_state = make_state(other_dir.path());
        let result = import_bundle(&other_state, &bundle_path).unwrap();
        let ids = other_state.playlists.lock().unwrap().get(&result.playlist_id.unwrap()).unwrap().track_ids.clone();
        assert_eq!(ids.len(), 2);

        // Rescan d'un dossier de musique sans rapport : les morceaux reçus restent.
        let music = tempfile::tempdir().unwrap();
        let previous = other_state.library.lock().unwrap().clone();
        let rescanned =
            library::scan_library_with_extras(music.path(), &[imports_dir(other_dir.path())], &previous, |_, _| {});
        for id in &ids {
            assert!(rescanned.iter().any(|t| &t.id == id), "morceau reçu perdu au rescan");
        }
    }

    #[test]
    fn export_empty_playlist_fails() {
        let state_dir = tempfile::tempdir().unwrap();
        let state = make_state(state_dir.path());
        let id = state.playlists.lock().unwrap().create("Vide".to_string(), None);

        let bundle_dir = tempfile::tempdir().unwrap();
        let bundle_path = bundle_dir.path().join("vide.mpshare");
        assert!(export_playlist(&state, &bundle_path, &id).is_err());
    }

    #[test]
    fn importing_the_same_bundle_twice_does_not_duplicate_tracks() {
        let source_dir = tempfile::tempdir().unwrap();
        let path = write_audio(source_dir.path(), "chanson.mp3");
        let track = track_at(path, "Une chanson", "Une artiste");

        let state_dir = tempfile::tempdir().unwrap();
        let state = make_state(state_dir.path());
        *state.library.lock().unwrap() = vec![track.clone()];

        let bundle_dir = tempfile::tempdir().unwrap();
        let bundle_path = bundle_dir.path().join("partage.mpshare");
        export_track(&state, &bundle_path, &track.id).unwrap();

        let other_dir = tempfile::tempdir().unwrap();
        let other_state = make_state(other_dir.path());
        import_bundle(&other_state, &bundle_path).unwrap();
        import_bundle(&other_state, &bundle_path).unwrap();
        assert_eq!(other_state.library.lock().unwrap().len(), 1);
    }

    #[test]
    fn importing_a_non_archive_file_fails_cleanly() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pas-une-archive.mpshare");
        fs::write(&path, b"ceci n'est pas un zip").unwrap();
        let state = make_state(dir.path());
        assert!(import_bundle(&state, &path).is_err());
    }
}
