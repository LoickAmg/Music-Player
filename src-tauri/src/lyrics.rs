//! Paroles : fichier `.lrc` posé à côté du morceau, paroles intégrées aux étiquettes, puis
//! (si l'utilisateur l'autorise) recherche en ligne sur LRCLIB, service libre et sans clé.
//! Les réponses en ligne sont gardées en cache pour ne jamais redemander deux fois.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::library::{self, Track, UNKNOWN_ARTIST};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LyricLine {
    pub time_ms: u64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Lyrics {
    /// Lignes horodatées, triées : permet le défilement synchronisé.
    pub synced: Option<Vec<LyricLine>>,
    pub plain: Option<String>,
    pub instrumental: bool,
    /// « fichier .lrc », « étiquettes du fichier » ou « LRCLIB ».
    pub source: String,
}

impl Lyrics {
    fn is_empty(&self) -> bool {
        self.synced.is_none() && self.plain.is_none() && !self.instrumental
    }
}

fn parse_timestamp(tag: &str) -> Option<u64> {
    let (min, rest) = tag.split_once(':')?;
    let min: u64 = min.trim().parse().ok()?;
    let (sec, frac) = rest.split_once(['.', ':']).unwrap_or((rest, "0"));
    let sec: u64 = sec.trim().parse().ok()?;
    let frac = frac.trim();
    let frac_ms = match frac.len() {
        0 => 0,
        1 => frac.parse::<u64>().ok()? * 100,
        2 => frac.parse::<u64>().ok()? * 10,
        _ => frac[..3].parse::<u64>().ok()?,
    };
    (sec < 60).then_some(min * 60_000 + sec * 1000 + frac_ms)
}

/// Lit un texte LRC (`[mm:ss.xx]paroles`, plusieurs horodatages par ligne possibles,
/// décalage `[offset:±ms]`). `None` si le texte ne contient aucune ligne horodatée.
pub fn parse_lrc(text: &str) -> Option<Vec<LyricLine>> {
    let mut offset: i64 = 0;
    let mut lines = Vec::new();
    for raw in text.lines() {
        let mut rest = raw.trim();
        let mut stamps = Vec::new();
        while let Some(stripped) = rest.strip_prefix('[') {
            let Some((tag, after)) = stripped.split_once(']') else { break };
            if let Some(value) = tag.strip_prefix("offset:") {
                offset = value.trim().parse().unwrap_or(0);
            } else if let Some(ms) = parse_timestamp(tag) {
                stamps.push(ms);
            }
            rest = after.trim_start();
        }
        let text = rest.trim().to_string();
        for ms in stamps {
            // Un offset positif avance les paroles (convention LRC).
            let time_ms = (ms as i64 - offset).max(0) as u64;
            lines.push(LyricLine { time_ms, text: text.clone() });
        }
    }
    if lines.is_empty() {
        return None;
    }
    lines.sort_by_key(|l| l.time_ms);
    Some(lines)
}

fn from_text(text: &str, source: &str) -> Lyrics {
    match parse_lrc(text) {
        Some(synced) => Lyrics {
            plain: Some(synced.iter().map(|l| l.text.as_str()).collect::<Vec<_>>().join("\n")),
            synced: Some(synced),
            instrumental: false,
            source: source.to_string(),
        },
        None => Lyrics {
            synced: None,
            plain: Some(text.trim().to_string()),
            instrumental: false,
            source: source.to_string(),
        },
    }
}

/// Paroles disponibles sans réseau : `Titre.lrc` à côté du fichier, puis étiquettes.
pub fn local_lyrics(track_path: &Path) -> Option<Lyrics> {
    let lrc = track_path.with_extension("lrc");
    if let Ok(text) = std::fs::read_to_string(&lrc) {
        if !text.trim().is_empty() {
            return Some(from_text(&text, "fichier .lrc"));
        }
    }
    library::embedded_lyrics(track_path).map(|text| from_text(&text, "étiquettes du fichier"))
}

/// Mentions ajoutées aux titres des vidéos (« (Lyrics) », « [Official Video] »…), qui
/// empêchent de trouver le morceau.
const NOISE: &[&str] = &[
    "lyrics", "lyric", "paroles", "official", "officiel", "video", "vidéo", "clip", "audio",
    "visualizer", "visualiser", "hd", "hq", "4k", "remastered", "explicit", "music",
];

fn strip_noise(title: &str) -> String {
    let mut out = String::new();
    let mut depth = 0usize;
    let mut group = String::new();
    for ch in title.chars() {
        match ch {
            '(' | '[' => {
                if depth == 0 {
                    group.clear();
                }
                depth += 1;
                group.push(ch);
            }
            ')' | ']' if depth > 0 => {
                depth -= 1;
                group.push(ch);
                if depth == 0 {
                    let lower = group.to_lowercase();
                    if !NOISE.iter().any(|w| lower.contains(w)) {
                        out.push_str(&group);
                    }
                    group.clear();
                }
            }
            _ if depth > 0 => group.push(ch),
            _ => out.push(ch),
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Artiste et titre à chercher : titre nettoyé, et « Artiste - Titre » découpé quand les
/// étiquettes ne donnent pas l'artiste (fichiers issus de vidéos).
pub fn search_terms(track: &Track) -> (Option<String>, String) {
    let title = strip_noise(&track.title);
    let title = title
        .strip_suffix(" MV")
        .or_else(|| title.strip_suffix(" M/V"))
        .unwrap_or(&title)
        .trim()
        .to_string();
    // « "Titre" - Artiste » : forme fréquente des clips, titre entre guillemets en premier.
    if let Some(rest) = title.strip_prefix('"') {
        if let Some((name, after)) = rest.split_once('"') {
            if let Some(artist) = after.trim().strip_prefix("- ") {
                return (Some(strip_noise(artist)), name.trim().to_string());
            }
        }
    }
    if track.artist != UNKNOWN_ARTIST {
        let (_, cleaned) = title
            .split_once(" - ")
            .filter(|(a, _)| a.eq_ignore_ascii_case(&track.artist))
            .unwrap_or(("", title.as_str()));
        return (Some(track.artist.clone()), cleaned.trim().to_string());
    }
    match title.split_once(" - ") {
        Some((artist, name)) => (Some(artist.trim().to_string()), name.trim().to_string()),
        None => (None, title),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LrclibRecord {
    duration: Option<f64>,
    instrumental: Option<bool>,
    plain_lyrics: Option<String>,
    synced_lyrics: Option<String>,
}

impl LrclibRecord {
    fn into_lyrics(self) -> Lyrics {
        if let Some(synced) = self.synced_lyrics.as_deref().and_then(parse_lrc) {
            return Lyrics {
                synced: Some(synced),
                plain: self.plain_lyrics,
                instrumental: false,
                source: "LRCLIB".into(),
            };
        }
        Lyrics {
            synced: None,
            plain: self.plain_lyrics.filter(|p| !p.trim().is_empty()),
            instrumental: self.instrumental.unwrap_or(false),
            source: "LRCLIB".into(),
        }
    }
}

const LRCLIB: &str = "https://lrclib.net/api";
const USER_AGENT: &str = "MusicPlayer/0.2 (application de bureau ; https://github.com/LoickAmg)";

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(8)))
        .http_status_as_error(false)
        .build()
        .into()
}

/// Cherche sur LRCLIB : correspondance exacte (artiste, titre, album, durée), sinon
/// recherche libre en retenant le résultat de durée la plus proche.
pub fn fetch_online(track: &Track) -> Result<Option<Lyrics>, String> {
    let (artist, title) = search_terms(track);
    if title.is_empty() {
        return Ok(None);
    }
    let agent = agent();
    if let Some(artist) = &artist {
        let mut request = agent
            .get(format!("{LRCLIB}/get"))
            .header("User-Agent", USER_AGENT)
            .query("artist_name", artist)
            .query("track_name", &title)
            .query("duration", (track.duration_secs.round() as u64).to_string());
        if track.album != library::UNKNOWN_ALBUM {
            request = request.query("album_name", &track.album);
        }
        let mut response = request.call().map_err(|e| e.to_string())?;
        if response.status() == 200 {
            let record: LrclibRecord = response.body_mut().read_json().map_err(|e| e.to_string())?;
            return Ok(Some(record.into_lyrics()));
        }
    }
    let query = match &artist {
        Some(a) => format!("{a} {title}"),
        None => title.clone(),
    };
    let mut response = agent
        .get(format!("{LRCLIB}/search"))
        .header("User-Agent", USER_AGENT)
        .query("q", &query)
        .call()
        .map_err(|e| e.to_string())?;
    if response.status() != 200 {
        return Ok(None);
    }
    let results: Vec<LrclibRecord> = response.body_mut().read_json().map_err(|e| e.to_string())?;
    let best = results
        .into_iter()
        .filter(|r| r.synced_lyrics.is_some() || r.plain_lyrics.is_some() || r.instrumental == Some(true))
        .min_by(|a, b| {
            let da = (a.duration.unwrap_or(0.0) - track.duration_secs).abs();
            let db = (b.duration.unwrap_or(0.0) - track.duration_secs).abs();
            da.total_cmp(&db)
        })
        .filter(|r| track.duration_secs <= 0.0 || (r.duration.unwrap_or(0.0) - track.duration_secs).abs() < 15.0);
    Ok(best.map(LrclibRecord::into_lyrics))
}

#[derive(Serialize, Deserialize)]
struct CachedLyrics {
    lyrics: Option<Lyrics>,
    fetched_secs: u64,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn cache_path(cache_dir: &Path, track_id: &str) -> PathBuf {
    cache_dir.join(format!("{track_id}.json"))
}

/// Résultat en ligne mis en cache. Une absence de paroles est retenue une semaine, pour
/// retenter plus tard sans interroger le service à chaque écoute.
fn read_cache(cache_dir: &Path, track_id: &str) -> Option<Option<Lyrics>> {
    let cached: CachedLyrics = serde_json::from_slice(&std::fs::read(cache_path(cache_dir, track_id)).ok()?).ok()?;
    let fresh = cached.lyrics.is_some() || now_secs().saturating_sub(cached.fetched_secs) < 7 * 24 * 3600;
    fresh.then_some(cached.lyrics)
}

fn write_cache(cache_dir: &Path, track_id: &str, lyrics: &Option<Lyrics>) {
    if std::fs::create_dir_all(cache_dir).is_ok() {
        if let Ok(json) = serde_json::to_vec(&CachedLyrics { lyrics: lyrics.clone(), fetched_secs: now_secs() }) {
            let _ = std::fs::write(cache_path(cache_dir, track_id), json);
        }
    }
}

/// Paroles d'une piste : locales d'abord, puis cache, puis LRCLIB si `allow_online`.
pub fn lyrics_for(track: &Track, cache_dir: &Path, allow_online: bool) -> Result<Option<Lyrics>, String> {
    if let Some(local) = local_lyrics(Path::new(&track.path)) {
        return Ok(Some(local));
    }
    if let Some(cached) = read_cache(cache_dir, &track.id) {
        return Ok(cached);
    }
    if !allow_online {
        return Ok(None);
    }
    let found = fetch_online(track)?.filter(|l| !l.is_empty());
    write_cache(cache_dir, &track.id, &found);
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(title: &str, artist: &str) -> Track {
        Track {
            id: "t".into(),
            path: "x.mp3".into(),
            title: title.into(),
            artist: artist.into(),
            album: library::UNKNOWN_ALBUM.into(),
            album_artist: artist.into(),
            track_no: None,
            disc_no: None,
            year: None,
            genre: None,
            duration_secs: 200.0,
            has_cover: false,
            added_secs: 0,
        }
    }

    #[test]
    fn parses_lrc_with_several_stamps_offset_and_metadata() {
        let text = "[ar:Artiste]\n[offset:+500]\n[00:12.50]Première\n[00:05.00][00:30.123]Refrain\nsans horodatage";
        let lines = parse_lrc(text).unwrap();
        assert_eq!(
            lines,
            vec![
                LyricLine { time_ms: 4_500, text: "Refrain".into() },
                LyricLine { time_ms: 12_000, text: "Première".into() },
                LyricLine { time_ms: 29_623, text: "Refrain".into() },
            ]
        );
    }

    #[test]
    fn plain_text_is_not_mistaken_for_lrc() {
        assert!(parse_lrc("Juste des paroles\nsans horodatage").is_none());
        let lyrics = from_text("Juste des paroles", "étiquettes du fichier");
        assert!(lyrics.synced.is_none());
        assert_eq!(lyrics.plain.as_deref(), Some("Juste des paroles"));
    }

    #[test]
    fn cleans_video_style_titles() {
        assert_eq!(strip_noise("Timeless (Lyrics)"), "Timeless");
        assert_eq!(strip_noise("Song [Official Music Video] (feat. X)"), "Song (feat. X)");
        let (artist, title) = search_terms(&track("The Weeknd - Timeless (Official Video)", UNKNOWN_ARTIST));
        assert_eq!(artist.as_deref(), Some("The Weeknd"));
        assert_eq!(title, "Timeless");
        let (artist, title) = search_terms(&track("Damso - Θ. Macarena", "Damso"));
        assert_eq!(artist.as_deref(), Some("Damso"));
        assert_eq!(title, "Θ. Macarena");
        let (artist, title) = search_terms(&track("\"Crying for Rain\" - 美波 (Minami) MV", UNKNOWN_ARTIST));
        assert_eq!(artist.as_deref(), Some("美波 (Minami)"));
        assert_eq!(title, "Crying for Rain");
    }

    #[test]
    fn a_sidecar_lrc_file_wins() {
        let dir = tempfile::tempdir().unwrap();
        let audio = dir.path().join("morceau.mp3");
        std::fs::write(&audio, b"x").unwrap();
        std::fs::write(dir.path().join("morceau.lrc"), "[00:01.00]Bonjour").unwrap();
        let lyrics = local_lyrics(&audio).unwrap();
        assert_eq!(lyrics.source, "fichier .lrc");
        assert_eq!(lyrics.synced.unwrap()[0].text, "Bonjour");
    }

    #[test]
    fn cache_remembers_results_and_absences() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_cache(dir.path(), "a").is_none());
        write_cache(dir.path(), "a", &None);
        assert_eq!(read_cache(dir.path(), "a"), Some(None));
        let found = Some(from_text("[00:01.00]x", "LRCLIB"));
        write_cache(dir.path(), "b", &found);
        assert_eq!(read_cache(dir.path(), "b"), Some(found));
    }
}
