//! Paroles : fichier `.lrc` posé à côté du morceau, paroles intégrées aux étiquettes, puis
//! recherche automatique en ligne sur LRCLIB, service libre et sans clé (désactivable).
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
            let Some((tag, after)) = stripped.split_once(']') else {
                break;
            };
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
            lines.push(LyricLine {
                time_ms,
                text: text.clone(),
            });
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
            plain: Some(
                synced
                    .iter()
                    .map(|l| l.text.as_str())
                    .collect::<Vec<_>>()
                    .join("\n"),
            ),
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
    for ext in ["lrc", "LRC"] {
        if let Ok(text) = std::fs::read_to_string(track_path.with_extension(ext)) {
            if !text.trim().is_empty() {
                return Some(from_text(&text, "fichier .lrc"));
            }
        }
    }
    library::embedded_lyrics(track_path).map(|text| from_text(&text, "étiquettes du fichier"))
}

/// Mentions ajoutées aux titres des vidéos (« (Lyrics) », « [Official Video] »…), qui
/// empêchent de trouver le morceau.
const NOISE: &[&str] = &[
    "lyrics",
    "lyric",
    "paroles",
    "official",
    "officiel",
    "video",
    "vidéo",
    "clip",
    "audio",
    "visualizer",
    "visualiser",
    "hd",
    "hq",
    "4k",
    "remastered",
    "explicit",
    "music",
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
    track_name: Option<String>,
    artist_name: Option<String>,
    duration: Option<f64>,
    instrumental: Option<bool>,
    plain_lyrics: Option<String>,
    synced_lyrics: Option<String>,
}

impl LrclibRecord {
    fn has_content(&self) -> bool {
        self.synced_lyrics
            .as_deref()
            .is_some_and(|s| !s.trim().is_empty())
            || self
                .plain_lyrics
                .as_deref()
                .is_some_and(|s| !s.trim().is_empty())
            || self.instrumental == Some(true)
    }

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
const USER_AGENT: &str = "MusicPlayer/0.4 (https://github.com/LoickAmg/Music-Player)";

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(7)))
        .http_status_as_error(false)
        .build()
        .into()
}

/// Forme comparable d'un texte : minuscules, sans accents usuels ni ponctuation.
fn normalize(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .map(|c| match c {
            'à' | 'â' | 'ä' | 'á' | 'ã' | 'å' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'î' | 'ï' | 'í' | 'ì' => 'i',
            'ô' | 'ö' | 'ó' | 'ò' | 'õ' => 'o',
            'ù' | 'û' | 'ü' | 'ú' => 'u',
            'ç' => 'c',
            'ñ' => 'n',
            '&' => ' ',
            c if c.is_alphanumeric() => c,
            _ => ' ',
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Retire tout groupe entre parenthèses ou crochets.
fn strip_groups(text: &str) -> String {
    let mut out = String::new();
    let mut depth = 0usize;
    for ch in text.chars() {
        match ch {
            '(' | '[' => depth += 1,
            ')' | ']' if depth > 0 => depth -= 1,
            _ if depth == 0 => out.push(ch),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Titre « nu » : sans invités (« feat. X »), ni mention de version (« - Remastered 2011 »,
/// « (Radio Edit) »), pour les bases qui ne connaissent que le titre original.
fn bare_title(title: &str) -> String {
    let mut t = strip_groups(title);
    for marker in [" feat. ", " feat ", " ft. ", " ft ", " featuring "] {
        let lower = t.to_lowercase();
        if lower.len() == t.len() {
            if let Some(i) = lower.find(marker) {
                t.truncate(i);
            }
        }
    }
    if let Some((head, tail)) = t.split_once(" - ") {
        let tail = tail.to_lowercase();
        const VERSION: &[&str] = &[
            "remaster", "version", "edit", "live", "mono", "stereo", "mix", "demo", "acoustic",
            "bonus", "single",
        ];
        if VERSION.iter().any(|w| tail.contains(w)) {
            t = head.to_string();
        }
    }
    t.trim().to_string()
}

/// Premier artiste d'une liste (« A, B & C », « A feat. B », « A x B »).
fn main_artist(artist: &str) -> String {
    let mut a = artist.to_string();
    for sep in [
        ", ", " & ", " feat. ", " feat ", " ft. ", " x ", " X ", " / ", "; ", " et ", " and ",
    ] {
        if let Some((head, _)) = a.split_once(sep) {
            a = head.to_string();
        }
    }
    a.trim().to_string()
}

/// Titre d'un résultat LRCLIB, débarrassé des mentions de vidéo et d'un « Artiste - »
/// en tête (« Tiakola - Meuda (Clip officiel) » devient « Meuda »).
fn record_title(record: &LrclibRecord) -> String {
    let name = strip_noise(record.track_name.as_deref().unwrap_or(""));
    let artist = normalize(record.artist_name.as_deref().unwrap_or(""));
    match name.split_once(" - ") {
        Some((head, tail)) if !artist.is_empty() && normalize(head).contains(&artist) => {
            bare_title(tail)
        }
        _ => bare_title(&name),
    }
}

/// Note d'un résultat de recherche (plus haut = meilleur), ou `None` s'il ne correspond pas
/// au morceau. Le titre doit concorder ; si l'artiste est connu, il doit concorder aussi
/// (un titre courant comme « Sans toi » existe chez des dizaines d'artistes : mieux vaut
/// pas de paroles que celles d'une autre chanson). Artiste inconnu : titre identique et
/// durée quasi identique exigés.
fn score(record: &LrclibRecord, title: &str, artist: Option<&str>, duration: f64) -> Option<f64> {
    if !record.has_content() {
        return None;
    }
    let want = normalize(&bare_title(title));
    let got = normalize(&record_title(record));
    if want.is_empty() || got.is_empty() {
        return None;
    }
    let title_exact = want == got;
    if !title_exact && !got.contains(&want) && !want.contains(&got) {
        return None;
    }
    let gap = match (record.duration, duration > 0.0) {
        (Some(d), true) => Some((d - duration).abs()),
        _ => None,
    };
    if gap.is_some_and(|g| g > 12.0) {
        return None;
    }
    let artist_ok = match artist {
        Some(a) => {
            let want = normalize(&main_artist(a));
            let got = normalize(record.artist_name.as_deref().unwrap_or(""));
            let ok =
                !want.is_empty() && !got.is_empty() && (got.contains(&want) || want.contains(&got));
            if !ok {
                return None;
            }
            true
        }
        None => {
            if !title_exact || gap.is_none_or(|g| g > 3.0) {
                return None;
            }
            false
        }
    };
    let mut s = 0.0;
    if title_exact {
        s += 30.0;
    }
    if artist_ok {
        s += 40.0;
    }
    if record.synced_lyrics.is_some() {
        s += 15.0;
    }
    s += 12.0 - gap.unwrap_or(6.0);
    Some(s)
}

/// Cherche sur LRCLIB, du plus précis au plus large : correspondance exacte (artiste, titre,
/// album, durée), recherche par champs, variantes du titre (sans invités ni mention de
/// version) et de l'artiste (le principal), puis recherche libre. Le meilleur résultat est
/// retenu selon le titre, l'artiste, la durée et la présence d'horodatages.
pub fn fetch_online(track: &Track) -> Result<Option<Lyrics>, String> {
    let (artist, title) = search_terms(track);
    if title.is_empty() {
        return Ok(None);
    }
    let agent = agent();
    let duration = track.duration_secs;
    let mut reached = false;
    let mut last_error = None;

    if let Some(artist) = &artist {
        let mut request = agent
            .get(format!("{LRCLIB}/get"))
            .header("User-Agent", USER_AGENT)
            .query("artist_name", artist)
            .query("track_name", &title);
        if duration > 0.0 {
            request = request.query("duration", (duration.round() as u64).to_string());
        }
        if track.album != library::UNKNOWN_ALBUM {
            request = request.query("album_name", &track.album);
        }
        match request.call() {
            Ok(mut response) => {
                reached = true;
                if response.status() == 200 {
                    if let Ok(record) = response.body_mut().read_json::<LrclibRecord>() {
                        if score(&record, &title, Some(artist), duration).is_some() {
                            return Ok(Some(record.into_lyrics()));
                        }
                    }
                }
            }
            Err(e) => last_error = Some(e.to_string()),
        }
    }

    let bare = bare_title(&title);
    let lead = artist.as_deref().map(main_artist);
    let mut searches: Vec<Vec<(&str, String)>> = Vec::new();
    if let Some(a) = &artist {
        searches.push(vec![
            ("track_name", title.clone()),
            ("artist_name", a.clone()),
        ]);
    }
    if let Some(a) = &lead {
        if Some(a) != artist.as_ref() || bare != title {
            searches.push(vec![
                ("track_name", bare.clone()),
                ("artist_name", a.clone()),
            ]);
        }
        searches.push(vec![("q", format!("{a} {bare}"))]);
    }
    searches.push(vec![("track_name", bare.clone())]);
    if bare != title {
        searches.push(vec![("q", title.clone())]);
    }

    let mut seen = std::collections::HashSet::new();
    for params in searches {
        if !seen.insert(params.clone()) {
            continue;
        }
        let mut request = agent
            .get(format!("{LRCLIB}/search"))
            .header("User-Agent", USER_AGENT);
        for (key, value) in &params {
            request = request.query(*key, value);
        }
        let mut response = match request.call() {
            Ok(r) => r,
            Err(e) => {
                last_error = Some(e.to_string());
                continue;
            }
        };
        reached = true;
        if response.status() != 200 {
            continue;
        }
        let Ok(results) = response.body_mut().read_json::<Vec<LrclibRecord>>() else {
            continue;
        };
        let best = results
            .into_iter()
            .filter_map(|r| score(&r, &title, artist.as_deref(), duration).map(|s| (s, r)))
            .max_by(|a, b| a.0.total_cmp(&b.0));
        if let Some((_, record)) = best {
            return Ok(Some(record.into_lyrics()));
        }
    }
    match (reached, last_error) {
        // Réseau injoignable : on ne retient pas l'absence, on réessaiera.
        (false, Some(e)) => Err(e),
        _ => Ok(None),
    }
}

/// Version du cache : l'augmenter relance la recherche des morceaux restés sans paroles
/// (quand la recherche s'améliore).
const CACHE_VERSION: u32 = 3;

#[derive(Serialize, Deserialize)]
struct CachedLyrics {
    lyrics: Option<Lyrics>,
    fetched_secs: u64,
    #[serde(default)]
    version: u32,
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

/// Résultat en ligne mis en cache. Une absence de paroles est retenue trois jours, pour
/// retenter plus tard sans interroger le service à chaque écoute.
fn read_cache(cache_dir: &Path, track_id: &str) -> Option<Option<Lyrics>> {
    let cached: CachedLyrics =
        serde_json::from_slice(&std::fs::read(cache_path(cache_dir, track_id)).ok()?).ok()?;
    // Résultat d'une ancienne recherche (moins stricte, parfois les paroles d'une autre
    // chanson) : on cherche à nouveau.
    let fresh = cached.version == CACHE_VERSION
        && (cached.lyrics.is_some()
            || now_secs().saturating_sub(cached.fetched_secs) < 3 * 24 * 3600);
    fresh.then_some(cached.lyrics)
}

fn write_cache(cache_dir: &Path, track_id: &str, lyrics: &Option<Lyrics>) {
    if std::fs::create_dir_all(cache_dir).is_ok() {
        if let Ok(json) = serde_json::to_vec(&CachedLyrics {
            lyrics: lyrics.clone(),
            fetched_secs: now_secs(),
            version: CACHE_VERSION,
        }) {
            let _ = std::fs::write(cache_path(cache_dir, track_id), json);
        }
    }
}

/// Paroles d'une piste : locales d'abord, puis cache (sauf `refresh`), puis LRCLIB si
/// `allow_online`.
pub fn lyrics_for(
    track: &Track,
    cache_dir: &Path,
    allow_online: bool,
    refresh: bool,
) -> Result<Option<Lyrics>, String> {
    // Un `.lrc` posé à côté du morceau est un choix de l'utilisateur : toujours prioritaire.
    // Les paroles des étiquettes viennent de qui a diffusé le fichier : nettoyées de leurs
    // pubs, et remplacées par une version synchronisée en ligne quand elles ne le sont pas.
    let local = local_lyrics(Path::new(&track.path)).and_then(|l| {
        if l.source == "fichier .lrc" {
            Some(l)
        } else {
            clean_embedded(l)
        }
    });
    if let Some(local) = &local {
        if local.source == "fichier .lrc" || local.synced.is_some() {
            return Ok(Some(local.clone()));
        }
    }
    let online = online_lyrics(track, cache_dir, allow_online, refresh);
    match (online, local) {
        // Synchronisées en ligne : mieux que des paroles fixes du fichier.
        (Ok(Some(found)), _) if found.synced.is_some() => Ok(Some(found)),
        (_, Some(local)) => Ok(Some(local)),
        (online, None) => online,
    }
}

/// Paroles en ligne (cache, sinon LRCLIB).
fn online_lyrics(
    track: &Track,
    cache_dir: &Path,
    allow_online: bool,
    refresh: bool,
) -> Result<Option<Lyrics>, String> {
    if !refresh {
        if let Some(cached) = read_cache(cache_dir, &track.id) {
            return Ok(cached);
        }
    }
    if !allow_online {
        return Ok(None);
    }
    let found = fetch_online(track)?.filter(|l| !l.is_empty());
    write_cache(cache_dir, &track.id, &found);
    Ok(found)
}

/// Ligne publicitaire glissée dans les étiquettes par qui a diffusé le fichier
/// (« follow me on Instagram: @… », lien, chaîne Telegram…).
fn is_promo(line: &str) -> bool {
    let l = line.to_lowercase();
    const MARKERS: &[&str] = &[
        "http",
        "www.",
        ".com",
        ".net",
        ".org",
        "t.me/",
        "instagram",
        "telegram",
        "tiktok",
        "youtube",
        "follow me",
        "follow us",
        "subscribe",
        "abonne",
        "download",
        "télécharg",
        "telecharg",
        "lyrics by",
        "paroles par",
        "uploaded by",
        "ripped by",
    ];
    MARKERS.iter().any(|m| l.contains(m))
        || l.split_whitespace()
            .any(|w| w.len() > 2 && w.starts_with('@'))
}

/// Paroles des étiquettes débarrassées des lignes publicitaires ; `None` s'il ne reste
/// presque rien (moins de 4 lignes : ce n'étaient pas de vraies paroles).
fn clean_embedded(lyrics: Lyrics) -> Option<Lyrics> {
    let synced = lyrics.synced.map(|lines| {
        lines
            .into_iter()
            .filter(|l| !is_promo(&l.text))
            .collect::<Vec<_>>()
    });
    let plain = lyrics.plain.map(|text| {
        text.lines()
            .filter(|l| !is_promo(l))
            .collect::<Vec<_>>()
            .join("\n")
    });
    let real_lines = match (&synced, &plain) {
        (Some(lines), _) => lines.iter().filter(|l| !l.text.trim().is_empty()).count(),
        (None, Some(text)) => text.lines().filter(|l| !l.trim().is_empty()).count(),
        (None, None) => 0,
    };
    (real_lines >= 4).then(|| Lyrics {
        synced: synced.filter(|l| !l.is_empty()),
        plain: plain.filter(|p| !p.trim().is_empty()),
        instrumental: lyrics.instrumental,
        source: lyrics.source,
    })
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
                LyricLine {
                    time_ms: 4_500,
                    text: "Refrain".into()
                },
                LyricLine {
                    time_ms: 12_000,
                    text: "Première".into()
                },
                LyricLine {
                    time_ms: 29_623,
                    text: "Refrain".into()
                },
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
        assert_eq!(
            strip_noise("Song [Official Music Video] (feat. X)"),
            "Song (feat. X)"
        );
        let (artist, title) = search_terms(&track(
            "The Weeknd - Timeless (Official Video)",
            UNKNOWN_ARTIST,
        ));
        assert_eq!(artist.as_deref(), Some("The Weeknd"));
        assert_eq!(title, "Timeless");
        let (artist, title) = search_terms(&track("Damso - Θ. Macarena", "Damso"));
        assert_eq!(artist.as_deref(), Some("Damso"));
        assert_eq!(title, "Θ. Macarena");
        let (artist, title) = search_terms(&track(
            "\"Crying for Rain\" - 美波 (Minami) MV",
            UNKNOWN_ARTIST,
        ));
        assert_eq!(artist.as_deref(), Some("美波 (Minami)"));
        assert_eq!(title, "Crying for Rain");
    }

    #[test]
    fn title_and_artist_variants() {
        assert_eq!(bare_title("Song (feat. X) - Remastered 2011"), "Song");
        assert_eq!(bare_title("Song feat. X"), "Song");
        assert_eq!(bare_title("Part 1 - Part 2"), "Part 1 - Part 2");
        assert_eq!(main_artist("Nekfeu, Damso & SCH"), "Nekfeu");
        assert_eq!(main_artist("Aya Nakamura feat. Ninho"), "Aya Nakamura");
        assert_eq!(normalize("Évidemment !"), "evidemment");
    }

    #[test]
    fn scoring_needs_title_and_artist_or_duration() {
        let record = |title: &str, artist: &str, duration: f64| LrclibRecord {
            track_name: Some(title.into()),
            artist_name: Some(artist.into()),
            duration: Some(duration),
            instrumental: None,
            plain_lyrics: Some("la".into()),
            synced_lyrics: None,
        };
        assert!(score(
            &record("Timeless", "The Weeknd & Playboi Carti", 256.0),
            "Timeless",
            Some("The Weeknd"),
            250.0
        )
        .is_some());
        assert!(score(
            &record("Other", "The Weeknd", 250.0),
            "Timeless",
            Some("The Weeknd"),
            250.0
        )
        .is_none());
        // Artiste inconnu : il faut une durée quasi identique.
        // Même titre, autre artiste, même durée : refusé (« Sans toi » de Tiakola, pas d'Amel Bent).
        assert!(score(
            &record("Sans Toi", "Amel Bent", 180.0),
            "Sans toi",
            Some("Tiakola"),
            180.0
        )
        .is_none());
        // Titre façon vidéo côté LRCLIB.
        assert!(score(
            &record("Tiakola - Meuda (Clip officiel)", "TIAKOLA", 170.0),
            "Meuda",
            Some("Tiakola"),
            171.0
        )
        .is_some());
        // Artiste inconnu : il faut une durée quasi identique.
        assert!(score(&record("Timeless", "X", 251.0), "Timeless", None, 250.0).is_some());
        assert!(score(&record("Timeless", "X", 262.0), "Timeless", None, 250.0).is_none());
    }

    /// Interroge vraiment LRCLIB : `cargo test -- --ignored online`.
    #[test]
    #[ignore]
    fn online_lookup_finds_variants() {
        for (title, artist) in [
            ("Blinding Lights", "The Weeknd"),
            (
                "Timeless (feat. Playboi Carti) - Official Video",
                "The Weeknd",
            ),
            ("The Weeknd - Save Your Tears (Lyrics)", UNKNOWN_ARTIST),
            ("Djadja", "Aya Nakamura"),
        ] {
            let mut t = track(title, artist);
            t.duration_secs = 0.0;
            let found = fetch_online(&t).unwrap();
            assert!(found.is_some(), "rien pour {title}");
        }
    }

    #[test]
    fn promo_tags_are_not_lyrics() {
        let promo = from_text(
            "follow Me On Instagram:\n@cozy_sway",
            "étiquettes du fichier",
        );
        assert!(clean_embedded(promo).is_none());
        let real = from_text(
            "Première ligne\nDeuxième ligne\nTroisième ligne\nQuatrième ligne\nDownload more at www.site.com",
            "étiquettes du fichier",
        );
        let cleaned = clean_embedded(real).unwrap();
        assert_eq!(cleaned.plain.as_deref().map(|p| p.lines().count()), Some(4));
        assert!(!cleaned.plain.unwrap().contains("www"));
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
