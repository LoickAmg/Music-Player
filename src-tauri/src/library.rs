//! Bibliothèque musicale locale : scan parallèle d'un dossier, métadonnées via `lofty`
//! (lecture tolérante), cache sur disque pour un démarrage instantané, et pochettes
//! (embarquées ou `cover.jpg` du dossier) extraites en fichiers servis à l'interface.

use lofty::config::{ParseOptions, ParsingMode};
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::{Accessor, ItemKey};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::UNIX_EPOCH;
use uuid::Uuid;
use walkdir::WalkDir;

use crate::ffmpeg;

pub const UNKNOWN_ARTIST: &str = "Artiste inconnu";
pub const UNKNOWN_ALBUM: &str = "Album inconnu";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Track {
    /// Identifiant stable dérivé du chemin : les playlists survivent à un nouveau scan.
    pub id: String,
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// Artiste de l'album (pour regrouper les compilations), sinon l'artiste de la piste.
    #[serde(default)]
    pub album_artist: String,
    pub track_no: Option<u32>,
    #[serde(default)]
    pub disc_no: Option<u32>,
    #[serde(default)]
    pub year: Option<u32>,
    #[serde(default)]
    pub genre: Option<String>,
    pub duration_secs: f64,
    pub has_cover: bool,
    /// Date de dernière modification du fichier (secondes Unix) : sert aux « Ajouts récents ».
    #[serde(default)]
    pub added_secs: u64,
}

const NAMESPACE: Uuid = Uuid::from_bytes([
    0x6c, 0x8b, 0x3f, 0x21, 0x9d, 0x4a, 0x4b, 0x8e, 0xae, 0x53, 0x0e, 0x2d, 0x1f, 0x77, 0x4c, 0x90,
]);

pub fn track_id_for_path(path: &Path) -> String {
    Uuid::new_v5(&NAMESPACE, path.to_string_lossy().as_bytes()).to_string()
}

fn is_supported(path: &Path) -> bool {
    ffmpeg::is_native(path) || ffmpeg::needs_ffmpeg(path)
}

/// Lecture tolérante : beaucoup de fichiers réels ont des étiquettes imparfaites (une date
/// ID3 mal formée suffisait à faire rejeter un fichier entier en mode strict).
fn read_tagged(path: &Path, read_tags: bool) -> Option<lofty::file::TaggedFile> {
    let options = ParseOptions::new()
        .parsing_mode(ParsingMode::Relaxed)
        .read_tags(read_tags);
    Probe::open(path).ok()?.options(options).read().ok()
}

fn modified_secs(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn file_stem(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Piste inconnue".to_string())
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// Lit les métadonnées d'un fichier audio. `None` seulement si l'extension n'est pas un
/// format audio : un fichier aux étiquettes illisibles reste listé (ffprobe, sinon nom).
pub fn read_track(path: &Path) -> Option<Track> {
    read_track_with_folder_cover(path, false)
}

fn read_track_with_folder_cover(path: &Path, folder_has_cover: bool) -> Option<Track> {
    if !is_supported(path) {
        return None;
    }
    let Some(tagged_file) = read_tagged(path, true).or_else(|| read_tagged(path, false)) else {
        let mut track = track_from_probe(path);
        track.has_cover = folder_has_cover;
        return Some(track);
    };
    let duration_secs = tagged_file.properties().duration().as_secs_f64();
    let tag = tagged_file.primary_tag().or_else(|| tagged_file.first_tag());

    let title = non_empty(tag.and_then(|t| t.title().map(|s| s.to_string())));
    let artist = non_empty(tag.and_then(|t| t.artist().map(|s| s.to_string())));
    let album = non_empty(tag.and_then(|t| t.album().map(|s| s.to_string())));
    let album_artist =
        non_empty(tag.and_then(|t| t.get_string(ItemKey::AlbumArtist).map(str::to_string)));
    let genre = non_empty(tag.and_then(|t| t.genre().map(|s| s.to_string())));
    let year = tag
        .and_then(|t| t.date())
        .map(|d| u32::from(d.year))
        .filter(|y| *y > 0);
    let embedded_cover = tag.is_some_and(|t| !t.pictures().is_empty());

    let artist = artist.unwrap_or_else(|| UNKNOWN_ARTIST.to_string());
    Some(Track {
        id: track_id_for_path(path),
        path: path.to_string_lossy().to_string(),
        title: title.unwrap_or_else(|| file_stem(path)),
        album_artist: album_artist.unwrap_or_else(|| artist.clone()),
        artist,
        album: album.unwrap_or_else(|| UNKNOWN_ALBUM.to_string()),
        track_no: tag.and_then(|t| t.track()),
        disc_no: tag.and_then(|t| t.disk()),
        year,
        genre,
        duration_secs,
        has_cover: embedded_cover || folder_has_cover,
        added_secs: modified_secs(path),
    })
}

/// Images de pochette reconnues dans le dossier d'un album, par ordre de préférence.
const FOLDER_COVER_NAMES: &[&str] = &["cover", "folder", "front", "album", "albumart"];

fn is_image(path: &Path) -> bool {
    matches!(ffmpeg::extension_of(path).as_str(), "jpg" | "jpeg" | "png" | "webp")
}

/// Choisit l'image de pochette d'un dossier parmi ses images (nom conventionnel d'abord,
/// sinon l'unique image présente).
fn pick_folder_cover(images: &[PathBuf]) -> Option<PathBuf> {
    for name in FOLDER_COVER_NAMES {
        if let Some(found) = images.iter().find(|p| {
            p.file_stem()
                .map(|s| s.to_string_lossy().to_lowercase())
                .is_some_and(|s| s == *name || s.starts_with(&format!("{name} ")))
        }) {
            return Some(found.clone());
        }
    }
    (images.len() == 1).then(|| images[0].clone())
}

pub fn folder_cover(dir: &Path) -> Option<PathBuf> {
    let images: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_file() && is_image(p))
        .collect();
    pick_folder_cover(&images)
}

pub fn scan_library(root: &Path) -> Vec<Track> {
    scan_library_with_progress(root, |_, _| {})
}

/// Parcourt `root` et lit toutes les pistes en parallèle. `on_progress(fait, total)` est
/// appelé régulièrement pour afficher l'avancement.
pub fn scan_library_with_progress(root: &Path, on_progress: impl Fn(usize, usize) + Sync) -> Vec<Track> {
    let mut audio_files = Vec::new();
    let mut images_by_dir: HashMap<PathBuf, Vec<PathBuf>> = HashMap::new();
    for entry in WalkDir::new(root).follow_links(true).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.into_path();
        if is_supported(&path) {
            audio_files.push(path);
        } else if is_image(&path) {
            if let Some(dir) = path.parent() {
                images_by_dir.entry(dir.to_path_buf()).or_default().push(path);
            }
        }
    }
    let covered_dirs: std::collections::HashSet<PathBuf> = images_by_dir
        .iter()
        .filter(|(_, images)| pick_folder_cover(images).is_some())
        .map(|(dir, _)| dir.clone())
        .collect();

    let total = audio_files.len();
    let done = AtomicUsize::new(0);
    on_progress(0, total);
    let mut tracks: Vec<Track> = audio_files
        .par_iter()
        .filter_map(|path| {
            let folder_has_cover = path.parent().is_some_and(|d| covered_dirs.contains(d));
            let track = read_track_with_folder_cover(path, folder_has_cover);
            let n = done.fetch_add(1, Ordering::Relaxed) + 1;
            if n.is_multiple_of(64) || n == total {
                on_progress(n, total);
            }
            track
        })
        .collect();
    tracks.sort_by(|a, b| {
        (a.album_artist.to_lowercase(), a.album.to_lowercase(), a.disc_no, a.track_no, a.title.to_lowercase())
            .cmp(&(b.album_artist.to_lowercase(), b.album.to_lowercase(), b.disc_no, b.track_no, b.title.to_lowercase()))
    });
    tracks
}

/// Piste construite sans lofty : métadonnées de ffprobe si disponible, sinon le nom du fichier.
fn track_from_probe(path: &Path) -> Track {
    let info = ffmpeg::probe(path).unwrap_or_default();
    let artist = info.artist.unwrap_or_else(|| UNKNOWN_ARTIST.to_string());
    Track {
        id: track_id_for_path(path),
        path: path.to_string_lossy().to_string(),
        title: info.title.unwrap_or_else(|| file_stem(path)),
        album_artist: artist.clone(),
        artist,
        album: info.album.unwrap_or_else(|| UNKNOWN_ALBUM.to_string()),
        track_no: info.track_no,
        disc_no: None,
        year: None,
        genre: None,
        duration_secs: info.duration_secs,
        has_cover: false,
        added_secs: modified_secs(path),
    }
}

// ---------------------------------------------------------------- cache

#[derive(Serialize, Deserialize)]
struct LibraryCache {
    root: String,
    tracks: Vec<Track>,
}

pub fn save_cache(file: &Path, root: &str, tracks: &[Track]) -> std::io::Result<()> {
    let json = serde_json::to_vec(&LibraryCache { root: root.to_string(), tracks: tracks.to_vec() })?;
    let tmp = file.with_extension("tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(tmp, file)
}

/// Pistes du dernier scan de `root`, si le cache correspond bien à ce dossier.
pub fn load_cache(file: &Path, root: &str) -> Option<Vec<Track>> {
    let cache: LibraryCache = serde_json::from_slice(&std::fs::read(file).ok()?).ok()?;
    (cache.root == root).then_some(cache.tracks)
}

// ---------------------------------------------------------------- pochettes

/// Écrit la pochette d'une piste (embarquée, sinon celle du dossier) dans `cache_dir` et
/// retourne le chemin du fichier, servi tel quel à l'interface (protocole « asset »).
pub fn cover_file(track_path: &Path, track_id: &str, cache_dir: &Path) -> Option<PathBuf> {
    for ext in ["jpg", "png", "webp"] {
        let cached = cache_dir.join(format!("{track_id}.{ext}"));
        if cached.is_file() {
            return Some(cached);
        }
    }
    std::fs::create_dir_all(cache_dir).ok()?;
    let options = ParseOptions::new().parsing_mode(ParsingMode::Relaxed);
    let embedded = Probe::open(track_path)
        .ok()
        .and_then(|p| p.options(options).read().ok())
        .and_then(|file| {
            let tag = file.primary_tag().or_else(|| file.first_tag())?;
            let picture = tag.pictures().first()?;
            let ext = match picture.mime_type().map(|m| m.as_str()) {
                Some("image/png") => "png",
                Some("image/webp") => "webp",
                _ => "jpg",
            };
            Some((picture.data().to_vec(), ext))
        });
    let (bytes, ext) = match embedded {
        Some(found) => found,
        None => {
            let image = folder_cover(track_path.parent()?)?;
            let ext = match ffmpeg::extension_of(&image).as_str() {
                "png" => "png",
                "webp" => "webp",
                _ => "jpg",
            };
            (std::fs::read(image).ok()?, ext)
        }
    };
    let out = cache_dir.join(format!("{track_id}.{ext}"));
    std::fs::write(&out, bytes).ok()?;
    Some(out)
}

/// Paroles embarquées dans les étiquettes (ID3 USLT, Vorbis LYRICS, MP4 ©lyr…).
pub fn embedded_lyrics(path: &Path) -> Option<String> {
    let options = ParseOptions::new().parsing_mode(ParsingMode::Relaxed);
    let file = Probe::open(path).ok()?.options(options).read().ok()?;
    let tag = file.primary_tag().or_else(|| file.first_tag())?;
    tag.get_string(ItemKey::Lyrics)
        .or_else(|| tag.get_string(ItemKey::UnsyncLyrics))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    fn make_test_wav(dir: &Path, filename: &str, secs: u32) -> PathBuf {
        let path = dir.join(filename);
        let sample_rate = 8000u32;
        let data_size = sample_rate * secs * 2;
        let mut f = fs::File::create(&path).unwrap();
        f.write_all(b"RIFF").unwrap();
        f.write_all(&(36 + data_size).to_le_bytes()).unwrap();
        f.write_all(b"WAVEfmt ").unwrap();
        f.write_all(&16u32.to_le_bytes()).unwrap();
        f.write_all(&1u16.to_le_bytes()).unwrap();
        f.write_all(&1u16.to_le_bytes()).unwrap();
        f.write_all(&sample_rate.to_le_bytes()).unwrap();
        f.write_all(&(sample_rate * 2).to_le_bytes()).unwrap();
        f.write_all(&2u16.to_le_bytes()).unwrap();
        f.write_all(&16u16.to_le_bytes()).unwrap();
        f.write_all(b"data").unwrap();
        f.write_all(&data_size.to_le_bytes()).unwrap();
        f.write_all(&vec![0u8; data_size as usize]).unwrap();
        path
    }

    #[test]
    fn unsupported_extension_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.txt");
        fs::write(&path, b"hello").unwrap();
        assert!(read_track(&path).is_none());
    }

    #[test]
    fn reads_duration_and_falls_back_to_filename_for_title() {
        let dir = tempfile::tempdir().unwrap();
        let path = make_test_wav(dir.path(), "Mon Morceau.wav", 2);
        let track = read_track(&path).expect("le WAV de test doit être lisible");
        assert!(track.duration_secs >= 1.9 && track.duration_secs <= 2.2);
        assert_eq!(track.title, "Mon Morceau");
        assert_eq!(track.artist, UNKNOWN_ARTIST);
        assert_eq!(track.album_artist, UNKNOWN_ARTIST);
        assert!(!track.has_cover);
        assert!(track.added_secs > 0);
    }

    #[test]
    fn formats_needing_ffmpeg_are_listed_even_when_lofty_cannot_read_them() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("High For This.eac3");
        fs::write(&path, b"donnees non lisibles par lofty").unwrap();
        let track = read_track(&path).expect("un format ffmpeg reste listé");
        assert_eq!(track.title, "High For This");
    }

    #[test]
    fn audio_files_with_unreadable_tags_are_still_listed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("casse.mp3");
        fs::write(&path, b"pas un mp3").unwrap();
        let track = read_track(&path).expect("un fichier audio ne doit jamais disparaître du scan");
        assert_eq!(track.title, "casse");
    }

    #[test]
    fn track_id_is_stable_and_unique_per_path() {
        let dir = tempfile::tempdir().unwrap();
        let a = make_test_wav(dir.path(), "a.wav", 1);
        let b = make_test_wav(dir.path(), "b.wav", 1);
        assert_eq!(read_track(&a).unwrap().id, read_track(&a).unwrap().id);
        assert_ne!(read_track(&a).unwrap().id, read_track(&b).unwrap().id);
    }

    #[test]
    fn scan_finds_files_recursively_reports_progress_and_detects_folder_covers() {
        let dir = tempfile::tempdir().unwrap();
        make_test_wav(dir.path(), "root.wav", 1);
        let sub = dir.path().join("Album");
        fs::create_dir(&sub).unwrap();
        make_test_wav(&sub, "nested.wav", 1);
        fs::write(sub.join("cover.jpg"), b"\xFF\xD8\xFFfake").unwrap();
        fs::write(dir.path().join("readme.txt"), b"pas de la musique").unwrap();

        let last = std::sync::Mutex::new((0, 0));
        let tracks = scan_library_with_progress(dir.path(), |d, t| *last.lock().unwrap() = (d, t));
        assert_eq!(tracks.len(), 2);
        assert_eq!(*last.lock().unwrap(), (2, 2));
        let nested = tracks.iter().find(|t| t.title == "nested").unwrap();
        let root = tracks.iter().find(|t| t.title == "root").unwrap();
        assert!(nested.has_cover, "le cover.jpg du dossier compte comme pochette");
        assert!(!root.has_cover);

        let cache_dir = dir.path().join("cache");
        let cover = cover_file(Path::new(&nested.path), &nested.id, &cache_dir).unwrap();
        assert_eq!(fs::read(cover).unwrap(), b"\xFF\xD8\xFFfake");
        assert!(cover_file(Path::new(&root.path), &root.id, &cache_dir).is_none());
    }

    #[test]
    fn folder_cover_prefers_conventional_names() {
        let imgs = vec![PathBuf::from("x/scan.jpg"), PathBuf::from("x/Folder.JPG")];
        assert_eq!(pick_folder_cover(&imgs), Some(PathBuf::from("x/Folder.JPG")));
        let lone = vec![PathBuf::from("x/whatever.png")];
        assert_eq!(pick_folder_cover(&lone), Some(PathBuf::from("x/whatever.png")));
        let many = vec![PathBuf::from("x/a.jpg"), PathBuf::from("x/b.jpg")];
        assert_eq!(pick_folder_cover(&many), None);
    }

    #[test]
    fn cache_round_trips_and_rejects_another_root() {
        let dir = tempfile::tempdir().unwrap();
        let wav = make_test_wav(dir.path(), "a.wav", 1);
        let tracks = vec![read_track(&wav).unwrap()];
        let file = dir.path().join("library.json");
        save_cache(&file, "C:/Musique", &tracks).unwrap();
        assert_eq!(load_cache(&file, "C:/Musique").unwrap().len(), 1);
        assert!(load_cache(&file, "D:/Autre").is_none());
    }
}
