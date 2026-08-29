//! Sauvegarde/restauration de l'état de session entre deux lancements de
//! l'app : dossier de bibliothèque, piste en cours, position de lecture,
//! volume, shuffle/repeat et réglages de l'égaliseur.

use crate::queue::RepeatMode;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionState {
    pub library_root: Option<String>,
    pub queue: Vec<String>,
    pub current_track_id: Option<String>,
    pub position_secs: f64,
    pub volume: f32,
    pub shuffle: bool,
    pub repeat: RepeatMode,
    /// Gains en dB des 3 bandes de l'égaliseur : [basses, médiums, aigus].
    pub eq_gains: [f32; 3],
}

impl Default for SessionState {
    fn default() -> Self {
        Self {
            library_root: None,
            queue: Vec::new(),
            current_track_id: None,
            position_secs: 0.0,
            volume: 1.0,
            shuffle: false,
            repeat: RepeatMode::Off,
            eq_gains: [0.0, 0.0, 0.0],
        }
    }
}

impl SessionState {
    pub fn load(path: &Path) -> Self {
        match fs::read_to_string(path) {
            Ok(content) => serde_json::from_str::<Self>(&content)
                .map(|mut state| {
                    state.sanitize();
                    state
                })
                .unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    /// Keep persisted values inside the ranges accepted by the audio engine.
    /// A local session file is user data and may be stale or manually edited.
    fn sanitize(&mut self) {
        self.position_secs = if self.position_secs.is_finite() {
            self.position_secs.max(0.0)
        } else {
            0.0
        };
        self.volume = if self.volume.is_finite() {
            self.volume.clamp(0.0, 1.0)
        } else {
            1.0
        };
        for gain in &mut self.eq_gains {
            *gain = if gain.is_finite() {
                gain.clamp(-12.0, 12.0)
            } else {
                0.0
            };
        }
        self.queue.retain(|track| !track.trim().is_empty());
        if self.current_track_id.as_ref().is_some_and(|track| track.trim().is_empty()) {
            self.current_track_id = None;
        }
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(self).unwrap();
        let temporary = path.with_extension("json.tmp");
        fs::write(&temporary, json)?;
        fs::rename(temporary, path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_gives_sane_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.json");
        let state = SessionState::load(&path);
        assert_eq!(state.volume, 1.0);
        assert_eq!(state.repeat, RepeatMode::Off);
        assert!(state.current_track_id.is_none());
    }

    #[test]
    fn save_then_load_roundtrips_every_field() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.json");

        let state = SessionState {
            library_root: Some("/musique".to_string()),
            queue: vec!["a".to_string(), "b".to_string()],
            current_track_id: Some("b".to_string()),
            position_secs: 42.5,
            volume: 0.6,
            shuffle: true,
            repeat: RepeatMode::All,
            eq_gains: [3.0, -2.0, 1.5],
        };
        state.save(&path).unwrap();

        let reloaded = SessionState::load(&path);
        assert_eq!(reloaded.library_root, state.library_root);
        assert_eq!(reloaded.queue, state.queue);
        assert_eq!(reloaded.current_track_id, state.current_track_id);
        assert_eq!(reloaded.position_secs, state.position_secs);
        assert_eq!(reloaded.volume, state.volume);
        assert_eq!(reloaded.shuffle, state.shuffle);
        assert_eq!(reloaded.repeat, state.repeat);
        assert_eq!(reloaded.eq_gains, state.eq_gains);
    }

    #[test]
    fn corrupted_file_falls_back_to_defaults_instead_of_crashing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.json");
        fs::write(&path, b"not json").unwrap();
        let state = SessionState::load(&path);
        assert_eq!(state.volume, 1.0);
    }

    #[test]
    fn stale_values_are_sanitized_when_loaded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.json");
        fs::write(
            &path,
            r#"{"library_root":null,"queue":["", "song.mp3"],"current_track_id":"","position_secs":-2.0,"volume":4.0,"shuffle":false,"repeat":"off","eq_gains":[-30.0,0.0,30.0]}"#,
        )
        .unwrap();
        let state = SessionState::load(&path);
        assert_eq!(state.queue, vec!["song.mp3"]);
        assert!(state.current_track_id.is_none());
        assert_eq!(state.position_secs, 0.0);
        assert_eq!(state.volume, 1.0);
        assert_eq!(state.eq_gains, [-12.0, 0.0, 12.0]);
    }
}
