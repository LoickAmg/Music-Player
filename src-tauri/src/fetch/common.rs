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

/// Exécutables d'un outil Python installé hors du `PATH` : Anaconda/Miniconda (base et
/// environnements, celui qui porte le nom de l'outil d'abord), uv/pipx (`~/.local/bin`) et
/// les dossiers `Scripts` de Python. Seuls les fichiers existants sont rendus, sans doublon.
pub fn tool_locations(tool: &str) -> Vec<PathBuf> {
    let exe = if cfg!(windows) { format!("{tool}.exe") } else { tool.to_owned() };
    let mut dirs: Vec<PathBuf> = Vec::new();
    let env_dir = |name: &str| std::env::var_os(name).map(PathBuf::from);
    let home = env_dir(if cfg!(windows) { "USERPROFILE" } else { "HOME" });

    let mut conda_roots: Vec<PathBuf> = Vec::new();
    for base in [env_dir("ProgramData"), home.clone(), env_dir("LOCALAPPDATA")].into_iter().flatten() {
        for name in ["anaconda3", "miniconda3", "miniforge3", "mambaforge"] {
            conda_roots.push(base.join(name));
        }
    }
    let bin = if cfg!(windows) { "Scripts" } else { "bin" };
    for root in conda_roots.iter().filter(|root| root.is_dir()) {
        dirs.push(root.join("envs").join(tool).join(bin));
        if let Ok(entries) = fs::read_dir(root.join("envs")) {
            dirs.extend(entries.flatten().map(|entry| entry.path().join(bin)));
        }
        dirs.push(root.join(bin));
    }
    if let Some(home) = &home {
        dirs.push(home.join(".local").join("bin"));
    }
    #[cfg(windows)]
    for base in [env_dir("APPDATA").map(|d| d.join("Python")), env_dir("LOCALAPPDATA").map(|d| d.join("Programs").join("Python"))]
        .into_iter()
        .flatten()
    {
        if let Ok(entries) = fs::read_dir(&base) {
            dirs.extend(entries.flatten().map(|entry| entry.path().join("Scripts")));
        }
    }
    #[cfg(not(windows))]
    dirs.extend([PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")]);

    let mut found: Vec<PathBuf> = Vec::new();
    for candidate in dirs.into_iter().map(|dir| dir.join(&exe)) {
        if candidate.is_file() && !found.contains(&candidate) {
            found.push(candidate);
        }
    }
    found
}

/// FFmpeg pour yt-dlp quand il n'est pas dans le `PATH` : celui que spotDL installe
/// (`spotdl --download-ffmpeg`, dans `~/.spotdl`).
pub fn spotdl_ffmpeg() -> Option<PathBuf> {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })?;
    let path = PathBuf::from(home).join(".spotdl").join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
    path.is_file().then_some(path)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{create_attempt_directory, take_output, tool_locations, truncate_log, MAX_LOG_CHARS};

    #[test]
    fn ne_rend_que_des_executables_existants() {
        assert!(tool_locations("outil-qui-n-existe-pas-xyz").is_empty());
        assert!(tool_locations("cmd").iter().all(|path| path.is_file()));
    }
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
