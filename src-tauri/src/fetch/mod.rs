//! Moteur de téléchargement (en construction) : correspondance, file, adaptateurs spotDL et yt-dlp.

use serde::{Deserialize, Serialize};

pub mod matching;
pub mod queue;

/// Morceau à télécharger, tel que la personne l'a demandé (import Spotify, sélection…).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Wanted {
    pub title: String,
    pub artist: String,
    #[serde(default)]
    pub album: String,
    #[serde(default)]
    pub duration_secs: Option<f64>,
    /// Playlist où ranger le morceau une fois importé.
    #[serde(default)]
    pub playlist_id: Option<String>,
}

/// État d'une tâche de la file.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Queued,
    Running,
    Done,
    Failed,
    Cancelled,
}
