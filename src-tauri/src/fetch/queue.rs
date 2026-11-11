//! File persistante des téléchargements.
//!
//! Les tâches en cours au moment de la fermeture sont remises en attente à la
//! prochaine ouverture. Chaque modification est écrite dans un fichier
//! temporaire du même dossier, puis renommée atomiquement.

use std::error::Error;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use super::{JobState, Wanted};

pub const MAX_QUEUE_BYTES: usize = 5 * 1024 * 1024;
pub const MAX_BATCH_SIZE: usize = 500;
const MAX_ERROR_CHARS: usize = 12_000;
const QUEUE_VERSION: u8 = 1;

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Debug)]
pub enum QueueError {
    Io(io::Error),
    Json(serde_json::Error),
    TooLarge,
    TooManyJobs,
    UnsupportedVersion(u8),
    JobNotFound,
}

impl fmt::Display for QueueError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "Erreur de fichier de la file : {error}"),
            Self::Json(error) => write!(formatter, "Fichier de file illisible : {error}"),
            Self::TooLarge => write!(
                formatter,
                "La file dépasse la limite de {} Mio.",
                MAX_QUEUE_BYTES / (1024 * 1024)
            ),
            Self::TooManyJobs => {
                write!(formatter, "Un lot ne peut pas dépasser {MAX_BATCH_SIZE} morceaux.")
            }
            Self::UnsupportedVersion(version) => {
                write!(formatter, "Version de fichier de file non prise en charge : {version}.")
            }
            Self::JobNotFound => write!(formatter, "Tâche de téléchargement introuvable."),
        }
    }
}

impl Error for QueueError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Json(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for QueueError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for QueueError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QueueItem {
    pub id: String,
    pub wanted: Wanted,
    pub state: JobState,
    pub attempts: u8,
    pub last_error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct QueueFile {
    version: u8,
    items: Vec<QueueItem>,
}

/// Même format, écrit sans recopier la file (les tâches sont empruntées).
#[derive(Serialize)]
struct QueueFileRef<'a> {
    version: u8,
    items: &'a [QueueItem],
}

#[derive(Debug)]
pub struct QueueStore {
    path: PathBuf,
    items: Vec<QueueItem>,
}

impl QueueStore {
    /// Ouvre une file existante, ou prépare une file vide si le fichier n'existe pas.
    /// Les tâches laissées en cours redeviennent disponibles après un redémarrage.
    /// Un fichier abîmé (JSON illisible, version inconnue, trop gros) est mis de côté sous un
    /// autre nom et la file repart vide : le moteur ne reste jamais bloqué.
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, QueueError> {
        let path = path.into();
        let mut items = match read_queue(&path) {
            Ok(items) => items,
            Err(QueueError::Io(error)) => return Err(QueueError::Io(error)),
            Err(_) => {
                let aside = path.with_extension(format!("abime-{}.json", uuid::Uuid::new_v4().simple()));
                fs::rename(&path, &aside)?;
                Vec::new()
            }
        };
        let mut recovered = false;

        for item in &mut items {
            if item.state == JobState::Running {
                item.state = JobState::Queued;
                item.last_error = Some("Téléchargement interrompu ; tâche remise en attente.".into());
                recovered = true;
            }
        }

        let queue = Self { path, items };
        if recovered {
            queue.save()?;
        }
        Ok(queue)
    }

    pub fn items(&self) -> &[QueueItem] {
        &self.items
    }

    pub fn next_queued(&self) -> Option<&QueueItem> {
        self.items
            .iter()
            .find(|item| item.state == JobState::Queued)
    }

    /// Ajoute un lot et l'enregistre en une seule écriture.
    pub fn enqueue_many(&mut self, wanted: Vec<Wanted>) -> Result<Vec<String>, QueueError> {
        if wanted.len() > MAX_BATCH_SIZE {
            return Err(QueueError::TooManyJobs);
        }

        let original_len = self.items.len();
        let mut ids = Vec::with_capacity(wanted.len());

        for item in wanted {
            let id = next_job_id();
            ids.push(id.clone());
            self.items.push(QueueItem {
                id,
                wanted: item,
                state: JobState::Queued,
                attempts: 0,
                last_error: None,
            });
        }

        if let Err(error) = self.save() {
            self.items.truncate(original_len);
            return Err(error);
        }

        Ok(ids)
    }

    /// Met à jour l'état d'une tâche et restaure l'ancien état si l'écriture échoue.
    pub fn set_state(
        &mut self,
        id: &str,
        state: JobState,
        last_error: Option<String>,
    ) -> Result<(), QueueError> {
        let index = self
            .items
            .iter()
            .position(|item| item.id == id)
            .ok_or(QueueError::JobNotFound)?;

        let previous_state = self.items[index].state;
        let previous_error = self.items[index].last_error.clone();

        self.items[index].state = state;
        self.items[index].last_error = last_error.map(|error| limit_chars(error, MAX_ERROR_CHARS));

        if let Err(error) = self.save() {
            self.items[index].state = previous_state;
            self.items[index].last_error = previous_error;
            return Err(error);
        }

        Ok(())
    }

    /// Enregistre la file sans exposer les détails internes du format.
    pub fn save(&self) -> Result<(), QueueError> {
        let contents = serde_json::to_vec(&QueueFileRef {
            version: QUEUE_VERSION,
            items: &self.items,
        })?;

        if contents.len() > MAX_QUEUE_BYTES {
            return Err(QueueError::TooLarge);
        }

        atomic_write(&self.path, &contents)?;
        Ok(())
    }
}

fn read_queue(path: &Path) -> Result<Vec<QueueItem>, QueueError> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(QueueError::Io(error)),
    };

    let mut contents = Vec::new();
    file.take((MAX_QUEUE_BYTES + 1) as u64)
        .read_to_end(&mut contents)?;

    if contents.len() > MAX_QUEUE_BYTES {
        return Err(QueueError::TooLarge);
    }

    let queue: QueueFile = serde_json::from_slice(&contents)?;
    if queue.version != QUEUE_VERSION {
        return Err(QueueError::UnsupportedVersion(queue.version));
    }

    Ok(queue.items)
}

fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), io::Error> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;

    let temp_path = temporary_path(path);
    let write_result = write_new_file(&temp_path, contents);

    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }

    if let Err(error) = fs::rename(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }

    Ok(())
}

fn write_new_file(path: &Path, contents: &[u8]) -> Result<(), io::Error> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(contents)?;
    file.sync_all()?;
    Ok(())
}

fn temporary_path(path: &Path) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let name = path
        .file_name()
        .unwrap_or_else(|| std::ffi::OsStr::new("telechargements.json"))
        .to_string_lossy();
    let sequence = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);

    parent.join(format!(
        ".{name}.tmp-{}-{sequence}",
        std::process::id()
    ))
}

/// Identifiant unique d'une tâche, y compris d'un lancement à l'autre (un numéro de processus et
/// un compteur repartant de zéro se répéteraient : Windows réutilise les numéros de processus).
fn next_job_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn limit_chars(text: String, maximum: usize) -> String {
    let mut chars = text.chars();
    let kept: String = chars.by_ref().take(maximum).collect();

    if chars.next().is_some() {
        format!("{kept}…")
    } else {
        kept
    }
}

#[cfg(test)]
mod tests {
    use super::{QueueError, QueueStore, MAX_BATCH_SIZE};
    use crate::fetch::{JobState, Wanted};

    fn wanted(title: &str) -> Wanted {
        Wanted {
            title: title.to_owned(),
            artist: "Artiste".to_owned(),
            album: String::new(),
            duration_secs: Some(180.0),
            playlist_id: Some("playlist-1".to_owned()),
        }
    }

    #[test]
    fn persiste_et_recharge_les_taches() {
        let directory = tempfile::tempdir().expect("dossier temporaire");
        let path = directory.path().join("telechargements.json");
        let mut queue = QueueStore::open(&path).expect("file vide");
        queue
            .enqueue_many(vec![wanted("Morceau")])
            .expect("ajout à la file");

        let restored = QueueStore::open(&path).expect("rechargement de la file");

        assert_eq!(restored.items().len(), 1);
        assert_eq!(restored.items()[0].wanted.title, "Morceau");
        assert_eq!(restored.items()[0].state, JobState::Queued);
    }

    #[test]
    fn remet_en_attente_une_tache_interrompue() {
        let directory = tempfile::tempdir().expect("dossier temporaire");
        let path = directory.path().join("telechargements.json");
        let mut queue = QueueStore::open(&path).expect("file vide");
        let ids = queue
            .enqueue_many(vec![wanted("Morceau")])
            .expect("ajout à la file");
        queue
            .set_state(&ids[0], JobState::Running, None)
            .expect("démarrage de la tâche");

        let restored = QueueStore::open(&path).expect("reprise de la file");

        assert_eq!(restored.items()[0].state, JobState::Queued);
        assert!(restored.items()[0].last_error.is_some());
    }

    #[test]
    fn refuse_un_lot_trop_grand() {
        let directory = tempfile::tempdir().expect("dossier temporaire");
        let path = directory.path().join("telechargements.json");
        let mut queue = QueueStore::open(&path).expect("file vide");
        let batch = (0..=MAX_BATCH_SIZE)
            .map(|index| wanted(&format!("Morceau {index}")))
            .collect();

        let result = queue.enqueue_many(batch);

        assert!(matches!(result, Err(QueueError::TooManyJobs)));
        assert!(queue.items().is_empty());
    }

    #[test]
    fn un_fichier_abime_est_mis_de_cote_et_la_file_repart_vide() {
        let directory = tempfile::tempdir().expect("dossier temporaire");
        let path = directory.path().join("telechargements.json");
        std::fs::write(&path, b"{ pas du json").expect("fichier abime");

        let mut queue = QueueStore::open(&path).expect("file reprise malgre le fichier abime");
        assert!(queue.items().is_empty());
        queue.enqueue_many(vec![wanted("Morceau")]).expect("la file fonctionne de nouveau");
        let kept = std::fs::read_dir(directory.path())
            .expect("lecture du dossier")
            .filter_map(Result::ok)
            .any(|e| e.file_name().to_string_lossy().contains("abime-"));
        assert!(kept, "l'ancien fichier est garde sous un autre nom");
    }

    #[test]
    fn les_identifiants_ne_se_repetent_pas() {
        let directory = tempfile::tempdir().expect("dossier temporaire");
        let path = directory.path().join("telechargements.json");
        let mut queue = QueueStore::open(&path).expect("file vide");
        let ids = queue
            .enqueue_many((0..50).map(|i| wanted(&format!("Morceau {i}"))).collect())
            .expect("ajout");
        let unique: std::collections::HashSet<_> = ids.iter().collect();
        assert_eq!(unique.len(), 50);
        assert!(ids.iter().all(|id| id.len() == 32), "identifiants aleatoires (uuid)");
    }

    #[test]
    fn refuse_une_tache_absente() {
        let directory = tempfile::tempdir().expect("dossier temporaire");
        let path = directory.path().join("telechargements.json");
        let mut queue = QueueStore::open(&path).expect("file vide");

        let result = queue.set_state("absent", JobState::Running, None);

        assert!(matches!(result, Err(QueueError::JobNotFound)));
    }
}
