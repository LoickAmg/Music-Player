//! Contrat des sources audio et validation des chemins de sortie.
//!
//! Les adaptateurs reçoivent les recherches comme données et construisent leurs
//! commandes avec des arguments séparés. Ce module ne lance aucun interpréteur
//! de commandes.

use std::error::Error;
use std::fmt;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::AtomicBool;

use super::{JobError, Wanted};

/// Adaptateur remplaçable pour une source de téléchargement.
pub trait Source: Send + Sync {
    fn name(&self) -> &'static str;

    /// Indique si le programme requis par cette source est disponible.
    fn available(&self) -> bool;

    fn fetch(
        &self,
        wanted: &Wanted,
        dest_dir: &Path,
        cancel: &AtomicBool,
    ) -> Result<PathBuf, JobError>;
}

#[derive(Debug)]
pub enum SafePathError {
    DestinationUnavailable(std::io::Error),
    DestinationNotDirectory,
    InvalidFileName(&'static str),
    OutputIsNotFile,
    OutputIsSymlink,
    OutputUnavailable(std::io::Error),
}

impl fmt::Display for SafePathError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DestinationUnavailable(error) => {
                write!(formatter, "Dossier de destination inaccessible : {error}")
            }
            Self::DestinationNotDirectory => {
                write!(formatter, "La destination n'est pas un dossier.")
            }
            Self::InvalidFileName(reason) => {
                write!(formatter, "Nom de fichier refusé : {reason}")
            }
            Self::OutputIsNotFile => {
                write!(formatter, "La sortie existe et n'est pas un fichier.")
            }
            Self::OutputIsSymlink => {
                write!(formatter, "La sortie est un lien symbolique ; écriture refusée.")
            }
            Self::OutputUnavailable(error) => {
                write!(formatter, "Sortie inaccessible : {error}")
            }
        }
    }
}

impl Error for SafePathError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::DestinationUnavailable(error) | Self::OutputUnavailable(error) => Some(error),
            _ => None,
        }
    }
}

/// Produit un nom simple à partir d'un titre ou d'un nom de fichier externe.
///
/// Les caractères interdits par Windows ou interprétables comme séparateurs de
/// chemin sont remplacés. L'extension est limitée aux lettres et chiffres.
pub fn sanitize_file_name(input: &str, extension: &str) -> String {
    let mut stem = String::with_capacity(input.len());

    for character in input.chars() {
        let safe = match character {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            character if character.is_control() => '_',
            character => character,
        };
        stem.push(safe);
    }

    let stem = stem.trim().trim_matches('.').trim_end_matches(' ');
    // Coupé en octets, au bord d'un caractère : un titre japonais de 180 caractères dépasserait la
    // limite de 240 octets de `validate_file_name` (3 octets par caractère).
    let mut end = 0;
    for (index, character) in stem.char_indices() {
        if index + character.len_utf8() > 200 {
            break;
        }
        end = index + character.len_utf8();
    }
    let mut stem: String = stem[..end].trim_end_matches([' ', '.']).to_owned();

    if stem.is_empty() || stem == "." || stem == ".." {
        stem = "morceau".to_owned();
    }

    if is_reserved_windows_name(&stem) {
        stem.insert(0, '_');
    }

    let extension: String = extension
        .trim()
        .trim_start_matches('.')
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(12)
        .flat_map(char::to_lowercase)
        .collect();

    if extension.is_empty() {
        stem
    } else {
        format!("{stem}.{extension}")
    }
}

/// Construit un chemin de sortie directement dans `dest_dir`.
///
/// Seuls les noms simples sont acceptés : les chemins absolus, séparateurs,
/// répertoires parents, noms réservés Windows et sorties qui sont des liens
/// symboliques sont refusés.
pub fn safe_output_path(
    dest_dir: &Path,
    file_name: &str,
) -> Result<PathBuf, SafePathError> {
    validate_file_name(file_name)?;

    let destination = plain_path(dest_dir.canonicalize().map_err(SafePathError::DestinationUnavailable)?);

    if !destination.is_dir() {
        return Err(SafePathError::DestinationNotDirectory);
    }

    let output = destination.join(file_name);

    match fs::symlink_metadata(&output) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(SafePathError::OutputIsSymlink);
        }
        Ok(metadata) if !metadata.is_file() => {
            return Err(SafePathError::OutputIsNotFile);
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(SafePathError::OutputUnavailable(error)),
    }

    // Le contrôle sur le nom interdit déjà les séparateurs. Cette vérification
    // garde aussi la garantie de confinement explicite dans le code.
    if output.parent() != Some(destination.as_path()) {
        return Err(SafePathError::InvalidFileName(
            "le chemin sort du dossier de destination",
        ));
    }

    Ok(output)
}

/// Sous Windows, `canonicalize` renvoie un chemin préfixé par `\\?\` : un autre chemin que celui
/// trouvé par le scan de la bibliothèque (morceau en double), et mal compris de certains outils.
/// On revient à la forme habituelle (`C:\…`, `\\serveur\partage\…`).
pub(crate) fn plain_path(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    match text.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        _ => path,
    }
}

fn validate_file_name(file_name: &str) -> Result<(), SafePathError> {
    if file_name.is_empty() {
        return Err(SafePathError::InvalidFileName("nom vide"));
    }

    if file_name == "." || file_name == ".." {
        return Err(SafePathError::InvalidFileName(
            "nom de répertoire interdit",
        ));
    }

    if file_name.len() > 240 {
        return Err(SafePathError::InvalidFileName(
            "nom trop long (240 octets maximum)",
        ));
    }

    if file_name.ends_with('.') || file_name.ends_with(' ') {
        return Err(SafePathError::InvalidFileName(
            "le nom ne peut pas finir par un point ou une espace",
        ));
    }

    if file_name.chars().any(|character| {
        character.is_control()
            || matches!(
                character,
                '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            )
    }) {
        return Err(SafePathError::InvalidFileName(
            "séparateur ou caractère interdit",
        ));
    }

    let path = Path::new(file_name);
    let mut components = path.components();

    if path.is_absolute()
        || !matches!(components.next(), Some(Component::Normal(_)))
        || components.next().is_some()
    {
        return Err(SafePathError::InvalidFileName(
            "seul un nom de fichier simple est accepté",
        ));
    }

    if is_reserved_windows_name(file_name) {
        return Err(SafePathError::InvalidFileName(
            "nom réservé par Windows",
        ));
    }

    Ok(())
}

fn is_reserved_windows_name(file_name: &str) -> bool {
    let basename = file_name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches([' ', '.'])
        .to_ascii_uppercase();

    matches!(basename.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || is_numbered_device_name(&basename, "COM")
        || is_numbered_device_name(&basename, "LPT")
}

fn is_numbered_device_name(name: &str, prefix: &str) -> bool {
    let Some(number) = name.strip_prefix(prefix) else {
        return false;
    };

    matches!(
        number,
        "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
    )
}

#[cfg(test)]
mod tests {
    use super::{safe_output_path, sanitize_file_name, SafePathError};

    #[test]
    fn accepte_un_nom_simple_dans_le_dossier() {
        let directory = tempfile::tempdir().expect("dossier temporaire");

        let output = safe_output_path(directory.path(), "Artiste - Morceau.mp3")
            .expect("chemin sûr");

        let expected = super::plain_path(directory.path().canonicalize().expect("chemin canonique"));
        assert_eq!(output.parent(), Some(expected.as_path()));
        assert!(!output.to_string_lossy().starts_with(r"\\?\"), "préfixe \\?\\ restant : {}", output.display());
        assert_eq!(output.file_name().and_then(|name| name.to_str()), Some("Artiste - Morceau.mp3"));
    }

    #[test]
    fn refuse_les_chemins_et_separateurs() {
        let directory = tempfile::tempdir().expect("dossier temporaire");

        for name in [
            "../hors-dossier.mp3",
            "sous-dossier/morceau.mp3",
            r"sous-dossier\morceau.mp3",
            r"C:\musique\morceau.mp3",
            "",
            ".",
            "..",
        ] {
            assert!(
                safe_output_path(directory.path(), name).is_err(),
                "le nom aurait dû être refusé : {name}"
            );
        }
    }

    #[test]
    fn refuse_les_noms_reserves_windows_meme_avec_extension() {
        let directory = tempfile::tempdir().expect("dossier temporaire");

        for name in ["CON.txt", "nul.mp3", "COM1.wav", "LPT9.flac"] {
            assert!(matches!(
                safe_output_path(directory.path(), name),
                Err(SafePathError::InvalidFileName(_))
            ));
        }
    }

    #[test]
    fn refuse_un_nom_trop_long_ou_un_caractere_controle() {
        let directory = tempfile::tempdir().expect("dossier temporaire");
        let too_long = format!("{}.mp3", "a".repeat(250));

        assert!(safe_output_path(directory.path(), &too_long).is_err());
        assert!(safe_output_path(directory.path(), "morceau\n.mp3").is_err());
    }

    #[test]
    fn nettoie_un_nom_genere_par_le_moteur() {
        assert_eq!(
            sanitize_file_name(r"Artiste: titre / version", "MP3"),
            "Artiste_ titre _ version.mp3"
        );
        assert_eq!(sanitize_file_name("CON", "mp3"), "_CON.mp3");
        assert_eq!(sanitize_file_name("...", "mp3"), "morceau.mp3");
    }

    #[test]
    fn refuse_une_destination_inexistante() {
        let directory = tempfile::tempdir().expect("dossier temporaire");
        let missing = directory.path().join("absent");

        assert!(matches!(
            safe_output_path(&missing, "morceau.mp3"),
            Err(SafePathError::DestinationUnavailable(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn refuse_une_sortie_lien_symbolique() {
        use std::fs;
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().expect("dossier temporaire");
        let outside = directory.path().join("fichier-externe.mp3");
        let link = directory.path().join("morceau.mp3");
        fs::write(&outside, b"existant").expect("fichier externe");
        symlink(&outside, &link).expect("lien symbolique");

        assert!(matches!(
            safe_output_path(directory.path(), "morceau.mp3"),
            Err(SafePathError::OutputIsSymlink)
        ));
    }
}

#[cfg(test)]
mod cas_reels {
    use super::{plain_path, safe_output_path, sanitize_file_name};
    use std::path::PathBuf;

    #[test]
    fn un_nom_nettoye_est_toujours_accepte_meme_tres_long_ou_non_latin() {
        let dir = tempfile::tempdir().expect("dossier");
        let titles = [format!("{} b", "a".repeat(250)), "日本語のタイトル".repeat(12), "Titre .".into(), "Fin.".into(), "Ça va – Été".into()];
        for title in titles {
            let name = sanitize_file_name(&title, "mp3");
            assert!(name.len() <= 240, "{name}");
            assert!(safe_output_path(dir.path(), &name).is_ok(), "nom nettoyé refusé : {name}");
        }
    }

    #[test]
    fn retire_le_prefixe_windows_des_chemins() {
        assert_eq!(plain_path(PathBuf::from(r"\\?\C:\Musique\Reçus")), PathBuf::from(r"C:\Musique\Reçus"));
        assert_eq!(plain_path(PathBuf::from(r"\\?\UNC\nas\musique")), PathBuf::from(r"\\nas\musique"));
        assert_eq!(plain_path(PathBuf::from("/home/moi/Musique")), PathBuf::from("/home/moi/Musique"));
    }
}
