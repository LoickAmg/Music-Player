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
    strip_noise_raw(title)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Comme `strip_noise`, sans toucher aux espaces : dans un nom de fichier, un double espace
/// est souvent la trace d'un séparateur disparu (« Artiste  Titre » pour « Artiste | Titre »).
fn strip_noise_raw(title: &str) -> String {
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
    out
}

/// Mots qui, seuls dans un morceau de titre, ne désignent ni l'artiste ni la chanson
/// (« … | Netflix », « … - Topic », « _HQ HD_ nosubs »).
const PIECE_NOISE: &[&str] = &[
    "lyrics",
    "lyric",
    "paroles",
    "official",
    "officiel",
    "officielle",
    "video",
    "vidéo",
    "clip",
    "audio",
    "visualizer",
    "hd",
    "hq",
    "4k",
    "nosubs",
    "netflix",
    "topic",
    "vevo",
    "explicit",
    "remastered",
    "music",
    "musique",
    "tiktok",
    "version",
    "full",
    "ep",
    "mv",
    "m",
    "v",
    "prod",
    "by",
    "with",
    "sub",
    "subs",
    "vostfr",
    "eng",
    "fr",
    "edit",
];

/// Artiste des étiquettes, s'il est fiable : absent, ou recopié du titre (fichiers tirés de
/// vidéos dont toutes les étiquettes valent « Titre – Artiste | Émission | Chaîne »), il ne
/// sert à rien. Nettoyé des suffixes de chaînes (« Tiakola - Topic », « TiakolaVEVO »).
pub fn tagged_artist(track: &Track) -> Option<String> {
    let artist = track.artist.trim();
    if artist.is_empty() || artist == UNKNOWN_ARTIST || artist.contains(" | ") {
        return None;
    }
    if normalize(artist) == normalize(&track.title) {
        return None;
    }
    let mut a = artist.to_string();
    for suffix in [" - Topic", "VEVO", " Official"] {
        if let Some(head) = a.strip_suffix(suffix) {
            a = head.trim().to_string();
        }
    }
    (!a.is_empty()).then_some(a)
}

/// Morceaux d'un titre de fichier sans étiquettes : « Artiste - Titre », « Titre – Artiste |
/// Émission | Chaîne », « Artiste  Titre » (séparateur disparu du nom de fichier), numéro de
/// piste en tête retiré, mentions de vidéo écartées. L'ordre artiste / titre reste inconnu.
pub fn title_pieces(raw: &str) -> Vec<String> {
    // « _ » remplace dans les noms de fichiers les caractères interdits (« ? », « : », « " »).
    let text = strip_noise_raw(&raw.replace('_', " "));
    let mut text = text.trim().to_string();
    // Numéro de piste : « 01 - Titre », « 07. Titre ».
    let digits = text.chars().take_while(|c| c.is_ascii_digit()).count();
    if (1..=3).contains(&digits) {
        let rest = text[digits..].trim_start();
        if let Some(after) = rest.strip_prefix(['-', '.']) {
            if after.starts_with(' ') {
                text = after.trim().to_string();
            }
        }
    }
    const SEPARATORS: &[&str] = &[" | ", "|", " – ", " — ", " - ", " ~ ", " • ", " // ", "  "];
    let mut marked = text;
    for sep in SEPARATORS {
        marked = marked.replace(sep, "\u{1f}");
    }
    marked
        .split('\u{1f}')
        .map(|p| {
            p.trim_matches(|c: char| c.is_whitespace() || c == '-' || c == ':')
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|p| {
            let n = normalize(p);
            !n.is_empty() && !n.split(' ').all(|w| PIECE_NOISE.contains(&w))
        })
        .collect()
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
    if let Some(artist) = tagged_artist(track) {
        let (_, cleaned) = title
            .split_once(" - ")
            .filter(|(a, _)| a.eq_ignore_ascii_case(&artist))
            .unwrap_or(("", title.as_str()));
        return (Some(artist), cleaned.trim().to_string());
    }
    match title.split_once(" - ") {
        Some((artist, name)) => (Some(artist.trim().to_string()), name.trim().to_string()),
        None => (None, title),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LrclibRecord {
    #[serde(default)]
    id: Option<u64>,
    track_name: Option<String>,
    #[serde(default)]
    album_name: Option<String>,
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
            // « Why'd » et « Whyd » (apostrophe retirée du nom de fichier) se valent.
            '\'' | '’' | 'ʼ' | '`' => '\u{0}',
            c if c.is_alphanumeric() => c,
            _ => ' ',
        })
        .filter(|c| *c != '\u{0}')
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

/// Note d'un résultat pour un titre de fichier sans étiquettes fiables (`words` : tous les
/// mots du titre). Le titre et l'artiste du résultat doivent s'y retrouver en entier, dans
/// n'importe quel ordre (« LEVEL UP – Nayte | Nouvelle École » contient « Nayte » et
/// « LEVEL UP »), et la durée concorder : sans étiquettes, c'est le meilleur garde-fou.
fn score_loose(
    record: &LrclibRecord,
    words: &std::collections::HashSet<String>,
    duration: f64,
) -> Option<f64> {
    if !record.has_content() {
        return None;
    }
    let inside = |text: &str| {
        let n = normalize(text);
        let tokens: Vec<&str> = n.split(' ').filter(|w| !w.is_empty()).collect();
        (!tokens.is_empty() && tokens.iter().all(|w| words.contains(*w))).then_some(tokens.len())
    };
    let full = record_title(record);
    let head = full.split(" - ").next().unwrap_or("").to_string();
    let title_words = inside(&full)
        .or_else(|| inside(&strip_groups(&full)))
        .or_else(|| inside(&head))?;
    let artist_words = inside(&main_artist(record.artist_name.as_deref().unwrap_or("")))?;
    let gap = match (record.duration, duration > 0.0) {
        (Some(d), true) => Some((d - duration).abs()),
        _ => None,
    };
    if gap.is_some_and(|g| g > 8.0) {
        return None;
    }
    let coverage = (title_words + artist_words) as f64 / words.len().max(1) as f64;
    let mut s = 30.0 * coverage.min(1.0) + 30.0;
    if record.synced_lyrics.is_some() {
        s += 15.0;
    }
    s += 12.0 - gap.unwrap_or(9.0);
    Some(s)
}

/// Résultat d'un appel à LRCLIB.
enum Reply<T> {
    Found(T),
    Missing,
    /// Service surchargé (« server busy ») ou injoignable : à retenter plus tard, surtout
    /// pas à retenir comme « pas de paroles ».
    Unavailable(String),
}

/// Accès à LRCLIB : réessaie une fois quand le service est surchargé (réponse 503 ou 429,
/// fréquente aux heures de pointe) et retient si une réponse fiable a été obtenue.
struct Lrclib {
    agent: ureq::Agent,
    answered: bool,
    trouble: Option<String>,
}

impl Lrclib {
    fn new() -> Self {
        Self {
            agent: agent(),
            answered: false,
            trouble: None,
        }
    }

    fn get<T: serde::de::DeserializeOwned>(
        &mut self,
        path: &str,
        params: &[(&str, String)],
    ) -> Reply<T> {
        // Service déjà en difficulté pendant cette recherche : inutile d'insister.
        if let Some(e) = &self.trouble {
            return Reply::Unavailable(e.clone());
        }
        let mut last = String::new();
        for attempt in 0..2 {
            if attempt > 0 {
                std::thread::sleep(Duration::from_millis(1200));
            }
            let mut request = self
                .agent
                .get(format!("{LRCLIB}{path}"))
                .header("User-Agent", USER_AGENT);
            for (key, value) in params {
                request = request.query(*key, value);
            }
            match request.call() {
                Ok(mut response) => {
                    let status = response.status().as_u16();
                    if status == 429 || status >= 500 {
                        last =
                            "Le service de paroles est surchargé, réessayez dans un moment.".into();
                        continue;
                    }
                    self.answered = true;
                    if status != 200 {
                        return Reply::Missing;
                    }
                    return match response.body_mut().read_json::<T>() {
                        Ok(value) => Reply::Found(value),
                        Err(_) => Reply::Missing,
                    };
                }
                Err(e) => last = e.to_string(),
            }
        }
        self.trouble = Some(last.clone());
        Reply::Unavailable(last)
    }

    fn search(&mut self, params: &[(&str, String)]) -> Vec<LrclibRecord> {
        match self.get::<Vec<LrclibRecord>>("/search", params) {
            Reply::Found(list) => list,
            _ => Vec::new(),
        }
    }

    /// Fin de recherche sans résultat : « pas de paroles » seulement si le service a bien
    /// répondu à toutes les questions ; sinon une erreur, pour réessayer plus tard.
    fn nothing(self) -> Result<Option<Lyrics>, String> {
        match self.trouble {
            Some(e) => Err(e),
            None if !self.answered => Err("Service de paroles injoignable.".into()),
            None => Ok(None),
        }
    }
}

fn best<F: Fn(&LrclibRecord) -> Option<f64>>(
    records: Vec<LrclibRecord>,
    rate: F,
) -> Option<LrclibRecord> {
    records
        .into_iter()
        .filter_map(|r| rate(&r).map(|s| (s, r)))
        .max_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, r)| r)
}

/// Cherche sur LRCLIB, du plus précis au plus large : correspondance exacte (artiste, titre,
/// album, durée), recherche par champs, variantes du titre (sans invités ni mention de
/// version) et de l'artiste (le principal), puis recherche libre. Le meilleur résultat est
/// retenu selon le titre, l'artiste, la durée et la présence d'horodatages.
/// Fichiers sans étiquettes fiables : le titre est découpé en morceaux (`title_pieces`) et
/// cherché en texte libre, sans présumer de l'ordre artiste / titre.
pub fn fetch_online(track: &Track) -> Result<Option<Lyrics>, String> {
    let mut lrclib = Lrclib::new();
    if let Some(found) = tagged_search(&mut lrclib, track) {
        return Ok(Some(found.into_lyrics()));
    }
    if let Some(found) = loose_search(&mut lrclib, track) {
        return Ok(Some(found.into_lyrics()));
    }
    lrclib.nothing()
}

fn tagged_search(lrclib: &mut Lrclib, track: &Track) -> Option<LrclibRecord> {
    let (artist, title) = search_terms(track);
    if title.is_empty() {
        return None;
    }
    // Titre en plusieurs morceaux sans artiste fiable : c'est le travail de `loose_search`.
    if artist.is_none() && title_pieces(&track.title).len() >= 2 {
        return None;
    }
    let duration = track.duration_secs;

    if let Some(artist) = &artist {
        let mut params = vec![
            ("artist_name", artist.clone()),
            ("track_name", title.clone()),
        ];
        if duration > 0.0 {
            params.push(("duration", (duration.round() as u64).to_string()));
        }
        if track.album != library::UNKNOWN_ALBUM {
            params.push(("album_name", track.album.clone()));
        }
        if let Reply::Found(record) = lrclib.get::<LrclibRecord>("/get", &params) {
            if score(&record, &title, Some(artist), duration).is_some() {
                return Some(record);
            }
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
        let results = lrclib.search(&params);
        if let Some(record) = best(results, |r| score(r, &title, artist.as_deref(), duration)) {
            return Some(record);
        }
    }
    None
}

fn loose_search(lrclib: &mut Lrclib, track: &Track) -> Option<LrclibRecord> {
    let mut pieces = title_pieces(&track.title);
    if let Some(artist) = tagged_artist(track) {
        // Artiste fiable mais titre composite (« Titre | Émission ») : l'artiste fait partie
        // des mots attendus.
        if pieces.len() < 2 {
            return None;
        }
        pieces.insert(0, artist);
    } else if pieces.len() < 2 {
        // « 07 - Schéma.flac » sans étiquettes : les dossiers (« Damso\Damso - J'ai Menti »)
        // donnent souvent l'artiste et l'album.
        let folders = folder_pieces(Path::new(&track.path));
        if pieces.is_empty() || folders.is_empty() {
            return None;
        }
        pieces.extend(folders);
    }
    pieces.truncate(4);
    let words: std::collections::HashSet<String> = pieces
        .iter()
        .flat_map(|p| {
            normalize(p)
                .split(' ')
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .filter(|w| !w.is_empty())
        .collect();
    let duration = track.duration_secs;
    // Paires de morceaux d'abord (la recherche libre de LRCLIB exige tous les mots), puis
    // le tout.
    let mut queries: Vec<String> = Vec::new();
    for (i, j) in [(0, 1), (0, 2), (1, 2)] {
        if j < pieces.len() {
            queries.push(format!("{} {}", pieces[i], pieces[j]));
        }
    }
    if pieces.len() > 2 {
        queries.push(pieces.join(" "));
    }
    for q in queries {
        let results = lrclib.search(&[("q", q)]);
        if let Some(record) = best(results, |r| score_loose(r, &words, duration)) {
            return Some(record);
        }
    }
    None
}

/// Noms de dossiers qui ne disent rien du morceau (racines de bibliothèque, téléchargements,
/// stockage du téléphone).
const GENERIC_FOLDERS: &[&str] = &[
    "music",
    "musique",
    "musiques",
    "musics",
    "audio",
    "songs",
    "sons",
    "son",
    "mp3",
    "flac",
    "download",
    "downloads",
    "telechargements",
    "telechargement",
    "desktop",
    "bureau",
    "documents",
    "users",
    "utilisateurs",
    "home",
    "storage",
    "emulated",
    "0",
    "sdcard",
    "ouverts",
    "files",
    "media",
];

/// Morceaux tirés du dossier et du dossier parent d'un fichier (« Damso - J'ai Menti
/// FLAC-G11 » donne « Damso » et « J'ai Menti FLAC-G11 »), sans doublons ni dossiers génériques.
fn folder_pieces(path: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for dir in path.ancestors().skip(1).take(2) {
        let Some(name) = dir.file_name().and_then(|n| n.to_str()) else {
            break;
        };
        if GENERIC_FOLDERS.contains(&normalize(name).as_str()) {
            break;
        }
        for piece in title_pieces(name) {
            if !out.iter().any(|p| normalize(p) == normalize(&piece)) {
                out.push(piece);
            }
        }
    }
    out
}

/// Proposition de paroles montrée dans la recherche manuelle.
#[derive(Debug, Clone, Serialize)]
pub struct LyricsCandidate {
    pub id: u64,
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub duration: Option<f64>,
    pub synced: bool,
    pub instrumental: bool,
    /// Premières lignes, pour reconnaître la chanson d'un coup d'œil.
    pub preview: Option<String>,
}

/// Texte proposé d'office dans la recherche manuelle (« Nayte LEVEL UP »).
pub fn default_query(track: &Track) -> String {
    let (artist, title) = search_terms(track);
    let pieces = title_pieces(&track.title);
    match artist {
        Some(a) => format!("{a} {}", bare_title(&title)),
        None if pieces.len() >= 2 => format!("{} {}", pieces[0], pieces[1]),
        None => bare_title(&title),
    }
}

/// Recherche manuelle : résultats bruts de LRCLIB pour le texte saisi, les plus probables
/// en tête (durée proche du morceau, paroles synchronisées).
pub fn search_candidates(query: &str, duration: f64) -> Result<Vec<LyricsCandidate>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let mut lrclib = Lrclib::new();
    let mut records = match lrclib.get::<Vec<LrclibRecord>>("/search", &[("q", query.to_string())])
    {
        Reply::Found(list) => list,
        Reply::Missing => Vec::new(),
        Reply::Unavailable(e) => return Err(e),
    };
    // « Artiste - Titre » saisi tel quel : on tente aussi la recherche par champs.
    if records.is_empty() {
        if let Some((a, t)) = query.split_once(" - ") {
            records = lrclib.search(&[
                ("artist_name", a.trim().into()),
                ("track_name", t.trim().into()),
            ]);
        }
    }
    let rank = |r: &LrclibRecord| {
        let gap = match (r.duration, duration > 0.0) {
            (Some(d), true) => (d - duration).abs().min(60.0),
            _ => 30.0,
        };
        let synced = if r.synced_lyrics.is_some() { 0.0 } else { 20.0 };
        gap + synced
    };
    records.retain(LrclibRecord::has_content);
    records.sort_by(|a, b| rank(a).total_cmp(&rank(b)));
    let mut seen = std::collections::HashSet::new();
    Ok(records
        .into_iter()
        .filter_map(|r| {
            let id = r.id?;
            seen.insert(id).then_some(())?;
            let lines: Vec<String> = match (
                &r.plain_lyrics,
                r.synced_lyrics.as_deref().and_then(parse_lrc),
            ) {
                (Some(plain), _) if !plain.trim().is_empty() => {
                    plain.lines().map(str::to_string).collect()
                }
                (_, Some(synced)) => synced.into_iter().map(|l| l.text).collect(),
                _ => Vec::new(),
            };
            let preview = lines
                .iter()
                .map(|l| l.trim())
                .filter(|l| !l.is_empty())
                .take(2)
                .collect::<Vec<_>>()
                .join(" / ");
            let preview = (!preview.is_empty()).then_some(preview);
            Some(LyricsCandidate {
                id,
                title: r.track_name.clone().unwrap_or_default(),
                artist: r.artist_name.clone().unwrap_or_default(),
                album: r.album_name.clone().filter(|a| !a.trim().is_empty()),
                duration: r.duration,
                synced: r
                    .synced_lyrics
                    .as_deref()
                    .is_some_and(|s| !s.trim().is_empty()),
                instrumental: r.instrumental == Some(true),
                preview,
            })
        })
        .take(30)
        .collect())
}

/// Paroles choisies à la main : téléchargées et retenues pour ce morceau, prioritaires sur
/// toute recherche automatique (sauf un `.lrc` posé à côté du fichier).
pub fn choose(track: &Track, cache_dir: &Path, lyrics_id: u64) -> Result<Lyrics, String> {
    let mut lrclib = Lrclib::new();
    match lrclib.get::<LrclibRecord>(&format!("/get/{lyrics_id}"), &[]) {
        Reply::Found(record) if record.has_content() => {
            let lyrics = record.into_lyrics();
            write_entry(cache_dir, &track.id, &Some(lyrics.clone()), true);
            Ok(lyrics)
        }
        Reply::Unavailable(e) => Err(e),
        _ => Err("Ces paroles ne sont plus disponibles.".into()),
    }
}

/// « Ces paroles ne correspondent pas » : plus rien d'affiché pour ce morceau, jusqu'à une
/// nouvelle recherche demandée par l'utilisateur.
pub fn dismiss(track: &Track, cache_dir: &Path) {
    write_entry(cache_dir, &track.id, &None, true);
}

/// Version du cache : l'augmenter relance la recherche des morceaux restés sans paroles
/// (quand la recherche s'améliore). Les paroles déjà trouvées depuis la version 3 restent.
const CACHE_VERSION: u32 = 4;
const FOUND_SINCE: u32 = 3;

#[derive(Serialize, Deserialize)]
struct CachedLyrics {
    lyrics: Option<Lyrics>,
    fetched_secs: u64,
    #[serde(default)]
    version: u32,
    /// Choix de l'utilisateur (paroles choisies ou retirées) : jamais remplacé d'office.
    #[serde(default)]
    pinned: bool,
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

fn read_entry(cache_dir: &Path, track_id: &str) -> Option<CachedLyrics> {
    serde_json::from_slice(&std::fs::read(cache_path(cache_dir, track_id)).ok()?).ok()
}

/// Résultat en ligne mis en cache. Une absence de paroles est retenue trois jours, pour
/// retenter plus tard sans interroger le service à chaque écoute.
fn read_cache(cache_dir: &Path, track_id: &str) -> Option<Option<Lyrics>> {
    let cached = read_entry(cache_dir, track_id)?;
    // Résultat d'une ancienne recherche (moins stricte, parfois les paroles d'une autre
    // chanson, ou moins habile) : on cherche à nouveau.
    let fresh = cached.pinned
        || match cached.lyrics {
            Some(_) => cached.version >= FOUND_SINCE,
            None => {
                cached.version == CACHE_VERSION
                    && now_secs().saturating_sub(cached.fetched_secs) < 3 * 24 * 3600
            }
        };
    fresh.then_some(cached.lyrics)
}

fn write_cache(cache_dir: &Path, track_id: &str, lyrics: &Option<Lyrics>) {
    write_entry(cache_dir, track_id, lyrics, false);
}

fn write_entry(cache_dir: &Path, track_id: &str, lyrics: &Option<Lyrics>, pinned: bool) {
    if std::fs::create_dir_all(cache_dir).is_ok() {
        if let Ok(json) = serde_json::to_vec(&CachedLyrics {
            lyrics: lyrics.clone(),
            fetched_secs: now_secs(),
            version: CACHE_VERSION,
            pinned,
        }) {
            let _ = std::fs::write(cache_path(cache_dir, track_id), json);
        }
    }
}

/// Paroles d'une piste : locales d'abord, puis choix de l'utilisateur, puis cache (sauf
/// `refresh`), puis LRCLIB si `allow_online`.
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
        if local.source == "fichier .lrc" {
            return Ok(Some(local.clone()));
        }
    }
    // Paroles choisies (ou retirées) dans l'application : priment sur les étiquettes.
    if !refresh {
        if let Some(entry) = read_entry(cache_dir, &track.id).filter(|e| e.pinned) {
            return Ok(entry.lyrics);
        }
    }
    if let Some(local) = &local {
        if local.synced.is_some() {
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
            id: None,
            track_name: Some(title.into()),
            album_name: None,
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
            (
                "LEVEL UP – Nayte | Nouvelle École: Saison 5 | Netflix",
                "LEVEL UP – Nayte | Nouvelle École: Saison 5 | Netflix",
            ),
            (
                "Arctic Monkeys  Whyd You Only Call Me When Youre High_ (Official Video)",
                UNKNOWN_ARTIST,
            ),
        ] {
            let mut t = track(title, artist);
            t.duration_secs = 0.0;
            let found = fetch_online(&t).unwrap();
            assert!(found.is_some(), "rien pour {title}");
        }
    }

    #[test]
    fn untagged_video_titles_are_split_into_pieces() {
        // Toutes les étiquettes recopient le titre de la vidéo : l'artiste n'est pas fiable.
        let level_up = "LEVEL UP – Nayte | Nouvelle École: Saison 5 | Netflix";
        let t = track(level_up, level_up);
        assert_eq!(tagged_artist(&t), None);
        assert_eq!(
            title_pieces(level_up),
            vec!["LEVEL UP", "Nayte", "Nouvelle École: Saison 5"]
        );
        // Séparateur disparu du nom de fichier (double espace), « ? » devenu « _ ».
        assert_eq!(
            title_pieces("Arctic Monkeys  Whyd You Only Call Me When Youre High_ (Official Video)"),
            vec!["Arctic Monkeys", "Whyd You Only Call Me When Youre High"]
        );
        assert_eq!(
            title_pieces("_Ending_ Paradise Kiss Do You Want To_ _HQ HD_ nosubs"),
            vec!["Ending", "Paradise Kiss Do You Want To"]
        );
        assert_eq!(
            title_pieces("01 - COMMENT FAIRE UN TUBE"),
            vec!["COMMENT FAIRE UN TUBE"]
        );
        assert_eq!(
            title_pieces("10cc  Im Not In Love"),
            vec!["10cc", "Im Not In Love"]
        );
        assert_eq!(title_pieces("Timeless"), vec!["Timeless"]);
        // Artiste de chaîne YouTube.
        assert_eq!(
            tagged_artist(&track("Meuda", "Tiakola - Topic")).as_deref(),
            Some("Tiakola")
        );
        assert_eq!(default_query(&t), "LEVEL UP Nayte");
        // Dossiers : artiste et album d'un fichier numéroté sans étiquettes.
        assert_eq!(
            folder_pieces(Path::new(
                "C:/Users/Moi/Music/Damso/Damso - J'ai Menti FLAC-G11/07 - Schéma.flac"
            )),
            vec!["Damso", "J'ai Menti FLAC-G11"]
        );
        assert!(folder_pieces(Path::new("C:/Users/Moi/Music/10cc  Im Not In Love.mp3")).is_empty());
        assert!(folder_pieces(Path::new("/storage/emulated/0/Download/x.mp3")).is_empty());
    }

    #[test]
    fn loose_matching_needs_title_artist_and_duration() {
        let record = |title: &str, artist: &str, duration: f64| LrclibRecord {
            id: Some(1),
            track_name: Some(title.into()),
            album_name: None,
            artist_name: Some(artist.into()),
            duration: Some(duration),
            instrumental: None,
            plain_lyrics: Some("la".into()),
            synced_lyrics: Some("[00:01.00]la".into()),
        };
        let words = |pieces: &[&str]| {
            pieces
                .iter()
                .flat_map(|p| {
                    normalize(p)
                        .split(' ')
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .collect::<std::collections::HashSet<_>>()
        };
        let level_up = words(&["LEVEL UP", "Nayte", "Nouvelle École: Saison 5"]);
        assert!(score_loose(
            &record("LEVEL UP - Nouvelle École", "Nayte", 155.0),
            &level_up,
            154.1
        )
        .is_some());
        assert!(score_loose(
            &record("LEVEL UP - Nouvelle École", "Nayte, Nouvelle Ecole", 154.0),
            &level_up,
            154.1
        )
        .is_some());
        // Bonne chanson, autre version bien plus longue : refusée.
        assert!(score_loose(
            &record("LEVEL UP - Nouvelle École", "Nayte", 211.0),
            &level_up,
            154.1
        )
        .is_none());
        // Autre titre du même artiste : refusé.
        assert!(score_loose(
            &record("Dis-moi - Nouvelle École", "Nayte", 155.0),
            &level_up,
            154.1
        )
        .is_none());
        // Apostrophes retirées du nom de fichier.
        let arctic = words(&["Arctic Monkeys", "Whyd You Only Call Me When Youre High"]);
        assert!(score_loose(
            &record(
                "Why’d You Only Call Me When You’re High?",
                "Arctic Monkeys",
                161.0
            ),
            &arctic,
            162.0
        )
        .is_some());
        // Hommage par un autre artiste : refusé.
        assert!(score_loose(
            &record(
                "Why'd You Only Call Me When You're High - Tribute to Arctic Monkeys",
                "Why'd You Only Call Me When You're High",
                166.0
            ),
            &arctic,
            162.0
        )
        .is_none());
    }

    #[test]
    fn user_choices_override_the_automatic_search() {
        let dir = tempfile::tempdir().unwrap();
        let t = track("Timeless", "The Weeknd");
        dismiss(&t, dir.path());
        // Retirées par l'utilisateur : rien, sans même interroger le service.
        assert_eq!(lyrics_for(&t, dir.path(), false, false), Ok(None));
        let chosen = Some(from_text("[00:01.00]Choisies", "LRCLIB"));
        write_entry(dir.path(), &t.id, &chosen, true);
        assert_eq!(lyrics_for(&t, dir.path(), false, false), Ok(chosen.clone()));
        // Un ancien cache d'une version précédente n'efface pas un choix.
        assert_eq!(read_cache(dir.path(), &t.id), Some(chosen));
    }

    #[test]
    fn old_misses_are_retried_but_old_finds_are_kept() {
        let dir = tempfile::tempdir().unwrap();
        let old = |lyrics: Option<Lyrics>| {
            serde_json::to_vec(&serde_json::json!({
                "lyrics": lyrics, "fetched_secs": now_secs(), "version": 3
            }))
            .unwrap()
        };
        std::fs::write(cache_path(dir.path(), "miss"), old(None)).unwrap();
        std::fs::write(
            cache_path(dir.path(), "hit"),
            old(Some(from_text("x", "LRCLIB"))),
        )
        .unwrap();
        assert_eq!(read_cache(dir.path(), "miss"), None);
        assert!(read_cache(dir.path(), "hit").unwrap().is_some());
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
