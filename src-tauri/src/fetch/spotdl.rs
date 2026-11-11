//! Adaptateur spotDL : la recherche et le téléchargement restent confiés à
//! l'outil externe, avec une sortie confinée à un dossier propre à la tâche.
//!
//! spotDL ne prend pas un nom de fichier mais un modèle (`--output`) : il y ajoute
//! `.{output-ext}` s'il manque, et traite un modèle sans variable comme un dossier. On lui
//! donne donc un modèle à variables dans le dossier de la tâche, puis on reprend le fichier
//! qu'il a réellement créé et on le renomme sous un nom sûr.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::bounded::{self, Bounded};
use crate::ffmpeg;

use super::source::{plain_path, safe_output_path, sanitize_file_name, Source};
use super::{JobError, Wanted};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(6 * 60);
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_LOG_CHARS: usize = 12_000;
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
        "spotDL"
    }

    fn available(&self) -> bool {
        let cancel = AtomicBool::new(false);
        resolve_runner(&cancel).is_ok()
    }

    fn fetch(&self, wanted: &Wanted, dest_dir: &Path, cancel: &AtomicBool) -> Result<PathBuf, JobError> {
        if cancel.load(Ordering::Relaxed) {
            return Err(JobError::Cancelled);
        }

        let runner = resolve_runner(cancel)?;
        let query = make_query(wanted)?;
        let attempt_dir = create_attempt_directory(dest_dir)?;
        let raw_name = if wanted.artist.trim().is_empty() {
            wanted.title.trim().to_owned()
        } else {
            format!("{} - {}", wanted.artist.trim(), wanted.title.trim())
        };
        let file_name = sanitize_file_name(&raw_name, "mp3");

        match run_download(runner, &query, &attempt_dir, cancel) {
            Ok(Bounded::Finished { status, .. }) if status.success() => {
                let result = take_output(&attempt_dir, &file_name);
                if result.is_err() {
                    cleanup_attempt(&attempt_dir);
                }
                result
            }
            Ok(Bounded::Finished { stdout, stderr, .. }) => {
                cleanup_attempt(&attempt_dir);
                Err(classify_failure(&stdout, &stderr))
            }
            Ok(Bounded::TimedOut { .. }) => {
                cleanup_attempt(&attempt_dir);
                Err(JobError::Timeout)
            }
            Ok(Bounded::Cancelled { .. }) => {
                cleanup_attempt(&attempt_dir);
                Err(JobError::Cancelled)
            }
            Err(error) => {
                cleanup_attempt(&attempt_dir);
                Err(error)
            }
        }
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
            Ok(Bounded::Finished { stdout, stderr, .. }) => last_error = Some(join_logs(&stdout, &stderr)),
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

fn make_query(wanted: &Wanted) -> Result<String, JobError> {
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

/// Dossier propre à la tâche, dans `dest_dir` (chemin sans préfixe `\\?\` sous Windows).
fn create_attempt_directory(dest_dir: &Path) -> Result<PathBuf, JobError> {
    fs::create_dir_all(dest_dir)
        .map_err(|error| JobError::UnsafePath(format!("Impossible de préparer le dossier de téléchargement : {error}")))?;
    let root = plain_path(
        dest_dir
            .canonicalize()
            .map_err(|error| JobError::UnsafePath(format!("Impossible de résoudre le dossier de téléchargement : {error}")))?,
    );
    let attempt_dir = root.join(uuid::Uuid::new_v4().simple().to_string());
    fs::create_dir(&attempt_dir)
        .map_err(|error| JobError::Failed(format!("Impossible de créer le dossier temporaire du morceau : {error}")))?;
    Ok(attempt_dir)
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

/// Reprend le fichier audio créé par spotDL dans le dossier de la tâche (son nom vient de
/// spotDL) et le renomme sous `file_name`, dans le même dossier. Un seul fichier attendu ;
/// les liens symboliques et les fichiers vides sont refusés.
fn take_output(attempt_dir: &Path, file_name: &str) -> Result<PathBuf, JobError> {
    let entries = fs::read_dir(attempt_dir)
        .map_err(|error| JobError::Failed(format!("Impossible de lire le dossier du morceau : {error}")))?;
    let mut produced: Option<PathBuf> = None;
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        let path = entry.path();
        let is_audio = path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("mp3"));
        if kind.is_file() && !kind.is_symlink() && is_audio {
            if produced.is_some() {
                return Err(JobError::Failed("spotDL a créé plusieurs fichiers pour un seul morceau.".to_owned()));
            }
            produced = Some(path);
        }
    }
    let produced = produced.ok_or(JobError::NotFound)?;
    let size = fs::metadata(&produced)
        .map_err(|error| JobError::Failed(format!("Impossible de vérifier le fichier téléchargé : {error}")))?
        .len();
    if size == 0 {
        return Err(JobError::Failed("spotDL a terminé, mais le fichier audio est vide.".to_owned()));
    }
    let target = safe_output_path(attempt_dir, file_name).map_err(|error| JobError::UnsafePath(error.to_string()))?;
    if produced != target {
        fs::rename(&produced, &target)
            .map_err(|error| JobError::Failed(format!("Impossible de renommer le fichier téléchargé : {error}")))?;
    }
    Ok(target)
}

fn classify_failure(stdout: &str, stderr: &str) -> JobError {
    let detail = join_logs(stdout, stderr);
    let lower = detail.to_lowercase();

    // Outils absents d'abord : « FileNotFoundError: ffmpeg » contient aussi « not found ».
    if lower.contains("ffmpeg") && (lower.contains("not found") || lower.contains("not installed") || lower.contains("no such file")) {
        return JobError::ToolMissing("FFmpeg est introuvable : lancez « spotdl --download-ffmpeg » puis réessayez.".to_owned());
    }
    if lower.contains("no results") || lower.contains("no song") || lower.contains("no match") || lower.contains("not found") {
        return JobError::NotFound;
    }
    if lower.contains("timed out")
        || lower.contains("timeout")
        || lower.contains("connection")
        || lower.contains("network")
        || lower.contains("http error")
        || lower.contains("429")
        || lower.contains("503")
    {
        return JobError::Network(truncate_log(&detail));
    }
    JobError::Failed(truncate_log(&detail))
}

fn join_logs(stdout: &str, stderr: &str) -> String {
    match (stdout.trim(), stderr.trim()) {
        ("", "") => "spotDL a échoué sans fournir de journal.".to_owned(),
        ("", error) => error.to_owned(),
        (output, "") => output.to_owned(),
        (output, error) => format!("{error}\n{output}"),
    }
}

fn truncate_log(text: &str) -> String {
    let mut chars = text.chars();
    let kept: String = chars.by_ref().take(MAX_LOG_CHARS).collect();
    if chars.next().is_some() {
        format!("{kept}…")
    } else {
        kept
    }
}

/// Efface le dossier de la tâche et tout ce que spotDL a pu y laisser (fichier partiel…).
fn cleanup_attempt(attempt_dir: &Path) {
    let _ = fs::remove_dir_all(attempt_dir);
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::atomic::AtomicBool;

    use super::{classify_failure, create_attempt_directory, make_query, take_output, SpotDlSource, OUTPUT_TEMPLATE};
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
    fn reprend_le_fichier_cree_par_spotdl_et_le_renomme() {
        let root = tempfile::tempdir().expect("dossier");
        let attempt = create_attempt_directory(root.path()).expect("dossier de tâche");
        assert!(!attempt.to_string_lossy().starts_with(r"\\?\"));
        fs::write(attempt.join("Damso - Bruxelles vie.mp3"), b"ID3audio").expect("faux fichier");
        let out = take_output(&attempt, "Damso - Bruxelles vie (2017).mp3").expect("fichier repris");
        assert_eq!(out.file_name().and_then(|n| n.to_str()), Some("Damso - Bruxelles vie (2017).mp3"));
        assert!(out.is_file());
    }

    #[test]
    fn refuse_un_fichier_vide_absent_ou_en_double() {
        let root = tempfile::tempdir().expect("dossier");
        let attempt = create_attempt_directory(root.path()).expect("dossier de tâche");
        assert!(matches!(take_output(&attempt, "x.mp3"), Err(JobError::NotFound)));
        fs::write(attempt.join("a.mp3"), b"").expect("vide");
        assert!(matches!(take_output(&attempt, "x.mp3"), Err(JobError::Failed(_))));
        fs::write(attempt.join("a.mp3"), b"son").expect("plein");
        fs::write(attempt.join("b.mp3"), b"son").expect("double");
        assert!(matches!(take_output(&attempt, "x.mp3"), Err(JobError::Failed(_))));
    }

    #[test]
    fn classe_les_echecs() {
        assert!(matches!(classify_failure("", "FileNotFoundError: ffmpeg not found"), JobError::ToolMissing(_)));
        assert!(matches!(classify_failure("No results found for song", ""), JobError::NotFound));
        assert!(matches!(classify_failure("", "HTTP Error 429: Too Many Requests"), JobError::Network(_)));
        assert!(matches!(classify_failure("", "Traceback: KeyError"), JobError::Failed(_)));
    }
}
