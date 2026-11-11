//! Import d'une playlist, d'un album ou d'un morceau Spotify par son lien : spotDL en lit les
//! métadonnées (`spotdl save`), sans rien télécharger ni demander de clé Spotify.
//!
//! Le texte collé n'est jamais transmis tel quel : le lien est validé, puis reconstruit à partir
//! du type et de l'identifiant seuls.

use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::Manager;

use super::common::{cleanup_attempt, create_attempt_directory, join_logs, network_failure, truncate_log};
use super::import::STAGING_DIR;
use super::spotdl::{resolve_runner, Runner};
use super::JobError;
use crate::bounded::{self, Bounded};
use crate::ffmpeg;
use crate::state::{AppState, Locked};

const TOOL: &str = "spotDL";
const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_TRACKS: usize = 10_000;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(2 * 60);
const INSTALL_MESSAGE: &str = "Import par lien disponible sur PC avec spotDL installé ; sinon, utilisez l'export de vos données Spotify.";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LinkTrack {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_secs: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LinkPlaylist {
    pub name: String,
    pub tracks: Vec<LinkTrack>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Playlist,
    Album,
    Track,
}

#[derive(Debug, PartialEq, Eq)]
struct ValidatedLink {
    kind: Kind,
    url: String,
}

/// Morceau tel que l'écrit `spotdl save` (seuls les champs utiles).
#[derive(Debug, Deserialize)]
struct SpotdlTrack {
    #[serde(default)]
    name: String,
    #[serde(default)]
    artists: serde_json::Value,
    #[serde(default)]
    album_name: Option<String>,
    #[serde(default)]
    duration: Option<f64>,
    #[serde(default)]
    list_name: Option<String>,
}

#[tauri::command(async)]
pub fn fetch_read_link(app: tauri::AppHandle, url: String) -> Result<LinkPlaylist, String> {
    let link = validate_spotify_link(&url)?;
    if cfg!(target_os = "android") {
        return Err(INSTALL_MESSAGE.to_owned());
    }
    let root = app
        .state::<AppState>()
        .library_root
        .locked()
        .clone()
        .ok_or_else(|| "Choisissez d'abord le dossier de votre bibliothèque.".to_owned())?;
    let cancel = AtomicBool::new(false);
    let runner = resolve_runner(&cancel).map_err(|error| match error {
        JobError::ToolMissing(_) => INSTALL_MESSAGE.to_owned(),
        other => other.to_string(),
    })?;
    read_link_with_runner(runner, &link, &Path::new(&root).join(STAGING_DIR), &cancel).map_err(|error| error.to_string())
}

/// Accepte `https://open.spotify.com/[intl-xx/]{playlist|album|track}/<22 caractères>` (les
/// paramètres `?si=…` et autres sont ignorés) et `spotify:{playlist|album|track}:<id>`.
fn validate_spotify_link(input: &str) -> Result<ValidatedLink, String> {
    let input = input.trim();
    let (kind, id) = if let Some(uri) = input.strip_prefix("spotify:") {
        uri.split_once(':').ok_or_else(|| "Lien Spotify incomplet.".to_owned())?
    } else {
        let rest = input
            .strip_prefix("https://open.spotify.com/")
            .ok_or_else(|| "Le lien doit commencer par https://open.spotify.com/.".to_owned())?;
        // On reconstruit le lien : paramètres et fragment sont simplement abandonnés.
        let path = rest.split(['?', '#']).next().unwrap_or_default();
        let mut parts = path.split('/').filter(|part| !part.is_empty()).peekable();
        if parts.peek().is_some_and(|first| is_locale(first)) {
            parts.next();
        }
        let kind = parts.next().unwrap_or_default();
        let id = parts.next().unwrap_or_default();
        if parts.next().is_some() {
            return Err("Le lien Spotify contient un chemin supplémentaire inattendu.".to_owned());
        }
        (kind, id)
    };
    let kind = match kind {
        "playlist" => Kind::Playlist,
        "album" => Kind::Album,
        "track" => Kind::Track,
        _ => return Err("Le lien doit désigner une playlist, un album ou un morceau Spotify.".to_owned()),
    };
    if id.len() != 22 || !id.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return Err("Ce lien Spotify n'a pas un identifiant valide (22 lettres ou chiffres).".to_owned());
    }
    let segment = match kind {
        Kind::Playlist => "playlist",
        Kind::Album => "album",
        Kind::Track => "track",
    };
    Ok(ValidatedLink { kind, url: format!("https://open.spotify.com/{segment}/{id}") })
}

/// `intl-fr`, `intl-pt`, `intl-pt-br`…
fn is_locale(part: &str) -> bool {
    part.strip_prefix("intl-").is_some_and(|locale| {
        (2..=5).contains(&locale.len()) && locale.bytes().all(|byte| byte.is_ascii_alphabetic() || byte == b'-')
    })
}

fn read_link_with_runner(runner: Runner, link: &ValidatedLink, staging: &Path, cancel: &AtomicBool) -> Result<LinkPlaylist, JobError> {
    if cancel.load(Ordering::Relaxed) {
        return Err(JobError::Cancelled);
    }
    let attempt_dir = create_attempt_directory(staging)?;
    let save_file = attempt_dir.join("lien.spotdl");
    let result = run_save(runner, &link.url, &save_file, cancel).and_then(|()| read_spotdl_file(&save_file, link.kind));
    cleanup_attempt(&attempt_dir);
    result
}

fn run_save(runner: Runner, link: &str, save_file: &Path, cancel: &AtomicBool) -> Result<(), JobError> {
    let mut command = runner.command();
    command
        .arg("save")
        .arg("--save-file")
        .arg(save_file)
        // Le lien reconstruit reste une donnée, jamais une option.
        .arg("--")
        .arg(link);
    ffmpeg::quiet(&mut command);
    let outcome = bounded::run(&mut command, COMMAND_TIMEOUT, cancel).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            JobError::ToolMissing(INSTALL_MESSAGE.to_owned())
        } else {
            JobError::Failed(format!("Impossible de lancer spotDL : {error}"))
        }
    })?;
    match outcome {
        Bounded::Finished { status, .. } if status.success() => Ok(()),
        Bounded::Finished { stdout, stderr, .. } => {
            let detail = join_logs(&stdout, &stderr, TOOL);
            if network_failure(&detail.to_lowercase()) {
                Err(JobError::Network(truncate_log(&detail)))
            } else {
                Err(JobError::Failed(truncate_log(&detail)))
            }
        }
        Bounded::TimedOut { .. } => Err(JobError::Timeout),
        Bounded::Cancelled { .. } => Err(JobError::Cancelled),
    }
}

fn read_spotdl_file(path: &Path, kind: Kind) -> Result<LinkPlaylist, JobError> {
    let file = File::open(path).map_err(|error| JobError::Failed(format!("spotDL n'a rien écrit pour ce lien : {error}")))?;
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| JobError::Failed(format!("Impossible de lire le résultat de spotDL : {error}")))?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(JobError::Failed("Le résultat de spotDL dépasse 20 Mo.".to_owned()));
    }
    let entries: Vec<SpotdlTrack> =
        serde_json::from_slice(&bytes).map_err(|error| JobError::Failed(format!("Résultat de spotDL illisible : {error}")))?;
    if entries.len() > MAX_TRACKS {
        return Err(JobError::Failed(format!("Le lien contient plus de {MAX_TRACKS} morceaux.")));
    }

    let named = |value: Option<&str>| value.map(str::trim).filter(|name| !name.is_empty()).map(str::to_owned);
    let list_name = named(entries.iter().find_map(|entry| entry.list_name.as_deref()));
    let first_album = named(entries.first().and_then(|entry| entry.album_name.as_deref()));
    let first_title = named(entries.first().map(|entry| entry.name.as_str()));

    let tracks: Vec<LinkTrack> = entries
        .into_iter()
        .filter_map(|entry| {
            let title = entry.name.trim().to_owned();
            if title.is_empty() {
                return None;
            }
            let artist = match entry.artists {
                serde_json::Value::String(value) => value.trim().to_owned(),
                serde_json::Value::Array(values) => values
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|artist| !artist.is_empty())
                    .collect::<Vec<_>>()
                    .join(", "),
                _ => String::new(),
            };
            Some(LinkTrack {
                title,
                artist,
                album: entry.album_name.map(|album| album.trim().to_owned()).unwrap_or_default(),
                duration_secs: entry.duration.filter(|duration| duration.is_finite() && *duration > 0.0),
            })
        })
        .collect();
    if tracks.is_empty() {
        return Err(JobError::Failed("Aucun morceau lisible derrière ce lien (playlist privée ou vide ?).".to_owned()));
    }

    // Nom donné par spotDL ; à défaut, l'album ou le titre selon le type de lien.
    let fallback = match kind {
        Kind::Album => first_album,
        Kind::Track => first_title,
        Kind::Playlist => None,
    };
    let name = list_name.or(fallback).unwrap_or_else(|| "Playlist Spotify".to_owned());
    Ok(LinkPlaylist { name, tracks })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{read_spotdl_file, validate_spotify_link, Kind, LinkTrack};

    const ID: &str = "0123456789ABCDEFGHIJKL";

    #[test]
    fn accepte_les_liens_spotify_et_les_reconstruit() {
        for (input, expected) in [
            (format!("https://open.spotify.com/playlist/{ID}"), format!("https://open.spotify.com/playlist/{ID}")),
            (format!("  https://open.spotify.com/album/{ID}?si=abc-123_X&pt=x  "), format!("https://open.spotify.com/album/{ID}")),
            (format!("https://open.spotify.com/intl-fr/track/{ID}#x"), format!("https://open.spotify.com/track/{ID}")),
            (format!("https://open.spotify.com/intl-pt-br/playlist/{ID}/"), format!("https://open.spotify.com/playlist/{ID}")),
            (format!("spotify:playlist:{ID}"), format!("https://open.spotify.com/playlist/{ID}")),
        ] {
            assert_eq!(validate_spotify_link(&input).map(|link| link.url), Ok(expected), "{input}");
        }
    }

    #[test]
    fn refuse_les_autres_liens_et_les_injections() {
        for input in [
            format!("https://example.com/playlist/{ID}"),
            format!("http://open.spotify.com/playlist/{ID}"),
            format!("https://open.spotify.com.evil.com/playlist/{ID}"),
            "https://open.spotify.com/playlist/short".to_owned(),
            "https://open.spotify.com/playlist/--help".to_owned(),
            format!("https://open.spotify.com/artist/{ID}"),
            format!("https://open.spotify.com/playlist/{ID}/extra"),
            format!("spotify:playlist:{ID} --help"),
            String::new(),
        ] {
            assert!(validate_spotify_link(&input).is_err(), "{input}");
        }
    }

    #[test]
    fn lit_un_fichier_spotdl() {
        let directory = tempfile::tempdir().expect("dossier temporaire");
        let path = directory.path().join("test.spotdl");
        fs::write(
            &path,
            r#"[{"name":"Titre","artists":["Artiste"," Invité "],"album_name":"Album","duration":180,"list_name":"Ma playlist"},
                {"name":"  ","artists":[]}]"#,
        )
        .expect("fichier de test");
        let playlist = read_spotdl_file(&path, Kind::Playlist).expect("lecture");
        assert_eq!(playlist.name, "Ma playlist");
        assert_eq!(
            playlist.tracks,
            vec![LinkTrack { title: "Titre".into(), artist: "Artiste, Invité".into(), album: "Album".into(), duration_secs: Some(180.0) }]
        );
    }

    #[test]
    fn nomme_un_album_sans_nom_de_liste_d_apres_l_album() {
        let directory = tempfile::tempdir().expect("dossier temporaire");
        let path = directory.path().join("test.spotdl");
        fs::write(&path, r#"[{"name":"Titre","artists":"Artiste","album_name":"Mon album"}]"#).expect("fichier de test");
        assert_eq!(read_spotdl_file(&path, Kind::Album).expect("lecture").name, "Mon album");
    }

    #[test]
    fn refuse_un_resultat_vide() {
        let directory = tempfile::tempdir().expect("dossier temporaire");
        let path = directory.path().join("test.spotdl");
        fs::write(&path, "[]").expect("fichier de test");
        assert!(read_spotdl_file(&path, Kind::Playlist).is_err());
    }
}
