//! Scan d'une bibliothèque musicale locale : parcours récursif d'un
//! dossier, extraction des métadonnées (titre/artiste/album/durée/piste)
//! via `lofty`, et récupération à la demande de la pochette embarquée.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::Accessor;
use serde::{Deserialize, Serialize};
use std::path::Path;
use uuid::Uuid;
use walkdir::WalkDir;

const SUPPORTED_EXTENSIONS: &[&str] = &["mp3", "flac", "ogg", "wav", "m4a", "aac"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Track {
    /// Identifiant stable dérivé du chemin (UUID v4 déterministe via un
    /// espace de nommage maison — deux scans du même fichier donnent le
    /// même id, ce qui permet aux playlists de survivre à un rescan).
    pub id: String,
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub track_no: Option<u32>,
    pub duration_secs: f64,
    pub has_cover: bool,
}

/// Espace de nommage arbitraire (généré une fois) utilisé pour dériver un
/// UUID v5 stable à partir du chemin du fichier.
const NAMESPACE: Uuid = Uuid::from_bytes([
    0x6c, 0x8b, 0x3f, 0x21, 0x9d, 0x4a, 0x4b, 0x8e, 0xae, 0x53, 0x0e, 0x2d, 0x1f, 0x77, 0x4c, 0x90,
]);

pub fn track_id_for_path(path: &Path) -> String {
    Uuid::new_v5(&NAMESPACE, path.to_string_lossy().as_bytes()).to_string()
}

fn is_supported(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|ext| SUPPORTED_EXTENSIONS.contains(&ext.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// Lit les métadonnées d'un fichier audio. Retourne `None` si le fichier
/// n'est pas un format supporté ou ne peut pas être décodé par lofty (le
/// fichier est alors simplement ignoré plutôt que de faire échouer tout
/// le scan).
pub fn read_track(path: &Path) -> Option<Track> {
    if !is_supported(path) {
        return None;
    }
    let tagged_file = Probe::open(path).ok()?.read().ok()?;
    let properties = tagged_file.properties();
    let duration_secs = properties.duration().as_secs_f64();

    let tag = tagged_file
        .primary_tag()
        .or_else(|| tagged_file.first_tag());

    let file_stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Piste inconnue".to_string());

    let (title, artist, album, track_no, has_cover) = match tag {
        Some(tag) => (
            tag.title().map(|s| s.to_string()).unwrap_or(file_stem),
            tag.artist()
                .map(|s| s.to_string())
                .unwrap_or_else(|| "Artiste inconnu".to_string()),
            tag.album()
                .map(|s| s.to_string())
                .unwrap_or_else(|| "Album inconnu".to_string()),
            tag.track(),
            !tag.pictures().is_empty(),
        ),
        None => (
            file_stem,
            "Artiste inconnu".to_string(),
            "Album inconnu".to_string(),
            None,
            false,
        ),
    };

    Some(Track {
        id: track_id_for_path(path),
        path: path.to_string_lossy().to_string(),
        title,
        artist,
        album,
        track_no,
        duration_secs,
        has_cover,
    })
}

/// Parcourt récursivement `root` et retourne toutes les pistes lisibles.
/// Les fichiers illisibles/non supportés sont silencieusement ignorés.
pub fn scan_library(root: &Path) -> Vec<Track> {
    WalkDir::new(root)
        .follow_links(true)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file())
        .filter_map(|entry| read_track(entry.path()))
        .collect()
}

/// Extrait la pochette embarquée d'un fichier, encodée en data URI base64
/// prête à être posée dans un attribut `src` côté frontend.
pub fn cover_data_uri(path: &Path) -> Option<String> {
    let tagged_file = Probe::open(path).ok()?.read().ok()?;
    let tag = tagged_file
        .primary_tag()
        .or_else(|| tagged_file.first_tag())?;
    let picture = tag.pictures().first()?;
    let mime = picture
        .mime_type()
        .map(|m| m.to_string())
        .unwrap_or_else(|| "image/jpeg".to_string());
    let encoded = STANDARD.encode(picture.data());
    Some(format!("data:{mime};base64,{encoded}"))
}

pub fn default_extensions() -> Vec<&'static str> {
    SUPPORTED_EXTENSIONS.to_vec()
}

#[allow(dead_code)]
pub fn is_within(root: &Path, path: &Path) -> bool {
    path.starts_with(root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;
    use std::path::PathBuf;

    /// Génère un WAV mono silencieux de `secs` secondes, avec des tags
    /// posés après coup via lofty (les WAV n'ont pas toujours de tags par
    /// défaut, donc on les ajoute explicitement pour tester l'extraction).
    fn make_test_wav(dir: &Path, filename: &str, secs: u32) -> PathBuf {
        let path = dir.join(filename);
        let sample_rate = 8000u32;
        let num_samples = sample_rate * secs;
        let byte_rate = sample_rate * 2;
        let data_size = num_samples * 2;
        let mut f = fs::File::create(&path).unwrap();
        f.write_all(b"RIFF").unwrap();
        f.write_all(&(36 + data_size).to_le_bytes()).unwrap();
        f.write_all(b"WAVE").unwrap();
        f.write_all(b"fmt ").unwrap();
        f.write_all(&16u32.to_le_bytes()).unwrap(); // chunk size
        f.write_all(&1u16.to_le_bytes()).unwrap(); // PCM
        f.write_all(&1u16.to_le_bytes()).unwrap(); // mono
        f.write_all(&sample_rate.to_le_bytes()).unwrap();
        f.write_all(&byte_rate.to_le_bytes()).unwrap();
        f.write_all(&2u16.to_le_bytes()).unwrap(); // block align
        f.write_all(&16u16.to_le_bytes()).unwrap(); // bits per sample
        f.write_all(b"data").unwrap();
        f.write_all(&data_size.to_le_bytes()).unwrap();
        f.write_all(&vec![0u8; data_size as usize]).unwrap();
        drop(f);
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
        // Un WAV brut sans tag ID3 retombe sur le nom de fichier.
        assert_eq!(track.title, "Mon Morceau");
        assert_eq!(track.artist, "Artiste inconnu");
        assert!(!track.has_cover);
    }

    #[test]
    fn track_id_is_stable_across_scans_of_the_same_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = make_test_wav(dir.path(), "stable.wav", 1);
        let t1 = read_track(&path).unwrap();
        let t2 = read_track(&path).unwrap();
        assert_eq!(t1.id, t2.id);
    }

    #[test]
    fn different_paths_get_different_ids() {
        let dir = tempfile::tempdir().unwrap();
        let a = make_test_wav(dir.path(), "a.wav", 1);
        let b = make_test_wav(dir.path(), "b.wav", 1);
        assert_ne!(read_track(&a).unwrap().id, read_track(&b).unwrap().id);
    }

    #[test]
    fn scan_library_finds_all_supported_files_recursively() {
        let dir = tempfile::tempdir().unwrap();
        make_test_wav(dir.path(), "root.wav", 1);
        let sub = dir.path().join("sous-dossier");
        fs::create_dir(&sub).unwrap();
        make_test_wav(&sub, "nested.wav", 1);
        fs::write(dir.path().join("readme.txt"), b"pas de la musique").unwrap();

        let tracks = scan_library(dir.path());
        assert_eq!(tracks.len(), 2);
    }

    #[test]
    fn cover_data_uri_is_none_when_no_embedded_picture() {
        let dir = tempfile::tempdir().unwrap();
        let path = make_test_wav(dir.path(), "no-cover.wav", 1);
        assert!(cover_data_uri(&path).is_none());
    }
}
