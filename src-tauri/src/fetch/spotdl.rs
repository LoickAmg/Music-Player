//! Adaptateur spotDL : la recherche et le téléchargement restent confiés à
//! l'outil externe, avec une sortie confinée à un dossier propre à la tâche.
//!
//! spotDL ne prend pas un nom de fichier mais un modèle (`--output`) : il y ajoute
//! `.{output-ext}` s'il manque, et traite un modèle sans variable comme un dossier. On lui
//! donne donc un modèle à variables dans le dossier de la tâche, puis on reprend le fichier
//! qu'il a réellement créé et on le renomme sous un nom sûr.

use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::bounded::{self, Bounded};
use crate::ffmpeg;

use super::common::{cleanup_attempt, create_attempt_directory, ffmpeg_missing, join_logs, network_failure, take_output, truncate_log};
use super::source::{sanitize_file_name, Source};
use super::{JobError, Wanted};

const TOOL: &str = "spotDL";
const COMMAND_TIMEOUT: Duration = Duration::from_secs(6 * 60);
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
/// Modèle de nom de spotDL (variables remplacées par spotDL, valeurs nettoyées par lui).
const OUTPUT_TEMPLATE: &str = "{artists} - {title}.{output-ext}";

#[derive(Clone, Copy)]
struct Runner {
    executable: &'static str,
    module: bool,
}

impl Runner {
    fn command(self) -> Command {
        let mut command = Command::new(self.executable);
        if self.module {
            command.arg("-m").arg("spotdl");
        }
        command
    }
}

pub struct SpotDlSource;

impl Source for SpotDlSource {
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
    let mut candidates = vec![Runner { executable: "spotdl", module: false }];
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
    let detail = last_error
        .unwrap_or_else(|| "spotDL est introuvable. Installez-le séparément avec Python ou ajoutez spotdl au PATH.".to_owned());
    Err(JobError::ToolMissing(truncate_log(&detail)))
}

pub(super) fn make_query(wanted: &Wanted) -> Result<String, JobError> {
    let title = wanted.title.trim();
    let artist = wanted.artist.trim();
    if title.is_empty() {
        return Err(JobError::Failed("Le titre du morceau est vide ; recherche annulée.".to_owned()));
    }
    let query = if artist.is_empty() { title.to_owned() } else { format!("{artist} - {title}") };
    if query.len() > 1_024 {
        return Err(JobError::Failed("La recherche dépasse la taille autorisée.".to_owned()));
    }
    Ok(query)
}

/// Nom du fichier rangé dans la bibliothèque : « Artiste - Titre.mp3 », nettoyé.
pub(super) fn requested_file_name(wanted: &Wanted) -> String {
    let raw = if wanted.artist.trim().is_empty() {
        wanted.title.trim().to_owned()
    } else {
        format!("{} - {}", wanted.artist.trim(), wanted.title.trim())
    };
    sanitize_file_name(&raw, "mp3")
}

fn run_download(runner: Runner, query: &str, attempt_dir: &Path, cancel: &AtomicBool) -> Result<Bounded, JobError> {
    let mut command = runner.command();
    command
        .arg("download")
        .arg("--format")
        .arg("mp3")
        .arg("--output")
        .arg(attempt_dir.join(OUTPUT_TEMPLATE))
        .arg("--overwrite")
        .arg("skip")
        .arg("--max-retries")
        .arg("3")
        .arg("--threads")
        .arg("2")
        .arg("--log-level")
        .arg("INFO")
        .arg("--print-errors")
        .arg("--headless")
        // Le séparateur empêche un titre commençant par « - » d'être lu comme une option.
        .arg("--")
        .arg(query);
    run_command(&mut command, COMMAND_TIMEOUT, cancel)
}

fn run_command(command: &mut Command, timeout: Duration, cancel: &AtomicBool) -> Result<Bounded, JobError> {
    ffmpeg::quiet(command);
    bounded::run(command, timeout, cancel).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            JobError::ToolMissing("spotDL est introuvable. Installez-le séparément puis redémarrez Music Player.".to_owned())
        } else {
            JobError::Failed(format!("Impossible de lancer spotDL : {error}"))
        }
    })
}

fn classify_failure(stdout: &str, stderr: &str) -> JobError {
    let detail = join_logs(stdout, stderr, TOOL);
    let lower = detail.to_lowercase();
    if ffmpeg_missing(&lower) {
        return JobError::ToolMissing("FFmpeg est introuvable : lancez « spotdl --download-ffmpeg » puis réessayez.".to_owned());
    }
    if lower.contains("no results") || lower.contains("no song") || lower.contains("no match") || lower.contains("not found") {
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

    use super::{classify_failure, make_query, SpotDlSource, OUTPUT_TEMPLATE};
    use crate::fetch::source::Source;
    use crate::fetch::{JobError, Wanted};

    fn wanted(title: &str, artist: &str) -> Wanted {
        Wanted { title: title.to_owned(), artist: artist.to_owned(), album: String::new(), duration_secs: Some(180.0), playlist_id: None }
    }

    #[test]
    fn garde_la_recherche_dans_un_argument_unique() {
        assert_eq!(make_query(&wanted("Titre --help", "Artiste")).expect("recherche"), "Artiste - Titre --help");
    }

    #[test]
    fn refuse_un_titre_vide() {
        assert!(make_query(&wanted(" ", "Artiste")).is_err());
    }

    #[test]
    fn expose_un_nom_de_source_stable() {
        assert_eq!(SpotDlSource.name(), "spotDL");
    }

    #[test]
    fn une_annulation_preexistante_est_detectee_avant_le_lancement() {
        let cancel = AtomicBool::new(true);
        let result = SpotDlSource.fetch(&wanted("Titre", "Artiste"), std::path::Path::new("."), &cancel);
        assert!(matches!(result, Err(JobError::Cancelled)));
    }

    #[test]
    fn le_modele_de_sortie_a_des_variables_et_son_extension() {
        // Sans variable, spotDL prendrait le modèle pour un dossier ; sans `.{output-ext}`, il l'ajouterait.
        assert!(OUTPUT_TEMPLATE.contains("{title}") && OUTPUT_TEMPLATE.ends_with(".{output-ext}"));
    }

    #[test]
    fn classe_les_echecs() {
        assert!(matches!(classify_failure("", "FileNotFoundError: ffmpeg not found"), JobError::ToolMissing(_)));
        assert!(matches!(classify_failure("No results found for song", ""), JobError::NotFound));
        assert!(matches!(classify_failure("", "HTTP Error 429: Too Many Requests"), JobError::Network(_)));
        assert!(matches!(classify_failure("", "Traceback: KeyError"), JobError::Failed(_)));
    }
}
