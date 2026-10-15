//! Journal d'écoute : base de la rétrospective (mois, année). Chaque écoute d'un morceau est
//! enregistrée avec le temps réellement écouté (pauses exclues), une ligne JSON par écoute
//! dans `ecoute/AAAA.jsonl`. Titre, artiste et album sont recopiés : les statistiques
//! survivent à un fichier renommé ou supprimé.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::library::Track;

/// En dessous, ce n'est pas une écoute (morceau passé) : rien n'est enregistré.
pub const MIN_LISTEN_SECS: f64 = 10.0;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Listen {
    pub track_id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub genre: Option<String>,
    /// Début de l'écoute (secondes Unix).
    pub started: u64,
    /// Temps réellement écouté, en secondes.
    pub secs: f64,
    pub duration_secs: f64,
}

/// Écoute en cours, alimentée toutes les 300 ms par la boucle de lecture.
#[derive(Default)]
pub struct Tracker {
    current: Option<(Listen, Option<Instant>)>,
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

impl Tracker {
    /// `playing` : morceau en cours et pas en pause. Renvoie l'écoute terminée à enregistrer,
    /// quand le morceau change.
    pub fn tick(&mut self, track: Option<&Track>, playing: bool) -> Option<Listen> {
        let mut done = None;
        let same = matches!((&self.current, track), (Some((l, _)), Some(t)) if l.track_id == t.id);
        if !same {
            done = self.current.take().map(|(l, _)| l);
            if let Some(t) = track {
                self.current = Some((
                    Listen {
                        track_id: t.id.clone(),
                        title: t.title.clone(),
                        artist: t.artist.clone(),
                        album: t.album.clone(),
                        genre: t.genre.clone(),
                        started: now_secs(),
                        secs: 0.0,
                        duration_secs: t.duration_secs,
                    },
                    None,
                ));
            }
        }
        if let Some((listen, last)) = &mut self.current {
            let now = Instant::now();
            if playing {
                if let Some(at) = last {
                    // Au plus 2 s par tour : une mise en veille ne compte pas comme de l'écoute.
                    listen.secs += now.duration_since(*at).as_secs_f64().min(2.0);
                }
                *last = Some(now);
            } else {
                *last = None;
            }
        }
        done.filter(|l| l.secs >= MIN_LISTEN_SECS)
    }

    /// Écoute en cours (pour la sauvegarder à la fermeture), si elle compte déjà.
    pub fn current(&self) -> Option<&Listen> {
        self.current.as_ref().map(|(l, _)| l).filter(|l| l.secs >= MIN_LISTEN_SECS)
    }
}

pub fn dir(data_dir: &Path) -> PathBuf {
    data_dir.join("ecoute")
}

/// Ajoute une écoute au journal de son année.
pub fn record(data_dir: &Path, listen: &Listen) -> Result<(), String> {
    let dir = dir(data_dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let year = 1970 + (listen.started / 31_556_952) as i64; // année approximative du nom de fichier
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(format!("{year}.jsonl")))
        .map_err(|e| e.to_string())?;
    let line = serde_json::to_string(listen).map_err(|e| e.to_string())?;
    writeln!(file, "{line}").map_err(|e| e.to_string())
}

fn pending_path(data_dir: &Path) -> PathBuf {
    dir(data_dir).join("en-cours.json")
}

/// Écoute en cours mise de côté régulièrement : si l'appli est fermée ou tuée (Android) au
/// milieu d'un morceau, elle est récupérée au lancement suivant au lieu d'être perdue.
pub fn save_pending(data_dir: &Path, listen: Option<&Listen>) {
    let path = pending_path(data_dir);
    match listen {
        Some(l) => {
            if std::fs::create_dir_all(dir(data_dir)).is_ok() {
                if let Ok(json) = serde_json::to_vec(l) {
                    let _ = std::fs::write(path, json);
                }
            }
        }
        None => {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Au lancement : enregistre l'écoute laissée en cours la dernière fois.
pub fn recover_pending(data_dir: &Path) {
    let path = pending_path(data_dir);
    if let Some(listen) = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice::<Listen>(&b).ok()) {
        if listen.secs >= MIN_LISTEN_SECS {
            let _ = record(data_dir, &listen);
        }
    }
    let _ = std::fs::remove_file(path);
}

/// Toutes les écoutes enregistrées (fichiers de toutes les années).
pub fn load_all(data_dir: &Path) -> Vec<Listen> {
    let Ok(entries) = std::fs::read_dir(dir(data_dir)) else { return Vec::new() };
    let mut out: Vec<Listen> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "jsonl"))
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .flat_map(|text| text.lines().filter_map(|l| serde_json::from_str::<Listen>(l).ok()).collect::<Vec<_>>())
        .collect();
    out.sort_by_key(|l| l.started);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(id: &str) -> Track {
        serde_json::from_value(serde_json::json!({
            "id": id, "path": format!("/m/{id}.mp3"), "title": id, "artist": "A", "album": "B",
            "track_no": null, "duration_secs": 180.0, "has_cover": false
        }))
        .unwrap()
    }

    #[test]
    fn short_skips_are_not_recorded_and_changes_close_the_listen() {
        let mut t = Tracker::default();
        let a = track("a");
        assert!(t.tick(Some(&a), true).is_none());
        // Passé tout de suite : moins de 10 s, rien.
        assert!(t.tick(Some(&track("b")), true).is_none());
        // Écoute assez longue (simulée) puis changement : enregistrée.
        if let Some((l, _)) = &mut t.current {
            l.secs = 42.0;
        }
        let done = t.tick(Some(&a), true).unwrap();
        assert_eq!(done.track_id, "b");
        assert_eq!(done.secs, 42.0);
    }

    #[test]
    fn a_listen_left_pending_is_recovered_once() {
        let dir = tempfile::tempdir().unwrap();
        let listen = Listen { track_id: "x".into(), title: "T".into(), artist: "A".into(), album: "B".into(), genre: None, started: 1_790_000_000, secs: 95.0, duration_secs: 200.0 };
        save_pending(dir.path(), Some(&listen));
        recover_pending(dir.path());
        recover_pending(dir.path());
        assert_eq!(load_all(dir.path()), vec![listen]);
    }

    #[test]
    fn records_and_reloads_listens() {
        let dir = tempfile::tempdir().unwrap();
        let listen = Listen { track_id: "x".into(), title: "T".into(), artist: "A".into(), album: "B".into(), genre: None, started: 1_790_000_000, secs: 61.5, duration_secs: 200.0 };
        record(dir.path(), &listen).unwrap();
        record(dir.path(), &listen).unwrap();
        assert_eq!(load_all(dir.path()), vec![listen.clone(), listen]);
    }
}
