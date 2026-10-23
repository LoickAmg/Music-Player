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
    /// Fichier illisible (abîmé, vide, téléchargement inachevé) : la raison, montrée dans les
    /// Réglages ; ces fichiers sont tenus à l'écart des albums et des listes de morceaux.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub damage: Option<String>,
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

pub fn modified_secs(path: &Path) -> u64 {
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
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
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
        // Étiquettes illisibles : c'est le lecteur de l'application qui tranche. AAC brut
        // enregistré en « .m4a » (fréquent avec les téléchargeurs) : pas d'étiquettes, mais un
        // son parfaitement lisible. Abîmé seulement si le lecteur n'en tire rien non plus (les
        // formats confiés à ffmpeg peuvent juste attendre son installation).
        if track.duration_secs <= 0.0 && ffmpeg::is_native(path) {
            match stream_duration(path) {
                Some(secs) => track.duration_secs = secs,
                None => track.damage = Some(damage_reason(path)),
            }
        }
        return Some(track);
    };
    let mut duration_secs = tagged_file.properties().duration().as_secs_f64();
    // MP4 fragmenté (audio extrait des vidéos) : la durée n'est pas dans l'en-tête.
    if duration_secs <= 0.0 && ffmpeg::is_native(path) {
        duration_secs = stream_duration(path).unwrap_or(0.0);
    }
    let tag = tagged_file
        .primary_tag()
        .or_else(|| tagged_file.first_tag());

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
        damage: None,
    })
}

/// Ouvre le flux audio d'un fichier avec symphonia (lecteur de conteneur prêt à donner ses
/// paquets), en sautant une étiquette ID3 placée avant un FLAC. `None` si le format n'est pas lu.
pub(crate) fn open_format(path: &Path) -> Option<Box<dyn symphonia::core::formats::FormatReader>> {
    use std::io::{Read, Seek, SeekFrom};
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let mut header = [0u8; 10];
    let offset = if file.read_exact(&mut header).is_ok() {
        crate::audio::leading_id3_len(&header).min(len)
    } else {
        0
    };
    // L'étiquette ID3 en tête ne gêne que le FLAC ; les autres lecteurs la sautent seuls.
    let offset = if ffmpeg::extension_of(path) == "flac" {
        offset
    } else {
        0
    };
    file.seek(SeekFrom::Start(offset)).ok()?;
    let source = SkipHeader { file, offset, len };
    let stream = MediaSourceStream::new(Box::new(source), MediaSourceStreamOptions::default());
    let mut hint = Hint::new();
    hint.with_extension(&ffmpeg::extension_of(path));

    let probed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        symphonia::default::get_probe().format(
            &hint,
            stream,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
    }))
    .ok()?
    .ok()?;
    Some(probed.format)
}

/// Fichier dont le début est une étiquette ID3 avant le flux (FLAC « tagués » par certains
/// outils) : le décodeur ne voit que ce qui suit.
struct SkipHeader {
    file: std::fs::File,
    offset: u64,
    len: u64,
}

impl std::io::Read for SkipHeader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.file.read(buf)
    }
}

impl std::io::Seek for SkipHeader {
    fn seek(&mut self, pos: std::io::SeekFrom) -> std::io::Result<u64> {
        let absolute = match pos {
            std::io::SeekFrom::Start(n) => {
                self.file.seek(std::io::SeekFrom::Start(n + self.offset))?
            }
            other => self.file.seek(other)?,
        };
        Ok(absolute.saturating_sub(self.offset))
    }
}

impl symphonia::core::io::MediaSource for SkipHeader {
    fn is_seekable(&self) -> bool {
        true
    }
    fn byte_len(&self) -> Option<u64> {
        Some(self.len - self.offset)
    }
}

/// Lecture du flux audio par le décodeur de l'application : `Some(durée en secondes)` s'il
/// sait le lire (au moins un paquet décodé), `None` sinon. La durée vient de l'en-tête du
/// flux, sinon de la somme des paquets (MP4 fragmenté, AAC brut), sans rien décoder de plus.
pub fn stream_duration(path: &Path) -> Option<f64> {
    use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};

    let mut format = open_format(path)?;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)?
        .clone();
    let params = track.codec_params.clone();
    let mut decoder = symphonia::default::get_codecs()
        .make(&params, &DecoderOptions::default())
        .ok()?;

    let to_secs = |units: u64| -> Option<f64> {
        if let Some(tb) = params.time_base {
            let t = tb.calc_time(units);
            Some(t.seconds as f64 + t.frac)
        } else {
            params
                .sample_rate
                .map(|rate| units as f64 / f64::from(rate))
        }
    };

    // Lisible ? Il faut qu'au moins un paquet se décode (un en-tête valide suivi de zéros
    // ne suffit pas).
    let mut summed: u64 = 0;
    let mut decoded = false;
    let mut packets = 0;
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        while let Ok(packet) = format.next_packet() {
            if packet.track_id() != track.id {
                continue;
            }
            summed += packet.dur;
            packets += 1;
            if !decoded {
                if decoder.decode(&packet).is_ok() {
                    decoded = true;
                    // Durée annoncée par l'en-tête : inutile de parcourir la suite. (Un MP4
                    // fragmenté annonce 0 : la somme des paquets fera foi.)
                    if let (Some(frames @ 1..), Some(rate)) = (params.n_frames, params.sample_rate)
                    {
                        return Some(frames as f64 / f64::from(rate));
                    }
                } else if packets > 64 {
                    return None;
                }
            }
        }
        None
    }))
    .ok()?;
    if let Some(secs) = result {
        return Some(secs);
    }
    if !decoded {
        return None;
    }
    to_secs(summed).or(Some(0.0))
}

/// Pourquoi un fichier est illisible, en mots simples.
fn damage_reason(path: &Path) -> String {
    use std::io::Read;
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if size < 8 * 1024 {
        return "Fichier vide ou presque".into();
    }
    let mut head = vec![0u8; 64 * 1024];
    let read = std::fs::File::open(path)
        .and_then(|mut f| f.read(&mut head))
        .unwrap_or(0);
    if read > 0 && head[..read].iter().all(|b| *b == 0) {
        return "Début du fichier vide : téléchargement inachevé ?".into();
    }
    "Fichier abîmé ou format non reconnu".into()
}

/// Images de pochette reconnues dans le dossier d'un album, par ordre de préférence.
const FOLDER_COVER_NAMES: &[&str] = &["cover", "folder", "front", "album", "albumart"];

fn is_image(path: &Path) -> bool {
    matches!(
        ffmpeg::extension_of(path).as_str(),
        "jpg" | "jpeg" | "png" | "webp"
    )
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
/// Dossiers jamais parcourus : dossiers cachés et, sur un téléphone, les données des
/// applications (`Android/`), inaccessibles et très volumineuses.
fn is_skipped_dir(entry: &walkdir::DirEntry) -> bool {
    if !entry.file_type().is_dir() {
        return false;
    }
    let name = entry.file_name().to_string_lossy();
    name.starts_with('.') || (entry.depth() == 1 && name == "Android")
}

/// Dossiers à parcourir. Sur un téléphone, le stockage interne est complété par les
/// cartes SD, montées à part dans `/storage/XXXX-XXXX`.
fn scan_roots(root: &Path) -> Vec<PathBuf> {
    #[allow(unused_mut)]
    let mut roots = vec![root.to_path_buf()];
    #[cfg(target_os = "android")]
    if root == Path::new("/storage/emulated/0") {
        if let Ok(entries) = std::fs::read_dir("/storage") {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name != "emulated" && name != "self" && entry.path().is_dir() {
                    roots.push(entry.path());
                }
            }
        }
    }
    roots
}

pub fn scan_library_with_progress(
    root: &Path,
    on_progress: impl Fn(usize, usize) + Sync,
) -> Vec<Track> {
    scan_library_incremental(root, &[], on_progress)
}

/// Scan de `root` qui reprend tels quels les morceaux de `previous` dont le fichier n'a pas
/// changé (même date de modification) : seuls les fichiers nouveaux ou modifiés sont lus.
/// Un nouveau scan après un téléchargement prend ainsi un instant, même sur une grande
/// bibliothèque (il relisait toutes les étiquettes).
pub fn scan_library_incremental(
    root: &Path,
    previous: &[Track],
    on_progress: impl Fn(usize, usize) + Sync,
) -> Vec<Track> {
    let known: HashMap<&str, &Track> = previous.iter().map(|t| (t.path.as_str(), t)).collect();
    let mut audio_files = Vec::new();
    let mut images_by_dir: HashMap<PathBuf, Vec<PathBuf>> = HashMap::new();
    for entry in scan_roots(root)
        .into_iter()
        .flat_map(|r| {
            WalkDir::new(r)
                .follow_links(true)
                .into_iter()
                .filter_entry(|e| e.depth() == 0 || !is_skipped_dir(e))
        })
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.into_path();
        if is_supported(&path) {
            audio_files.push(path);
        } else if is_image(&path) {
            if let Some(dir) = path.parent() {
                images_by_dir
                    .entry(dir.to_path_buf())
                    .or_default()
                    .push(path);
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
            let unchanged = path.to_str().and_then(|p| known.get(p)).filter(|t| {
                t.added_secs == modified_secs(path)
                    && (t.has_cover || !folder_has_cover)
                    // Fichier signalé illisible ou sans durée : toujours réexaminé (peu nombreux,
                    // et la détection s'améliore d'une version à l'autre).
                    && t.duration_secs > 0.0
                    && t.damage.is_none()
            });
            let track = match unchanged {
                Some(t) => Some((*t).clone()),
                None => read_track_with_folder_cover(path, folder_has_cover),
            };
            let n = done.fetch_add(1, Ordering::Relaxed) + 1;
            if n.is_multiple_of(64) || n == total {
                on_progress(n, total);
            }
            track
        })
        .collect();
    tracks.sort_by(|a, b| {
        (
            a.album_artist.to_lowercase(),
            a.album.to_lowercase(),
            a.disc_no,
            a.track_no,
            a.title.to_lowercase(),
        )
            .cmp(&(
                b.album_artist.to_lowercase(),
                b.album.to_lowercase(),
                b.disc_no,
                b.track_no,
                b.title.to_lowercase(),
            ))
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
        damage: None,
    }
}

// ---------------------------------------------------------------- cache

#[derive(Serialize, Deserialize)]
struct LibraryCache {
    root: String,
    tracks: Vec<Track>,
}

pub fn save_cache(file: &Path, root: &str, tracks: &[Track]) -> std::io::Result<()> {
    let json = serde_json::to_vec(&LibraryCache {
        root: root.to_string(),
        tracks: tracks.to_vec(),
    })?;
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
    fn incremental_scan_reuses_unchanged_tracks() {
        let dir = tempfile::tempdir().unwrap();
        let a = make_test_wav(dir.path(), "a.wav", 1);
        let mut known = read_track(&a).expect("piste lisible");
        known.title = "Titre déjà connu".into();
        let tracks = scan_library_incremental(dir.path(), std::slice::from_ref(&known), |_, _| {});
        assert_eq!(tracks.len(), 1);
        assert_eq!(
            tracks[0].title, "Titre déjà connu",
            "le fichier inchangé n'est pas relu"
        );
        // Un fichier nouveau est bien lu.
        make_test_wav(dir.path(), "b.wav", 1);
        let tracks = scan_library_incremental(dir.path(), &[known], |_, _| {});
        assert_eq!(tracks.len(), 2);
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
    fn damaged_files_are_flagged_with_a_reason() {
        let dir = tempfile::tempdir().unwrap();
        // Téléchargement inachevé : le début du fichier n'est que des zéros.
        let partial = dir.path().join("07 - Schéma.flac");
        let mut bytes = vec![0u8; 200 * 1024];
        bytes.extend_from_slice(b"fin du fichier");
        fs::write(&partial, bytes).unwrap();
        let track = read_track(&partial).unwrap();
        assert_eq!(
            track.damage.as_deref(),
            Some("Début du fichier vide : téléchargement inachevé ?")
        );
        let tiny = dir.path().join("casse.mp3");
        fs::write(&tiny, b"pas un mp3").unwrap();
        assert_eq!(
            read_track(&tiny).unwrap().damage.as_deref(),
            Some("Fichier vide ou presque")
        );
        // Un vrai morceau n'est pas concerné.
        let good = make_test_wav(dir.path(), "bon.wav", 1);
        assert!(read_track(&good).unwrap().damage.is_none());
        // Bibliothèque d'une version précédente (sans diagnostic) : le fichier est relu.
        let mut old = read_track(&partial).unwrap();
        old.damage = None;
        let tracks = scan_library_incremental(dir.path(), &[old], |_, _| {});
        let again = tracks
            .iter()
            .find(|t| t.path == partial.to_string_lossy())
            .unwrap();
        assert!(again.damage.is_some());
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
        assert!(
            nested.has_cover,
            "le cover.jpg du dossier compte comme pochette"
        );
        assert!(!root.has_cover);

        let cache_dir = dir.path().join("cache");
        let cover = cover_file(Path::new(&nested.path), &nested.id, &cache_dir).unwrap();
        assert_eq!(fs::read(cover).unwrap(), b"\xFF\xD8\xFFfake");
        assert!(cover_file(Path::new(&root.path), &root.id, &cache_dir).is_none());
    }

    #[test]
    fn folder_cover_prefers_conventional_names() {
        let imgs = vec![PathBuf::from("x/scan.jpg"), PathBuf::from("x/Folder.JPG")];
        assert_eq!(
            pick_folder_cover(&imgs),
            Some(PathBuf::from("x/Folder.JPG"))
        );
        let lone = vec![PathBuf::from("x/whatever.png")];
        assert_eq!(
            pick_folder_cover(&lone),
            Some(PathBuf::from("x/whatever.png"))
        );
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
