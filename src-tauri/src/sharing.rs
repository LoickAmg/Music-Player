//! Partage de sons ou de playlists entre appareils ou utilisateurs : une archive
//! `.mpshare` (zip) qui embarque les fichiers audio avec leurs métadonnées essentielles,
//! à exporter depuis un appareil puis importer sur un autre (fichier transmis par
//! messagerie, câble, Bluetooth… ou la feuille de partage du système sur Android).

use crate::state::Locked;
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
/// Manifeste d'une archive : largement assez pour des milliers de morceaux.
const MAX_MANIFEST: u64 = 8 * 1024 * 1024;

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
    /// Morceaux de l'archive dans la bibliothèque de cet appareil (« Reçus récemment »).
    pub track_ids: Vec<String>,
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

        // Recopié par morceaux du disque vers l'archive : jamais le fichier entier en mémoire
        // (un FLAC dépasse facilement 50 Mo).
        let mut audio = fs::File::open(source)
            .map_err(|e| format!("Lecture de « {} » impossible : {e}", track.title))?;
        zip.start_file(format!("pistes/{filename}"), options)
            .map_err(|e| e.to_string())?;
        std::io::copy(&mut audio, &mut zip).map_err(|e| format!("Lecture de « {} » impossible : {e}", track.title))?;

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

/// Exporte plusieurs morceaux d'un coup (copie vers un autre de mes appareils). Ceux qui ne
/// sont plus dans la bibliothèque sont ignorés.
pub fn export_tracks(state: &AppState, dest: &Path, name: &str, track_ids: &[String]) -> Result<usize, String> {
    let tracks: Vec<Track> = {
        let library = state.library.locked();
        track_ids.iter().filter_map(|id| library.iter().find(|t| &t.id == id).cloned()).collect()
    };
    if tracks.is_empty() {
        return Err("Aucun de ces morceaux n'est encore sur cet appareil.".to_string());
    }
    write_bundle(dest, "track", name, None, &tracks)?;
    Ok(tracks.len())
}

/// Envoi par cycles : une partie d'archive ne dépasse ni ce poids ni ce nombre de morceaux
/// (comme la copie entre mes appareils, lib/devices.ts).
pub const PART_BYTES: u64 = 150 * 1024 * 1024;
pub const PART_TRACKS: usize = 40;

/// Morceaux d'une playlist (encore dans la bibliothèque) découpés en parties : nom, thème,
/// parties. Un morceau plus lourd qu'une partie forme une partie à lui seul.
/// Playlist prête pour l'envoi par cycles : nom, thème, parties.
pub type PlaylistParts = (String, Option<String>, Vec<Vec<Track>>);

pub fn playlist_parts(state: &AppState, playlist_id: &str) -> Result<PlaylistParts, String> {
    let (name, theme, ids) = {
        let store = state.playlists.locked();
        let playlist = store.get(playlist_id).ok_or("Playlist introuvable.")?;
        (playlist.name.clone(), Some(playlist.theme.clone()), playlist.track_ids.clone())
    };
    let tracks: Vec<Track> = {
        let library = state.library.locked();
        ids.iter().filter_map(|id| library.iter().find(|t| &t.id == id).cloned()).collect()
    };
    if tracks.is_empty() {
        return Err("Cette playlist est vide (ou ses morceaux ne sont plus dans la bibliothèque).".to_string());
    }
    Ok((name, theme, split_parts(tracks, |t| fs::metadata(&t.path).map(|m| m.len()).unwrap_or(0))))
}

fn split_parts(tracks: Vec<Track>, size_of: impl Fn(&Track) -> u64) -> Vec<Vec<Track>> {
    let mut parts: Vec<Vec<Track>> = Vec::new();
    let mut current: Vec<Track> = Vec::new();
    let mut bytes = 0u64;
    for track in tracks {
        let size = size_of(&track);
        if !current.is_empty() && (current.len() >= PART_TRACKS || bytes + size > PART_BYTES) {
            parts.push(std::mem::take(&mut current));
            bytes = 0;
        }
        bytes += size;
        current.push(track);
    }
    if !current.is_empty() {
        parts.push(current);
    }
    parts
}

/// Exporte une partie de playlist (envoi par cycles).
pub fn export_playlist_part(dest: &Path, name: &str, theme: Option<String>, tracks: &[Track]) -> Result<(), String> {
    write_bundle(dest, "playlist", name, theme, tracks)
}

/// Exporte une playlist entière (ses morceaux encore présents dans la bibliothèque).
pub fn export_playlist(state: &AppState, dest: &Path, playlist_id: &str) -> Result<(), String> {
    // Un verrou à la fois : tenir celui des playlists en prenant celui de la bibliothèque pourrait
    // bloquer l'appli face à la suppression des doublons, qui les prend dans l'autre ordre.
    let (name, theme, ids) = {
        let store = state.playlists.locked();
        let playlist = store.get(playlist_id).ok_or("Playlist introuvable.")?;
        (playlist.name.clone(), Some(playlist.theme.clone()), playlist.track_ids.clone())
    };
    let tracks: Vec<Track> = {
        let library = state.library.locked();
        ids.iter().filter_map(|id| library.iter().find(|t| &t.id == id).cloned()).collect()
    };
    if tracks.is_empty() {
        return Err("Cette playlist est vide (ou ses morceaux ne sont plus dans la bibliothèque).".to_string());
    }
    write_bundle(dest, "playlist", &name, theme, &tracks)
}

/// Ancien dossier des morceaux reçus (privé, invisible hors de l'appli) : repli quand le
/// dossier visible n'est pas accessible, et parcouru par le scan.
pub fn imports_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("importes")
}

/// Dossier « Musique » public de l'appareil. Android : celui du stockage partagé (le dossier
/// « Music » propre à l'appli, que donne Tauri, est invisible des autres applis).
pub fn public_music_dir(desktop: Option<PathBuf>) -> Option<PathBuf> {
    if cfg!(target_os = "android") {
        let root = std::env::var_os("EXTERNAL_STORAGE").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/storage/emulated/0"));
        return Some(root.join("Music"));
    }
    desktop
}

/// Dossier des morceaux reçus : « Musique/Music Player/Reçus », visible dans le gestionnaire
/// de fichiers et les autres lecteurs. Repli sur le dossier privé si l'écriture y est refusée
/// (Android 10 sans la permission, par exemple).
pub fn received_dir(state: &AppState) -> PathBuf {
    if let Some(music) = &state.music_dir {
        let dir = music.join("Music Player").join("Reçus");
        if writable(&dir) {
            return dir;
        }
    }
    imports_dir(&state.data_dir)
}

fn writable(dir: &Path) -> bool {
    if fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".ecriture");
    let ok = fs::write(&probe, b"").is_ok();
    let _ = fs::remove_file(&probe);
    ok
}

/// Déplace (ou copie puis efface, d'un stockage à l'autre) un fichier vers `dir`, sous un nom
/// libre ; renvoie son nouveau chemin.
fn move_into(source: &Path, dir: &Path) -> std::io::Result<PathBuf> {
    let stem = source.file_stem().and_then(|s| s.to_str()).unwrap_or("Morceau").to_string();
    let ext = source.extension().and_then(|e| e.to_str()).unwrap_or("audio").to_string();
    let mut dest = dir.join(format!("{stem}.{ext}"));
    let mut n = 1;
    while dest.exists() {
        dest = dir.join(format!("{stem} ({n}).{ext}"));
        n += 1;
    }
    if fs::rename(source, &dest).is_err() {
        fs::copy(source, &dest)?;
        fs::remove_file(source)?;
    }
    Ok(dest)
}

/// Identifiants changés au démarrage, repris une fois par l'interface (« Reçus récemment »).
static MOVED: std::sync::Mutex<Vec<(String, String)>> = std::sync::Mutex::new(Vec::new());

pub fn remember_moved(moved: Vec<(String, String)>) {
    MOVED.locked().extend(moved);
}

pub fn take_moved() -> Vec<(String, String)> {
    std::mem::take(&mut *MOVED.locked())
}

/// Range dans le dossier visible les morceaux reçus avant la 0.5.16 (dossier privé). Les
/// identifiants (tirés du chemin) changent : playlists et titres aimés sont mis à jour.
/// Renvoie les paires (ancien identifiant, nouveau).
pub fn move_received(state: &AppState) -> Vec<(String, String)> {
    let old_dir = imports_dir(&state.data_dir);
    let new_dir = received_dir(state);
    if new_dir == old_dir || !old_dir.is_dir() {
        return Vec::new();
    }
    let Ok(entries) = fs::read_dir(&old_dir) else { return Vec::new() };
    let mut moved = Vec::new();
    {
        let mut library = state.library.locked();
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() || !library::is_supported(&path) {
                continue;
            }
            let Ok(dest) = move_into(&path, &new_dir) else { continue };
            let old_id = library::track_id_for_path(&path);
            let new_id = library::track_id_for_path(&dest);
            if let Some(track) = library.iter_mut().find(|t| t.id == old_id) {
                track.id = new_id.clone();
                track.path = dest.to_string_lossy().to_string();
            }
            moved.push((old_id, new_id));
        }
    }
    if moved.is_empty() {
        return moved;
    }
    let rename = |id: &mut String| {
        if let Some((_, new)) = moved.iter().find(|(old, _)| old == id) {
            *id = new.clone();
        }
    };
    {
        let mut playlists = state.playlists.locked();
        for p in playlists.playlists.iter_mut() {
            p.track_ids.iter_mut().for_each(rename);
        }
        let _ = playlists.save(&state.playlists_path());
    }
    {
        let mut favorites = state.favorites.locked();
        let ids: Vec<String> = favorites.track_ids.iter().cloned().collect();
        for mut id in ids {
            let before = id.clone();
            rename(&mut id);
            if id != before {
                favorites.track_ids.remove(&before);
                favorites.track_ids.insert(id);
            }
        }
        let _ = favorites.save(&state.favorites_path());
    }
    if let Some(root) = state.library_root.locked().clone() {
        let tracks = state.library.locked().clone();
        let _ = library::save_cache(&state.library_cache_path(), &root, &tracks);
    }
    let _ = fs::remove_dir(&old_dir);
    moved
}

/// Importe une archive de partage : copie les fichiers audio dans un dossier dédié du
/// dossier de données de l'appli, les ajoute à la bibliothèque, et recrée la playlist
/// si l'archive en contenait une.
pub fn import_bundle(state: &AppState, source: &Path) -> Result<ImportResult, String> {
    import_bundle_into(state, source, None)
}

/// Comme `import_bundle`, mais une playlist reçue en plusieurs parties (envoi par cycles)
/// complète la playlist déjà créée par la première partie (`into`) au lieu d'en créer une.
pub fn import_bundle_into(state: &AppState, source: &Path, into: Option<&str>) -> Result<ImportResult, String> {
    let file = fs::File::open(source).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|_| "Ce fichier n'est pas une archive de partage valide.".to_string())?;

    let manifest: Manifest = {
        let mut entry = archive
            .by_name("manifest.json")
            .map_err(|_| "Archive de partage invalide (manifeste manquant).".to_string())?;
        let mut content = String::new();
        entry.by_ref().take(MAX_MANIFEST).read_to_string(&mut content).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).map_err(|e| e.to_string())?
    };
    drop(archive);
    // Réouverture : `by_name` emprunte l'archive, la boucle ci-dessous doit la reprendre en entier.
    let file = fs::File::open(source).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

    // Dossier où les morceaux importés sont enregistrés (persistant, parcouru à chaque scan).
    let dest_dir = received_dir(state);
    fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;

    let mut imported_ids = Vec::new();
    let mut skipped = 0usize;
    // Morceaux déjà là avant cet import : deux fichiers distincts de l'archive aux mêmes
    // étiquettes (fréquent) ne sont jamais fusionnés entre eux.
    let before: Vec<(String, String, String, f64, String)> = state
        .library
        .locked()
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

        // Seuls des fichiers audio entrent dans la bibliothèque, quoi que dise l'archive.
        if !library::is_supported(Path::new(&entry.file)) {
            skipped += 1;
            continue;
        }
        let Ok(mut zip_file) = archive.by_name(&format!("pistes/{}", entry.file)) else {
            skipped += 1;
            continue;
        };

        let safe_name = sanitize_filename(&format!("{} - {}", entry.artist, entry.title));
        let ext = Path::new(&entry.file).extension().and_then(|e| e.to_str()).unwrap_or("audio");
        let mut local_path = dest_dir.join(format!("{safe_name}.{ext}"));
        let mut n = 1;
        while local_path.exists() {
            local_path = dest_dir.join(format!("{safe_name} ({n}).{ext}"));
            n += 1;
        }
        let written = fs::File::create(&local_path).and_then(|mut out| std::io::copy(&mut zip_file.by_ref().take(crate::transfer::MAX_SIZE), &mut out));
        drop(zip_file);
        if written.is_err() {
            let _ = fs::remove_file(&local_path);
            skipped += 1;
            continue;
        }

        // Les métadonnées viennent du manifeste (fiables : celles de la bibliothèque d'origine),
        // pas d'une relecture des étiquettes du fichier copié, qui se rabattrait sur le nom de
        // fichier local (différent de l'original) si elles manquent.
        let track_id = library::track_id_for_path(&local_path);
        let already_known = state.library.locked().iter().any(|t| t.id == track_id);
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
            state.library.locked().push(track);
        }
        imported_ids.push(track_id);
    }

    if imported_ids.is_empty() {
        return Err("Aucune piste n'a pu être importée depuis cette archive.".to_string());
    }

    if let Some(root) = state.library_root.locked().clone() {
        let tracks = state.library.locked().clone();
        let _ = library::save_cache(&state.library_cache_path(), &root, &tracks);
    }

    let playlist_id = if manifest.kind == "playlist" {
        let mut store = state.playlists.locked();
        let existing = into.filter(|id| store.get(id).is_some()).map(str::to_string);
        let id = existing.unwrap_or_else(|| store.create(manifest.name.clone(), manifest.theme.clone()));
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
        track_ids: imported_ids,
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
    fn received_tracks_move_to_the_visible_folder_and_keep_their_playlists() {
        let data = tempfile::tempdir().unwrap();
        let music = tempfile::tempdir().unwrap();
        let mut state = make_state(data.path());
        // Avant la 0.5.16 : le morceau reçu est caché dans le dossier privé.
        let old_dir = imports_dir(data.path());
        fs::create_dir_all(&old_dir).unwrap();
        let track = track_at(write_audio(&old_dir, "A - Lemon.mp3"), "Lemon", "A");
        let old_id = track.id.clone();
        state.library.locked().push(track);
        let pl = state.playlists.locked().create("Funk".into(), None);
        state.playlists.locked().add_track(&pl, old_id.clone()).unwrap();
        state.favorites.locked().toggle(&old_id);

        state.music_dir = Some(music.path().to_path_buf());
        let moved = move_received(&state);

        let visible = music.path().join("Music Player").join("Reçus").join("A - Lemon.mp3");
        assert!(visible.is_file(), "le fichier est dans Musique/Music Player/Reçus");
        assert!(!old_dir.exists(), "l'ancien dossier privé est vidé puis retiré");
        let new_id = library::track_id_for_path(&visible);
        assert_eq!(moved, vec![(old_id.clone(), new_id.clone())]);
        assert_eq!(state.library.locked()[0].path, visible.to_string_lossy());
        assert_eq!(state.playlists.locked().get(&pl).unwrap().track_ids, vec![new_id.clone()]);
        assert!(state.favorites.locked().is_favorite(&new_id));
        assert!(!state.favorites.locked().is_favorite(&old_id));
        // Deuxième lancement : plus rien à déplacer.
        assert!(move_received(&state).is_empty());
    }

    #[test]
    fn without_a_visible_folder_received_tracks_stay_private() {
        let data = tempfile::tempdir().unwrap();
        let state = make_state(data.path());
        assert_eq!(received_dir(&state), imports_dir(data.path()));
        assert!(move_received(&state).is_empty());
    }

    #[test]
    fn an_archive_only_brings_audio_files() {
        let dir = tempfile::tempdir().unwrap();
        let state = make_state(dir.path());
        let archive = dir.path().join("piege.mpshare");
        let entry = |file: &str, title: &str| {
            serde_json::json!({
                "title": title, "artist": "A", "album": "B", "album_artist": "A", "track_no": null, "disc_no": null,
                "year": null, "genre": null, "duration_secs": 10.0, "has_cover": false, "file": file,
            })
        };
        let manifest = serde_json::json!({
            "kind": "track",
            "name": "Piège",
            "tracks": [entry("virus.exe", "Virus"), entry("vrai.mp3", "Vrai")],
        });
        let mut zip = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
        let options = SimpleFileOptions::default();
        for (name, content) in [("pistes/virus.exe", b"MZ".as_slice()), ("pistes/vrai.mp3", b"son".as_slice())] {
            zip.start_file(name, options).unwrap();
            zip.write_all(content).unwrap();
        }
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(manifest.to_string().as_bytes()).unwrap();
        zip.finish().unwrap();

        let result = import_bundle(&state, &archive).unwrap();
        assert_eq!(result.added_tracks, 1);
        assert_eq!(result.skipped_tracks, 1);
        assert_eq!(result.track_ids.len(), 1);
        let names: Vec<String> = fs::read_dir(imports_dir(dir.path())).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        assert_eq!(names.len(), 1);
        assert!(names[0].ends_with(".mp3"));
    }

    #[test]
    fn export_then_import_single_track_roundtrip() {
        let source_dir = tempfile::tempdir().unwrap();
        let path = write_audio(source_dir.path(), "chanson.mp3");
        let track = track_at(path, "Une chanson", "Une artiste");

        let state_dir = tempfile::tempdir().unwrap();
        let state = make_state(state_dir.path());
        *state.library.locked() = vec![track.clone()];

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
        assert_eq!(other_state.library.locked().len(), 1);
        assert_eq!(other_state.library.locked()[0].title, "Une chanson");
    }

    #[test]
    fn playlist_is_split_into_parts_by_weight_and_count() {
        let tracks: Vec<Track> = (0..90).map(|i| track_at(format!("/x/{i}.mp3"), &format!("T{i}"), "A")).collect();
        // 90 petits morceaux : 40 + 40 + 10.
        let parts = super::split_parts(tracks.clone(), |_| 1_000_000);
        assert_eq!(parts.iter().map(Vec::len).collect::<Vec<_>>(), vec![40, 40, 10]);
        // Morceaux de 60 Mo : 2 par partie (150 Mo au plus), un morceau énorme reste seul.
        let parts = super::split_parts(tracks[..5].to_vec(), |t| if t.title == "T2" { 400 * 1024 * 1024 } else { 60 * 1024 * 1024 });
        assert_eq!(parts.iter().map(Vec::len).collect::<Vec<_>>(), vec![2, 1, 2]);
        assert_eq!(parts.iter().flatten().count(), 5, "aucun morceau perdu");
    }

    #[test]
    fn a_later_part_completes_the_playlist_of_the_first() {
        let source_dir = tempfile::tempdir().unwrap();
        let t1 = track_at(write_audio(source_dir.path(), "un.mp3"), "Un", "Artiste");
        let t2 = track_at(write_audio(source_dir.path(), "deux.mp3"), "Deux", "Artiste");
        let bundles = tempfile::tempdir().unwrap();
        let (a, b) = (bundles.path().join("1.mpshare"), bundles.path().join("2.mpshare"));
        super::export_playlist_part(&a, "Grosse", Some("ocean".into()), std::slice::from_ref(&t1)).unwrap();
        super::export_playlist_part(&b, "Grosse", Some("ocean".into()), std::slice::from_ref(&t2)).unwrap();
        let other_dir = tempfile::tempdir().unwrap();
        let other = make_state(other_dir.path());
        let first = super::import_bundle_into(&other, &a, None).unwrap();
        let id = first.playlist_id.clone().unwrap();
        let second = super::import_bundle_into(&other, &b, Some(&id)).unwrap();
        assert_eq!(second.playlist_id.as_deref(), Some(id.as_str()));
        let store = other.playlists.locked();
        assert_eq!(store.playlists.len(), 1, "une seule playlist");
        assert_eq!(store.get(&id).unwrap().track_ids.len(), 2);
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
        *state.library.locked() = vec![t1.clone(), t2.clone()];
        {
            let mut store = PlaylistStore::default();
            let id = store.create("Ma Playlist".to_string(), Some("ocean".to_string()));
            store.add_tracks(&id, vec![t1.id.clone(), t2.id.clone()]).unwrap();
            *state.playlists.locked() = store;
        }

        let bundle_dir = tempfile::tempdir().unwrap();
        let bundle_path = bundle_dir.path().join("playlist.mpshare");
        let playlist_id = state.playlists.locked().playlists[0].id.clone();
        export_playlist(&state, &bundle_path, &playlist_id).unwrap();

        let other_dir = tempfile::tempdir().unwrap();
        let other_state = make_state(other_dir.path());
        let result = import_bundle(&other_state, &bundle_path).unwrap();
        assert_eq!(result.added_tracks, 2);
        assert_eq!(result.kind, "playlist");
        assert_eq!(result.name, "Ma Playlist");
        let new_id = result.playlist_id.unwrap();
        let store = other_state.playlists.locked();
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
        *state.library.locked() = vec![t1.clone(), t2.clone()];
        let playlist_id = state.playlists.locked().create("J-Pop".to_string(), None);
        state.playlists.locked().add_tracks(&playlist_id, vec![t1.id.clone(), t2.id.clone()]).unwrap();
        let bundle_dir = tempfile::tempdir().unwrap();
        let bundle_path = bundle_dir.path().join("playlist.mpshare");
        export_playlist(&state, &bundle_path, &playlist_id).unwrap();

        let other_dir = tempfile::tempdir().unwrap();
        let other_state = make_state(other_dir.path());
        let result = import_bundle(&other_state, &bundle_path).unwrap();
        let ids = other_state.playlists.locked().get(&result.playlist_id.unwrap()).unwrap().track_ids.clone();
        assert_eq!(ids.len(), 2);

        // Rescan d'un dossier de musique sans rapport : les morceaux reçus restent.
        let music = tempfile::tempdir().unwrap();
        let previous = other_state.library.locked().clone();
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
        let id = state.playlists.locked().create("Vide".to_string(), None);

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
        *state.library.locked() = vec![track.clone()];

        let bundle_dir = tempfile::tempdir().unwrap();
        let bundle_path = bundle_dir.path().join("partage.mpshare");
        export_track(&state, &bundle_path, &track.id).unwrap();

        let other_dir = tempfile::tempdir().unwrap();
        let other_state = make_state(other_dir.path());
        import_bundle(&other_state, &bundle_path).unwrap();
        import_bundle(&other_state, &bundle_path).unwrap();
        assert_eq!(other_state.library.locked().len(), 1);
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
