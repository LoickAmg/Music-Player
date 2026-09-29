//! Formats que le lecteur intégré ne sait pas décoder (Opus, WMA, AC3/E-AC3 « Dolby »,
//! APE, WavPack, DSD…) : on les confie à `ffmpeg` s'il est installé, qui les convertit à
//! la volée en WAV, lu ensuite comme n'importe quel autre fichier.
//!
//! `ffmpeg` n'est pas livré avec l'application (taille et licence) : il est cherché dans
//! `FFMPEG_PATH`, à côté de l'exécutable, puis dans le `PATH`. Sous Windows :
//! `winget install ffmpeg`.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Deserialize;

/// Formats décodés directement par l'application (Symphonia).
pub const NATIVE_EXTENSIONS: &[&str] = &[
    "mp3", "flac", "ogg", "oga", "wav", "wave", "m4a", "m4b", "mp4", "aac", "alac", "aif", "aiff",
    "caf", "mka", "webm",
];

/// Formats qui exigent `ffmpeg`.
pub const FFMPEG_EXTENSIONS: &[&str] = &[
    "opus", "wma", "ac3", "eac3", "ec3", "ape", "wv", "mpc", "tta", "spx", "amr", "mp2", "3gp",
    "dsf", "dff", "mid",
];

pub fn extension_of(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default()
}

pub fn is_native(path: &Path) -> bool {
    NATIVE_EXTENSIONS.contains(&extension_of(path).as_str())
}

pub fn needs_ffmpeg(path: &Path) -> bool {
    FFMPEG_EXTENSIONS.contains(&extension_of(path).as_str())
}

fn exe_name(base: &str) -> String {
    if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
}

/// Cherche un outil (`ffmpeg` ou `ffprobe`) : variable d'environnement, dossier de
/// l'application, puis `PATH`.
pub fn find_tool(base: &str) -> Option<PathBuf> {
    let env_var = format!("{}_PATH", base.to_uppercase());
    if let Ok(custom) = std::env::var(&env_var) {
        let path = PathBuf::from(custom.trim());
        if path.is_file() {
            return Some(path);
        }
    }
    let name = exe_name(base);
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
    {
        let beside = dir.join(&name);
        if beside.is_file() {
            return Some(beside);
        }
    }
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths)
        .map(|dir| dir.join(&name))
        .find(|candidate| candidate.is_file())
}

pub fn ffmpeg_available() -> bool {
    find_tool("ffmpeg").is_some()
}

fn quiet(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW : pas de fenêtre de console
    }
    command
}

/// Message affiché quand un format demande `ffmpeg` et qu'il est absent.
pub fn missing_ffmpeg_message(path: &Path) -> String {
    format!(
        "Le format .{} demande ffmpeg, introuvable sur cet ordinateur. Installez-le \
         (Windows : winget install ffmpeg), puis relancez l'application.",
        extension_of(path)
    )
}

/// Décode un fichier en WAV 16 bits stéréo (en mémoire) avec `ffmpeg`.
pub fn decode_to_wav(path: &Path) -> Result<Vec<u8>, String> {
    let ffmpeg = find_tool("ffmpeg").ok_or_else(|| missing_ffmpeg_message(path))?;
    let mut command = Command::new(ffmpeg);
    quiet(&mut command)
        .args(["-v", "error", "-nostdin", "-i"])
        .arg(path)
        .args([
            "-vn",
            "-ac",
            "2",
            "-f",
            "wav",
            "-acodec",
            "pcm_s16le",
            "pipe:1",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = command.output().map_err(|e| format!("ffmpeg : {e}"))?;
    if !output.status.success() || output.stdout.is_empty() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "ffmpeg n'a pas pu décoder ce fichier : {}",
            detail.lines().next().unwrap_or("erreur inconnue")
        ));
    }
    Ok(output.stdout)
}

/// Métadonnées lues par `ffprobe` quand `lofty` ne connaît pas le format.
#[derive(Debug, Default, PartialEq)]
pub struct ProbeInfo {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub track_no: Option<u32>,
    pub duration_secs: f64,
}

#[derive(Deserialize)]
struct ProbeOutput {
    format: Option<ProbeFormat>,
}

#[derive(Deserialize)]
struct ProbeFormat {
    duration: Option<String>,
    tags: Option<std::collections::HashMap<String, String>>,
}

/// Lit la sortie JSON de `ffprobe -show_format`. Les noms d'étiquettes varient
/// (`TITLE`, `title`, `Title`) : la comparaison ignore la casse.
pub fn parse_probe(json: &str) -> Option<ProbeInfo> {
    let output: ProbeOutput = serde_json::from_str(json).ok()?;
    let format = output.format?;
    let tags: std::collections::HashMap<String, String> = format
        .tags
        .unwrap_or_default()
        .into_iter()
        .map(|(k, v)| (k.to_lowercase(), v))
        .collect();
    let get = |key: &str| {
        tags.get(key)
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    Some(ProbeInfo {
        title: get("title"),
        artist: get("artist").or_else(|| get("album_artist")),
        album: get("album"),
        track_no: get("track")
            .and_then(|t| t.split('/').next().and_then(|n| n.trim().parse().ok())),
        duration_secs: format.duration.and_then(|d| d.parse().ok()).unwrap_or(0.0),
    })
}

pub fn probe(path: &Path) -> Option<ProbeInfo> {
    let ffprobe = find_tool("ffprobe")?;
    let mut command = Command::new(ffprobe);
    quiet(&mut command)
        .args(["-v", "quiet", "-print_format", "json", "-show_format"])
        .arg(path)
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    parse_probe(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_formats() {
        assert!(is_native(Path::new("a.MP3")));
        assert!(is_native(Path::new("a.m4a")));
        assert!(!is_native(Path::new("a.opus")));
        assert!(needs_ffmpeg(Path::new("High For This.eac3")));
        assert!(needs_ffmpeg(Path::new("a.WMA")));
        assert!(!needs_ffmpeg(Path::new("a.flac")));
        assert!(!is_native(Path::new("a.txt")) && !needs_ffmpeg(Path::new("a.txt")));
    }

    #[test]
    fn no_extension_is_in_both_lists() {
        for ext in NATIVE_EXTENSIONS {
            assert!(!FFMPEG_EXTENSIONS.contains(ext), "{ext}");
        }
    }

    #[test]
    fn parses_ffprobe_output_ignoring_tag_case() {
        let json = r#"{"format":{"duration":"243.512000","tags":{"TITLE":"High For This","ARTIST":"The Weeknd","album":"Kiss Land","track":"3/12"}}}"#;
        let info = parse_probe(json).unwrap();
        assert_eq!(info.title.as_deref(), Some("High For This"));
        assert_eq!(info.artist.as_deref(), Some("The Weeknd"));
        assert_eq!(info.album.as_deref(), Some("Kiss Land"));
        assert_eq!(info.track_no, Some(3));
        assert!((info.duration_secs - 243.512).abs() < 1e-9);
    }

    #[test]
    fn parses_ffprobe_output_without_tags() {
        let info = parse_probe(r#"{"format":{"duration":"10.0"}}"#).unwrap();
        assert_eq!(info.title, None);
        assert_eq!(info.duration_secs, 10.0);
        assert!(parse_probe("pas du json").is_none());
    }

    #[test]
    fn missing_ffmpeg_message_names_the_format() {
        assert!(missing_ffmpeg_message(Path::new("x.opus")).contains(".opus"));
    }

    /// Fabrique une seconde de sinus dans le format demandé, ou `None` si ffmpeg (ou son
    /// encodeur pour ce format) manque : ces tests ne s'exécutent que si l'outil est là.
    fn synthesize(dir: &Path, name: &str, codec_args: &[&str]) -> Option<PathBuf> {
        let ffmpeg = find_tool("ffmpeg")?;
        let out = dir.join(name);
        let status = Command::new(ffmpeg)
            .args([
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=1",
            ])
            .args(codec_args)
            .arg(&out)
            .stdin(Stdio::null())
            .status()
            .ok()?;
        (status.success() && out.is_file()).then_some(out)
    }

    #[test]
    fn decodes_exotic_formats_end_to_end_when_ffmpeg_is_installed() {
        let dir = tempfile::tempdir().unwrap();
        let cases: [(&str, &[&str]); 3] = [
            ("tone.wma", &["-c:a", "wmav2"]),
            ("tone.eac3", &["-c:a", "eac3"]),
            ("tone.opus", &["-c:a", "libopus"]),
        ];
        let mut tested = 0;
        for (name, args) in cases {
            let Some(path) = synthesize(dir.path(), name, args) else {
                continue;
            };
            tested += 1;
            let wav = decode_to_wav(&path).unwrap_or_else(|e| panic!("{name} : {e}"));
            assert!(
                wav.len() > 10_000,
                "{name} : WAV trop court ({} octets)",
                wav.len()
            );
            assert_eq!(&wav[..4], b"RIFF", "{name}");
            // Le WAV produit est lisible par le lecteur intégré.
            let decoder = rodio::Decoder::new(std::io::Cursor::new(wav)).expect(name);
            assert!(rodio::Source::channels(&decoder).get() >= 1);

            let info = probe(&path);
            if let Some(info) = info {
                assert!(
                    (0.5..2.0).contains(&info.duration_secs),
                    "{name} : {}",
                    info.duration_secs
                );
            }
            // Le format figure bien dans la bibliothèque, avec une durée.
            let track = crate::library::read_track(&path).expect(name);
            assert_eq!(track.title, path.file_stem().unwrap().to_string_lossy());
        }
        if tested == 0 {
            eprintln!("ffmpeg absent : test de bout en bout ignoré");
        }
    }

    #[test]
    fn a_corrupt_file_gives_a_readable_error() {
        if find_tool("ffmpeg").is_none() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("casse.opus");
        std::fs::write(&path, b"ceci n'est pas de l'audio").unwrap();
        let error = decode_to_wav(&path).unwrap_err();
        assert!(error.contains("ffmpeg"), "{error}");
    }
}
