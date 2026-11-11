//! Moteur de téléchargement (en construction) : correspondance, file, adaptateurs spotDL et yt-dlp.

use serde::{Deserialize, Serialize};

pub mod commands;
pub mod common;
pub mod import;
pub mod link;
pub mod matching;
pub mod queue;
pub mod source;
pub mod spotdl;
pub mod ytdlp;

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

/// Échec d'une tâche, classé pour l'interface (message adapté, nouvel essai ou non).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "detail", rename_all = "snake_case")]
pub enum JobError {
    /// Programme externe absent (spotDL, yt-dlp, ffmpeg) : message d'aide à l'installation.
    ToolMissing(String),
    /// Aucun résultat qui corresponde au morceau demandé.
    NotFound,
    /// Coupure, délai réseau ou limitation du service : un nouvel essai peut réussir.
    Network(String),
    /// Délai maximal dépassé : le programme a été arrêté.
    Timeout,
    /// Arrêt demandé par la personne.
    Cancelled,
    /// Chemin de sortie refusé (hors du dossier, nom réservé…).
    UnsafePath(String),
    /// Autre échec du programme externe (fin de son journal).
    Failed(String),
}

impl std::fmt::Display for JobError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ToolMissing(help) => write!(f, "Outil absent : {help}"),
            Self::NotFound => write!(f, "Aucun résultat correspondant."),
            Self::Network(detail) => write!(f, "Problème réseau : {detail}"),
            Self::Timeout => write!(f, "Délai dépassé : téléchargement arrêté."),
            Self::Cancelled => write!(f, "Arrêté."),
            Self::UnsafePath(detail) => write!(f, "Chemin refusé : {detail}"),
            Self::Failed(detail) => write!(f, "Échec : {detail}"),
        }
    }
}
