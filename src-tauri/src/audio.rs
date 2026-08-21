//! Moteur de lecture audio.
//!
//! `cpal`/`rodio` maintiennent un flux de sortie (`OutputStream`) qui
//! contient un pointeur brut non-`Send` sur certaines plateformes — il ne
//! peut donc pas vivre directement dans l'état géré par Tauri (`State<T>`
//! exige `T: Send + Sync`). La solution classique est de faire tourner
//! tout ce qui touche à rodio sur un unique thread dédié, et de ne
//! partager avec le reste de l'app que des messages (`AudioCommand`) et
//! un statut (`AudioStatus`) protégé par un `Mutex` — ces deux types-là
//! sont de simples données, donc `Send + Sync` sans souci.

use crate::eq::{EqGains, EqSource};
use rodio::{Decoder, OutputStream, Sink, Source};
use std::fs::File;
use std::io::BufReader;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[derive(Debug)]
enum AudioCommand {
    Play(String, f32),
    Pause,
    Resume,
    Stop,
    Seek(Duration),
    SetVolume(f32),
}

#[derive(Debug, Clone, Default)]
pub struct AudioStatus {
    pub current_path: Option<String>,
    pub is_paused: bool,
    pub position_secs: f64,
    /// La piste s'est terminée d'elle-même (fin de flux côté rodio) et
    /// n'a pas encore été "consommée" par `poll_auto_advance`.
    pub finished: bool,
    /// Renseigné si aucun périphérique de sortie audio n'a pu être ouvert
    /// (ex : machine sans carte son) — les commandes restent silencieuses
    /// plutôt que de faire planter l'application.
    pub device_error: Option<String>,
}

pub struct AudioHandle {
    tx: Mutex<Sender<AudioCommand>>,
    status: Arc<Mutex<AudioStatus>>,
}

impl AudioHandle {
    /// Démarre le thread audio dédié et retourne un handle léger,
    /// `Send + Sync`, utilisable depuis les commandes Tauri.
    pub fn spawn(eq_gains: EqGains) -> Self {
        let (tx, rx) = mpsc::channel::<AudioCommand>();
        let status = Arc::new(Mutex::new(AudioStatus::default()));
        let status_for_thread = status.clone();

        thread::Builder::new()
            .name("audio-engine".into())
            .spawn(move || audio_thread_main(rx, status_for_thread, eq_gains))
            .expect("impossible de démarrer le thread audio");

        Self {
            tx: Mutex::new(tx),
            status,
        }
    }

    fn send(&self, cmd: AudioCommand) {
        // Le channel n'est jamais fermé côté récepteur en usage normal ;
        // une erreur ici signifierait que le thread audio a paniqué.
        let _ = self.tx.lock().unwrap().send(cmd);
    }

    pub fn play(&self, path: &str, volume: f32) {
        self.send(AudioCommand::Play(path.to_string(), volume));
    }

    pub fn pause(&self) {
        self.send(AudioCommand::Pause);
    }

    pub fn resume(&self) {
        self.send(AudioCommand::Resume);
    }

    pub fn stop(&self) {
        self.send(AudioCommand::Stop);
    }

    pub fn seek(&self, position: Duration) {
        self.send(AudioCommand::Seek(position));
    }

    pub fn set_volume(&self, volume: f32) {
        self.send(AudioCommand::SetVolume(volume));
    }

    pub fn status(&self) -> AudioStatus {
        self.status.lock().unwrap().clone()
    }

    /// Marque le statut "finished" comme traité (appelé après avoir lancé
    /// la piste suivante suite à une fin de piste détectée).
    pub fn clear_finished(&self) {
        self.status.lock().unwrap().finished = false;
    }
}

fn audio_thread_main(rx: Receiver<AudioCommand>, status: Arc<Mutex<AudioStatus>>, eq_gains: EqGains) {
    let (_stream, stream_handle) = match OutputStream::try_default() {
        Ok(v) => v,
        Err(e) => {
            status.lock().unwrap().device_error = Some(e.to_string());
            // Continue à vider le channel pour ne jamais bloquer les
            // threads qui envoient des commandes, même sans périphérique.
            while rx.recv().is_ok() {}
            return;
        }
    };

    let mut sink: Option<Sink> = None;

    loop {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(AudioCommand::Play(path, volume)) => {
                let decoded = File::open(&path)
                    .map_err(|e| e.to_string())
                    .and_then(|f| Decoder::new(BufReader::new(f)).map_err(|e| e.to_string()));
                match decoded {
                    Ok(decoder) => {
                        let source = decoder.convert_samples::<f32>();
                        let eq_source = EqSource::new(source, eq_gains.clone());
                        match Sink::try_new(&stream_handle) {
                            Ok(new_sink) => {
                                new_sink.set_volume(volume);
                                new_sink.append(eq_source);
                                sink = Some(new_sink);
                                let mut st = status.lock().unwrap();
                                st.current_path = Some(path);
                                st.is_paused = false;
                                st.finished = false;
                                st.position_secs = 0.0;
                                st.device_error = None;
                            }
                            Err(e) => status.lock().unwrap().device_error = Some(e.to_string()),
                        }
                    }
                    Err(e) => status.lock().unwrap().device_error = Some(e),
                }
            }
            Ok(AudioCommand::Pause) => {
                if let Some(s) = &sink {
                    s.pause();
                    status.lock().unwrap().is_paused = true;
                }
            }
            Ok(AudioCommand::Resume) => {
                if let Some(s) = &sink {
                    s.play();
                    status.lock().unwrap().is_paused = false;
                }
            }
            Ok(AudioCommand::Stop) => {
                if let Some(s) = sink.take() {
                    s.stop();
                }
                let mut st = status.lock().unwrap();
                st.current_path = None;
                st.is_paused = true;
                st.position_secs = 0.0;
                st.finished = false;
            }
            Ok(AudioCommand::Seek(pos)) => {
                if let Some(s) = &sink {
                    let _ = s.try_seek(pos);
                }
            }
            Ok(AudioCommand::SetVolume(v)) => {
                if let Some(s) = &sink {
                    s.set_volume(v);
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }

        if let Some(s) = &sink {
            let mut st = status.lock().unwrap();
            st.position_secs = s.get_pos().as_secs_f64();
            if s.empty() && st.current_path.is_some() {
                st.finished = true;
            }
        }
    }
}
