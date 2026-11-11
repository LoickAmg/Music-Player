//! Adaptateur yt-dlp. Les recherches se font avec une seule entrée `ytsearch1:` ; les fichiers
//! sont d'abord créés dans un dossier isolé, puis repris et renommés avec un nom sûr.
//!
//! Le dossier est donné à part (`-P`) et le modèle de nom reste relatif (`-o`) : yt-dlp lit tout
//! `%` du modèle comme une variable, et un dossier de bibliothèque peut en contenir un.

use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::bounded::{self, Bounded};
use crate::ffmpeg;

use super::common::{cleanup_attempt, create_attempt_directory, ffmpeg_missing, join_logs, network_failure, take_output, truncate_log};
use super::source::Source;
use super::spotdl::requested_file_name;
use super::{JobError, Wanted};

const TOOL: &str = "yt-dlp";
const COMMAND_TIMEOUT: Duration = Duration::from_secs(6 * 60);
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
/// Modèle de nom, relatif au dossier donné par `-P` (un `-o` absolu ferait ignorer `-P`).
const OUTPUT_TEMPLATE: &str = "%(title)s.%(ext)s";

#[derive(Clone, Copy)]
struct Runner {
    executable: &'static str,
    module: bool,
}

impl Runner {
    fn command(self) -> Command {
        let mut command = Command::new(self.executable);
        if self.module {
            command.arg("-m").arg("yt_dlp");
        }
        command
    }
}

pub struct YtDlpSource;

impl Source for YtDlpSource {
    fn name(&self) -> &'static str {
        TOOL
    }

    fn available(&self) -> bool {
        resolve_runner(&AtomicBool::new(false)).is_ok()
    }

    fn fetch(&self, wanted: &Wanted, dest_dir: &Path, cancel: &AtomicBool) -> Result<PathBuf, JobError> {
        if cancel.load(Ordering::Relaxed) {
            return Err(JobError::Cancelled);
        }
        let runner = resolve_runner(cancel)?;
        let query = make_query(wanted)?;
        let attempt_dir = create_attempt_directory(dest_dir)?;
        let file_name = requested_file_name(wanted);

        let result = match run_download(runner, &query, &attempt_dir, cancel) {
            Ok(Bounded::Finished { status, .. }) if status.success() => take_output(&attempt_dir, &file_name, TOOL),
            Ok(Bounded::Finished { stdout, stderr, .. }) => Err(classify_failure(&stdout, &stderr)),
            Ok(Bounded::TimedOut { .. }) => Err(JobError::Timeout),
            Ok(Bounded::Cancelled { .. }) => Err(JobError::Cancelled),
            Err(error) => Err(error),
        };
        if result.is_err() {
            cleanup_attempt(&attempt_dir);
        }
        result
    }
}

fn resolve_runner(cancel: &AtomicBool) -> Result<Runner, JobError> {
    let mut candidates = vec![Runner { executable: "yt-dlp", module: false }];
    #[cfg(windows)]
    candidates.push(Runner { executable: "py", module: true });
    candidates.push(Runner { executable: "python", module: true });

    let mut last_error = None;
    for runner in candidates {
        if cancel.load(Ordering::Relaxed) {
            return Err(JobError::Cancelled);
        }
        let mut command = runner.command();
        command.arg("--version");
        match run_command(&mut command, PROBE_TIMEOUT, cancel) {
            Ok(Bounded::Finished { status, .. }) if status.success() => return Ok(runner),
            Ok(Bounded::Finished { stdout, stderr, .. }) => last_error = Some(join_logs(&stdout, &stderr, TOOL)),
            Ok(Bounded::TimedOut { .. }) => return Err(JobError::Timeout),
            Ok(Bounded::Cancelled { .. }) => return Err(JobError::Cancelled),
            Err(JobError::ToolMissing(_)) => {}
            Err(error) => last_error = Some(error.to_string()),
        }
    }
    let detail = last_error.unwrap_or_else(|| "yt-dlp est introuvable. Installez-le séparément puis redémarrez Music Player.".to_owned());
    Err(JobError::ToolMissing(truncate_log(&detail)))
}

/// Une seule recherche YouTube, le meilleur résultat (`ytsearch1:`).
fn make_query(wanted: &Wanted) -> Result<String, JobError> {
    super::spotdl::make_query(wanted).map(|search| format!("ytsearch1:{search}"))
}

fn run_download(runner: Runner, query: &str, attempt_dir: &Path, cancel: &AtomicBool) -> Result<Bounded, JobError> {
    let mut command = runner.command();
    command
        .arg("--ignore-config")
        .arg("--no-playlist")
        .arg("--extract-audio")
        .arg("--audio-format")
        .arg("mp3")
        .arg("--audio-quality")
        .arg("0")
        .arg("--embed-metadata")
        .arg("--no-write-info-json")
        .arg("--no-write-thumbnail")
        .arg("--restrict-filenames")
        .arg("--retries")
        .arg("3")
        .arg("--fragment-retries")
        .arg("3")
        .arg("--extractor-retries")
        .arg("3")
        .arg("--newline")
        .arg("--paths")
        .arg(attempt_dir)
        .arg("--output")
        .arg(OUTPUT_TEMPLATE)
        .arg("--print")
        .arg("after_move:filepath")
        // Le séparateur empêche la recherche d'être interprétée comme une option.
        .arg("--")
        .arg(query);
    run_command(&mut command, COMMAND_TIMEOUT, cancel)
}

fn run_command(command: &mut Command, timeout: Duration, cancel: &AtomicBool) -> Result<Bounded, JobError> {
    ffmpeg::quiet(command);
    bounded::run(command, timeout, cancel).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            JobError::ToolMissing("yt-dlp est introuvable. Installez-le séparément puis redémarrez Music Player.".to_owned())
        } else {
            JobError::Failed(format!("Impossible de lancer yt-dlp : {error}"))
        }
    })
}

fn classify_failure(stdout: &str, stderr: &str) -> JobError {
    let detail = join_logs(stdout, stderr, TOOL);
    let lower = detail.to_lowercase();
    if ffmpeg_missing(&lower) {
        return JobError::ToolMissing("FFmpeg est introuvable ; yt-dlp en a besoin pour extraire l'audio.".to_owned());
    }
    if lower.contains("no video results")
        || lower.contains("no matches found")
        || lower.contains("no results")
        || lower.contains("unable to download webpage: http error 404")
    {
        return JobError::NotFound;
    }
    if network_failure(&lower) {
        return JobError::Network(truncate_log(&detail));
    }
    JobError::Failed(truncate_log(&detail))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicBool;

    use super::{classify_failure, make_query, YtDlpSource, OUTPUT_TEMPLATE};
    use crate::fetch::source::Source;
    use crate::fetch::{JobError, Wanted};

    fn wanted(title: &str, artist: &str) -> Wanted {
        Wanted { title: title.to_owned(), artist: artist.to_owned(), album: String::new(), duration_secs: Some(180.0), playlist_id: None }
    }

    #[test]
    fn recherche_un_seul_resultat_et_garde_la_recherche_en_argument_unique() {
        assert_eq!(make_query(&wanted("Titre --help", "Artiste")).expect("recherche"), "ytsearch1:Artiste - Titre --help");
    }

    #[test]
    fn refuse_un_titre_vide() {
        assert!(make_query(&wanted(" ", "Artiste")).is_err());
    }

    #[test]
    fn le_modele_de_sortie_est_relatif_et_sans_dossier() {
        // Le dossier passe par `-P` : un `%` dans son nom ne peut pas être pris pour une variable.
        assert!(OUTPUT_TEMPLATE.contains("%(title)s") && OUTPUT_TEMPLATE.ends_with("%(ext)s"));
        assert!(!OUTPUT_TEMPLATE.contains('/') && !OUTPUT_TEMPLATE.contains('\\'));
    }

    #[test]
    fn expose_un_nom_de_source_stable() {
        assert_eq!(YtDlpSource.name(), "yt-dlp");
    }

    #[test]
    fn une_annulation_preexistante_est_detectee_avant_le_lancement() {
        let cancel = AtomicBool::new(true);
        let result = YtDlpSource.fetch(&wanted("Titre", "Artiste"), std::path::Path::new("."), &cancel);
        assert!(matches!(result, Err(JobError::Cancelled)));
    }

    #[test]
    fn classe_les_echecs() {
        assert!(matches!(classify_failure("", "ERROR: ffmpeg not found. Please install"), JobError::ToolMissing(_)));
        assert!(matches!(classify_failure("", "ERROR: [youtube:search] No video results"), JobError::NotFound));
        assert!(matches!(classify_failure("", "ERROR: Unable to download webpage: HTTP Error 404"), JobError::NotFound));
        assert!(matches!(classify_failure("", "ERROR: HTTP Error 429: Too Many Requests"), JobError::Network(_)));
    }
}
