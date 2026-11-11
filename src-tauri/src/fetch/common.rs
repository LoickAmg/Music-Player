//! Ce que les adaptateurs (spotDL, yt-dlp) font de la même façon : dossier propre à la tâche,
//! reprise du fichier créé par l'outil, journaux et nettoyage.

use std::fs;
use std::path::{Path, PathBuf};

use super::source::{plain_path, safe_output_path};
use super::JobError;

/// Journal d'un outil gardé dans un message d'erreur, au plus.
pub const MAX_LOG_CHARS: usize = 12_000;

/// Dossier propre à la tâche, dans `dest_dir` (chemin sans préfixe `\\?\` sous Windows).
pub fn create_attempt_directory(dest_dir: &Path) -> Result<PathBuf, JobError> {
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

/// Reprend l'unique fichier `.mp3` créé par l'outil dans le dossier de la tâche (son nom vient
/// de l'outil) et le renomme sous `file_name`, dans le même dossier. Liens symboliques, fichier
/// vide ou fichiers multiples refusés.
pub fn take_output(attempt_dir: &Path, file_name: &str, tool: &str) -> Result<PathBuf, JobError> {
    let entries = fs::read_dir(attempt_dir)
        .map_err(|error| JobError::Failed(format!("Impossible de lire le dossier du morceau : {error}")))?;
    let mut produced: Option<PathBuf> = None;
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        let path = entry.path();
        let is_mp3 = path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("mp3"));
        if kind.is_file() && !kind.is_symlink() && is_mp3 {
            if produced.is_some() {
                return Err(JobError::Failed(format!("{tool} a créé plusieurs fichiers pour un seul morceau.")));
            }
            produced = Some(path);
        }
    }
    let produced = produced.ok_or(JobError::NotFound)?;
    let size = fs::metadata(&produced)
        .map_err(|error| JobError::Failed(format!("Impossible de vérifier le fichier téléchargé : {error}")))?
        .len();
    if size == 0 {
        return Err(JobError::Failed(format!("{tool} a terminé, mais le fichier audio est vide.")));
    }
    let target = safe_output_path(attempt_dir, file_name).map_err(|error| JobError::UnsafePath(error.to_string()))?;
    if produced != target {
        fs::rename(&produced, &target)
            .map_err(|error| JobError::Failed(format!("Impossible de renommer le fichier téléchargé : {error}")))?;
    }
    Ok(target)
}

/// Les deux sorties d'un outil réunies (erreurs d'abord).
pub fn join_logs(stdout: &str, stderr: &str, tool: &str) -> String {
    match (stdout.trim(), stderr.trim()) {
        ("", "") => format!("{tool} a échoué sans fournir de journal."),
        ("", error) => error.to_owned(),
        (output, "") => output.to_owned(),
        (output, error) => format!("{error}\n{output}"),
    }
}

pub fn truncate_log(text: &str) -> String {
    let mut chars = text.chars();
    let kept: String = chars.by_ref().take(MAX_LOG_CHARS).collect();
    if chars.next().is_some() {
        format!("{kept}…")
    } else {
        kept
    }
}

/// Efface le dossier de la tâche et tout ce que l'outil a pu y laisser (fichier partiel…).
pub fn cleanup_attempt(attempt_dir: &Path) {
    let _ = fs::remove_dir_all(attempt_dir);
}

/// FFmpeg absent : à reconnaître avant « introuvable » (« ffmpeg not found » contient « not found »).
pub fn ffmpeg_missing(lower_log: &str) -> bool {
    lower_log.contains("ffmpeg") && (lower_log.contains("not found") || lower_log.contains("not installed") || lower_log.contains("no such file"))
}

/// Erreur réseau ou limitation du service (un nouvel essai peut réussir).
pub fn network_failure(lower_log: &str) -> bool {
    [
        "timed out",
        "timeout",
        "connection",
        "network",
        "http error",
        "429",
        "503",
        "name resolution",
    ]
    .iter()
    .any(|needle| lower_log.contains(needle))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{create_attempt_directory, take_output, truncate_log, MAX_LOG_CHARS};
    use crate::fetch::JobError;

    #[test]
    fn reprend_le_fichier_cree_par_l_outil_et_le_renomme() {
        let root = tempfile::tempdir().expect("dossier");
        let attempt = create_attempt_directory(root.path()).expect("dossier de tâche");
        assert!(!attempt.to_string_lossy().starts_with(r"\\?\"));
        let made = attempt.join("Damso - Bruxelles vie.mp3");
        fs::write(&made, b"ID3audio").expect("faux fichier");
        let out = take_output(&attempt, "Damso - Bruxelles vie (2017).mp3", "spotDL").expect("fichier repris");
        assert_eq!(out.file_name().and_then(|n| n.to_str()), Some("Damso - Bruxelles vie (2017).mp3"));
        assert!(out.is_file() && !made.exists());
    }

    #[test]
    fn refuse_un_fichier_vide_absent_ou_en_double() {
        let root = tempfile::tempdir().expect("dossier");
        let attempt = create_attempt_directory(root.path()).expect("dossier de tâche");
        assert!(matches!(take_output(&attempt, "x.mp3", "yt-dlp"), Err(JobError::NotFound)));
        fs::write(attempt.join("a.mp3"), b"").expect("vide");
        assert!(matches!(take_output(&attempt, "x.mp3", "yt-dlp"), Err(JobError::Failed(_))));
        fs::write(attempt.join("a.mp3"), b"son").expect("plein");
        fs::write(attempt.join("b.mp3"), b"son").expect("double");
        assert!(matches!(take_output(&attempt, "x.mp3", "yt-dlp"), Err(JobError::Failed(_))));
    }

    #[test]
    fn coupe_un_journal_trop_long() {
        let long = "é".repeat(MAX_LOG_CHARS + 10);
        assert_eq!(truncate_log(&long).chars().count(), MAX_LOG_CHARS + 1);
    }
}
