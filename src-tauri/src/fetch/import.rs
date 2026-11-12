//! Téléchargement, vérification de la correspondance et import dans la bibliothèque.
//!
//! Les outils travaillent dans `racine/.telechargements/<tâche>/` : un dossier caché, que le
//! scan de la bibliothèque ignore (fichiers partiels jamais ajoutés), sur le même volume que la
//! bibliothèque (le fichier final y est simplement déplacé).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use super::matching::{score_match, TrackInfo};
use super::source::{safe_output_path, Source};
use super::spotdl::requested_file_name;
use super::{JobError, Wanted};
use crate::library::{self, Track};

/// Dossier de travail des outils, dans la racine de la bibliothèque (caché : ignoré du scan).
pub const STAGING_DIR: &str = ".telechargements";

/// Télécharge un morceau, vérifie son identité, puis le range dans le dossier de la bibliothèque.
pub fn download_and_import(source: &dyn Source, wanted: &Wanted, library_root: &Path, cancel: &AtomicBool) -> Result<Track, JobError> {
    if cancel.load(Ordering::Relaxed) {
        return Err(JobError::Cancelled);
    }
    let staging = library_root.join(STAGING_DIR);
    let downloaded = source.fetch(wanted, &staging, cancel)?;
    let result = import_downloaded_file(&downloaded, wanted, library_root, source.name());
    remove_attempt_dir(&downloaded, &staging);
    result
}

/// Efface le dossier de la tâche qui contenait `downloaded`, et seulement lui : un dossier de
/// tâche (32 caractères hexadécimaux) directement dans `staging`. Jamais la bibliothèque, même
/// si un adaptateur renvoyait un chemin inattendu.
fn remove_attempt_dir(downloaded: &Path, staging: &Path) {
    let Some(attempt_dir) = downloaded.parent() else { return };
    let is_task_dir = attempt_dir
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.len() == 32 && n.bytes().all(|b| b.is_ascii_hexdigit()));
    let in_staging = match (attempt_dir.parent().map(fs::canonicalize), fs::canonicalize(staging)) {
        (Some(Ok(parent)), Ok(staging)) => parent == staging,
        _ => false,
    };
    if is_task_dir && in_staging {
        let _ = fs::remove_dir_all(attempt_dir);
    }
}

fn import_downloaded_file(downloaded: &Path, wanted: &Wanted, library_root: &Path, source_name: &str) -> Result<Track, JobError> {
    let candidate = library::read_track(downloaded)
        .ok_or_else(|| JobError::Failed("Le fichier téléchargé n'est pas un format audio pris en charge.".to_owned()))?;

    let score = score_match(
        TrackInfo { title: &wanted.title, artist: &wanted.artist, duration_secs: wanted.duration_secs },
        TrackInfo { title: &candidate.title, artist: &candidate.artist, duration_secs: Some(candidate.duration_secs) },
    );
    if !score.accepted {
        return Err(JobError::Failed(format!(
            "Le résultat de {source_name} ne correspond pas assez à la demande (titre {:.0} %, artiste {:.0} %{}). Le fichier n'a pas été ajouté.",
            score.title_similarity * 100.0,
            score.artist_similarity * 100.0,
            score.duration_delta_secs.map(|delta| format!(", écart de durée {delta:.0} s")).unwrap_or_default(),
        )));
    }

    // yt-dlp étiquette avec le titre de la vidéo (« … (Official Video) (4K Remaster) ») et sans
    // album ; la correspondance étant acceptée, on écrit la demande. spotDL pose déjà les
    // étiquettes Spotify. Sans effet si l'écriture échoue : le morceau reste importable.
    if source_name == "yt-dlp" {
        retag(downloaded, wanted);
    }

    let destination = available_destination(library_root, &requested_file_name(wanted))?;
    fs::rename(downloaded, &destination)
        .map_err(|error| JobError::Failed(format!("Impossible de déplacer le morceau dans la bibliothèque : {error}")))?;

    library::read_track(&destination).ok_or_else(|| {
        // Évite de laisser un fichier importé mais illisible dans le dossier de la bibliothèque.
        let _ = fs::remove_file(&destination);
        JobError::Failed("Le morceau déplacé ne peut pas être relu par la bibliothèque.".to_owned())
    })
}

/// Titre, artiste et album demandés écrits dans le fichier (au mieux).
fn retag(path: &Path, wanted: &Wanted) {
    use lofty::config::WriteOptions;
    use lofty::file::{AudioFile, TaggedFileExt};
    use lofty::tag::{Accessor, Tag};

    let Ok(mut tagged) = lofty::read_from_path(path) else { return };
    if tagged.primary_tag().is_none() {
        let kind = tagged.primary_tag_type();
        tagged.insert_tag(Tag::new(kind));
    }
    let Some(tag) = tagged.primary_tag_mut() else { return };
    tag.set_title(wanted.title.trim().to_owned());
    if !wanted.artist.trim().is_empty() {
        tag.set_artist(wanted.artist.trim().to_owned());
    }
    if !wanted.album.trim().is_empty() {
        tag.set_album(wanted.album.trim().to_owned());
    }
    let _ = tagged.save_to_path(path, WriteOptions::default());
}

/// Préserve les fichiers déjà présents : « Artiste - Titre (2).mp3 », puis (3), etc.
fn available_destination(root: &Path, requested_name: &str) -> Result<PathBuf, JobError> {
    let first = safe_output_path(root, requested_name).map_err(|error| JobError::UnsafePath(error.to_string()))?;
    if !first.exists() {
        return Ok(first);
    }
    let path = Path::new(requested_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| JobError::UnsafePath("Nom de fichier invalide.".to_owned()))?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .ok_or_else(|| JobError::UnsafePath("Extension de fichier invalide.".to_owned()))?;
    for number in 2_u32..=10_000 {
        let destination = safe_output_path(root, &format!("{stem} ({number}).{extension}"))
            .map_err(|error| JobError::UnsafePath(error.to_string()))?;
        if !destination.exists() {
            return Ok(destination);
        }
    }
    Err(JobError::Failed("Impossible de trouver un nom de fichier libre après 10 000 essais.".to_owned()))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::AtomicBool;

    use super::{available_destination, download_and_import, remove_attempt_dir, STAGING_DIR};
    use crate::fetch::common::create_attempt_directory;
    use crate::fetch::source::Source;
    use crate::fetch::{JobError, Wanted};

    fn wanted() -> Wanted {
        Wanted { title: "Bruxelles vie".into(), artist: "Damso".into(), album: String::new(), duration_secs: Some(200.0), playlist_id: None }
    }

    type Answer = Box<dyn Fn(&Path) -> Result<PathBuf, JobError> + Send + Sync>;

    /// Source factice : renvoie le chemin choisi par le test.
    struct Fake(Answer);
    impl Source for Fake {
        fn name(&self) -> &'static str {
            "factice"
        }
        fn available(&self) -> bool {
            true
        }
        fn fetch(&self, _: &Wanted, dest_dir: &Path, _: &AtomicBool) -> Result<PathBuf, JobError> {
            (self.0)(dest_dir)
        }
    }

    #[test]
    fn telecharge_dans_un_dossier_cache_ignore_du_scan() {
        let root = tempfile::tempdir().expect("dossier");
        let seen = std::sync::Arc::new(std::sync::Mutex::new(PathBuf::new()));
        let keep = seen.clone();
        let source = Fake(Box::new(move |dest| {
            *keep.lock().expect("verrou") = dest.to_path_buf();
            Err(JobError::NotFound)
        }));
        let _ = download_and_import(&source, &wanted(), root.path(), &AtomicBool::new(false));
        assert_eq!(*seen.lock().expect("verrou"), root.path().join(STAGING_DIR));
        assert!(STAGING_DIR.starts_with('.'), "le scan ignore les dossiers commençant par un point");
    }

    #[test]
    fn n_efface_jamais_la_bibliotheque_meme_si_la_source_renvoie_un_chemin_inattendu() {
        let root = tempfile::tempdir().expect("dossier");
        let mine = root.path().join("Mon son.mp3");
        fs::write(&mine, b"ma musique").expect("fichier de la bibliothèque");
        let returned = mine.clone();
        // Fichier rendu directement dans la bibliothèque (adaptateur défaillant).
        let source = Fake(Box::new(move |_| Ok(returned.clone())));
        let _ = download_and_import(&source, &wanted(), root.path(), &AtomicBool::new(false));
        assert!(mine.exists(), "la bibliothèque est intacte");
    }

    #[test]
    fn efface_le_dossier_de_la_tache_apres_coup() {
        let root = tempfile::tempdir().expect("dossier");
        let staging = root.path().join(STAGING_DIR);
        let attempt = create_attempt_directory(&staging).expect("dossier de tâche");
        let file = attempt.join("x.mp3");
        fs::write(&file, b"son").expect("fichier");
        remove_attempt_dir(&file, &staging);
        assert!(!attempt.exists());
        assert!(staging.exists());
    }

    #[test]
    fn ne_remplace_pas_un_fichier_deja_present() {
        let root = tempfile::tempdir().expect("dossier");
        fs::write(root.path().join("Damso - Bruxelles vie.mp3"), b"ancien").expect("existant");
        let next = available_destination(root.path(), "Damso - Bruxelles vie.mp3").expect("nom libre");
        assert_eq!(next.file_name().and_then(|n| n.to_str()), Some("Damso - Bruxelles vie (2).mp3"));
    }

    /// Vrai téléchargement puis import (réseau, spotDL, yt-dlp, FFmpeg) :
    /// `cargo test -- --ignored --test-threads=1 vrai_telechargement`.
    fn vrai_telechargement(source: &dyn Source) {
        let root = tempfile::tempdir().expect("dossier");
        let wanted = Wanted {
            title: "Never Gonna Give You Up".into(),
            artist: "Rick Astley".into(),
            album: String::new(),
            duration_secs: Some(213.0),
            playlist_id: None,
        };
        let track = download_and_import(source, &wanted, root.path(), &AtomicBool::new(false)).expect("morceau importé");
        println!("{} : {track:?}", source.name());
        assert!(Path::new(&track.path).is_file());
        assert_eq!(track.title, "Never Gonna Give You Up", "titre propre, pas celui de la vidéo");
        assert_eq!(track.artist, "Rick Astley");
        assert_eq!(Path::new(&track.path).parent(), Some(root.path()), "rangé à la racine de la bibliothèque");
        let staging = root.path().join(STAGING_DIR);
        assert_eq!(fs::read_dir(&staging).map(|d| d.count()).unwrap_or(0), 0, "dossier de tâche effacé");
    }

    #[test]
    #[ignore = "réseau, spotDL et FFmpeg installés"]
    fn vrai_telechargement_spotdl() {
        vrai_telechargement(&crate::fetch::spotdl::SpotDlSource);
    }

    #[test]
    #[ignore = "réseau, yt-dlp et FFmpeg installés"]
    fn vrai_telechargement_ytdlp() {
        vrai_telechargement(&crate::fetch::ytdlp::YtDlpSource);
    }
}

