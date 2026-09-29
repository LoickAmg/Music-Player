//! Moteur de lecture audio.
//!
//! Le flux de sortie de `rodio`/`cpal` n'est pas `Send` sur toutes les plateformes : tout ce
//! qui touche à rodio vit donc sur un unique thread dédié, et le reste de l'application ne
//! partage avec lui que des messages (`AudioCommand`) et un statut (`AudioStatus`).
//!
//! Un décodeur défaillant ne doit jamais tuer ce thread (sinon plus aucun son ne sort, en
//! silence) : chaque commande est exécutée sous `catch_unwind`, et un fichier que le décodeur
//! intégré refuse — ou sur lequel il panique — est retenté via `ffmpeg`.

use crate::eq::{EqGains, EqSource};
use crate::ffmpeg;
use rodio::{Decoder, DeviceSinkBuilder, Player, Source};
use std::fs::File;
use std::io::{BufReader, Cursor, Read, Seek, SeekFrom};
use std::panic::{self, AssertUnwindSafe};
use std::path::Path;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[derive(Debug)]
enum AudioCommand {
    Play(String, f32, Option<Sender<Result<(), String>>>),
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
    /// La piste s'est terminée d'elle-même et n'a pas encore été "consommée" par
    /// `poll_auto_advance`.
    pub finished: bool,
    /// Dernière erreur de sortie audio ou de décodage, affichée par l'interface.
    pub device_error: Option<String>,
}

pub struct AudioHandle {
    tx: Mutex<Sender<AudioCommand>>,
    status: Arc<Mutex<AudioStatus>>,
}

impl AudioHandle {
    /// Démarre le thread audio dédié et retourne un handle léger, `Send + Sync`.
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
        let _ = self.tx.lock().unwrap().send(cmd);
    }

    /// Lance une piste et attend que son décodage ait démarré, pour pouvoir signaler une
    /// erreur à l'interface (le décodage via ffmpeg d'un long fichier peut prendre du temps).
    pub fn play(&self, path: &str, volume: f32) -> Result<(), String> {
        let (reply, answer) = mpsc::channel();
        self.send(AudioCommand::Play(path.to_string(), volume, Some(reply)));
        answer.recv_timeout(Duration::from_secs(60)).unwrap_or_else(|_| {
            Err(self
                .status()
                .device_error
                .unwrap_or_else(|| "Le moteur audio ne répond pas.".to_string()))
        })
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

    pub fn clear_finished(&self) {
        self.status.lock().unwrap().finished = false;
    }
}

/// Lecteur qui ignore les `offset` premiers octets d'un fichier : certains FLAC portent une
/// étiquette ID3 collée devant leur en-tête « fLaC », que le décodeur refuse sinon.
struct OffsetReader<R> {
    inner: R,
    offset: u64,
}

impl<R: Read> Read for OffsetReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.inner.read(buf)
    }
}

impl<R: Seek> Seek for OffsetReader<R> {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        let absolute = match pos {
            SeekFrom::Start(n) => self.inner.seek(SeekFrom::Start(n + self.offset))?,
            other => self.inner.seek(other)?,
        };
        Ok(absolute.saturating_sub(self.offset))
    }
}

/// Taille d'une étiquette ID3v2 en tête de fichier (en-tête compris), ou 0.
pub fn leading_id3_len(header: &[u8]) -> u64 {
    if header.len() < 10 || &header[..3] != b"ID3" {
        return 0;
    }
    let size = header[6..10]
        .iter()
        .fold(0u64, |acc, b| (acc << 7) | u64::from(b & 0x7f));
    let footer = if header[5] & 0x10 != 0 { 10 } else { 0 };
    10 + size + footer
}

type BoxedSource = Box<dyn Source + Send>;

fn native_decoder(path: &Path) -> Result<BoxedSource, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    let ext = ffmpeg::extension_of(path);
    let mut offset = 0;
    if ext == "flac" {
        let mut header = [0u8; 10];
        if file.read_exact(&mut header).is_ok() {
            offset = leading_id3_len(&header).min(len);
        }
    }
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let reader = BufReader::new(OffsetReader { inner: file, offset });
    let decoder = Decoder::builder()
        .with_data(reader)
        .with_byte_len(len - offset)
        .with_seekable(true)
        .with_hint(&ext)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(Box::new(decoder))
}

fn ffmpeg_decoder(path: &Path) -> Result<BoxedSource, String> {
    let wav = ffmpeg::decode_to_wav(path)?;
    let len = wav.len() as u64;
    let decoder = Decoder::builder()
        .with_data(Cursor::new(wav))
        .with_byte_len(len)
        .with_seekable(true)
        .with_hint("wav")
        .build()
        .map_err(|e| e.to_string())?;
    Ok(Box::new(decoder))
}

/// Décodeur d'un fichier : direct pour les formats natifs, `ffmpeg` pour les autres ou en
/// secours quand le décodeur intégré échoue (y compris s'il panique).
pub fn open_decoder(path: &str) -> Result<BoxedSource, String> {
    let file_path = Path::new(path);
    if !ffmpeg::needs_ffmpeg(file_path) {
        let direct = panic::catch_unwind(|| native_decoder(file_path))
            .unwrap_or_else(|_| Err("le décodeur intégré a échoué sur ce fichier".to_string()));
        match direct {
            Ok(decoder) => return Ok(decoder),
            Err(error) if !ffmpeg::ffmpeg_available() => return Err(error),
            Err(_) => {}
        }
    }
    ffmpeg_decoder(file_path)
}

struct Engine {
    _device: rodio::MixerDeviceSink,
    mixer: rodio::mixer::Mixer,
    player: Option<Player>,
    eq_gains: EqGains,
}

impl Engine {
    fn handle(&mut self, cmd: AudioCommand, status: &Mutex<AudioStatus>) {
        match cmd {
            AudioCommand::Play(path, volume, reply) => match open_decoder(&path) {
                Ok(decoder) => {
                    if let Some(reply) = reply {
                        let _ = reply.send(Ok(()));
                    }
                    if let Some(old) = self.player.take() {
                        old.stop();
                    }
                    let player = Player::connect_new(&self.mixer);
                    player.set_volume(volume);
                    player.append(EqSource::new(decoder, self.eq_gains.clone()));
                    self.player = Some(player);
                    let mut st = status.lock().unwrap();
                    st.current_path = Some(path);
                    st.is_paused = false;
                    st.finished = false;
                    st.position_secs = 0.0;
                    st.device_error = None;
                }
                Err(e) => {
                    let name = Path::new(&path)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or(path);
                    let message = format!("Lecture impossible de « {name} » : {e}");
                    status.lock().unwrap().device_error = Some(message.clone());
                    if let Some(reply) = reply {
                        let _ = reply.send(Err(message));
                    }
                }
            },
            AudioCommand::Pause => {
                if let Some(p) = &self.player {
                    p.pause();
                    status.lock().unwrap().is_paused = true;
                }
            }
            AudioCommand::Resume => {
                if let Some(p) = &self.player {
                    p.play();
                    status.lock().unwrap().is_paused = false;
                }
            }
            AudioCommand::Stop => {
                if let Some(p) = self.player.take() {
                    p.stop();
                }
                let mut st = status.lock().unwrap();
                st.current_path = None;
                st.is_paused = true;
                st.position_secs = 0.0;
                st.finished = false;
            }
            AudioCommand::Seek(pos) => {
                if let Some(p) = &self.player {
                    let _ = p.try_seek(pos);
                }
            }
            AudioCommand::SetVolume(v) => {
                if let Some(p) = &self.player {
                    p.set_volume(v);
                }
            }
        }
    }
}

fn audio_thread_main(rx: Receiver<AudioCommand>, status: Arc<Mutex<AudioStatus>>, eq_gains: EqGains) {
    let mut device = match DeviceSinkBuilder::open_default_sink() {
        Ok(d) => d,
        Err(e) => {
            status.lock().unwrap().device_error =
                Some(format!("Aucune sortie audio disponible : {e}"));
            while rx.recv().is_ok() {}
            return;
        }
    };
    device.log_on_drop(false);
    let mixer = device.mixer().clone();
    let mut engine = Engine {
        _device: device,
        mixer,
        player: None,
        eq_gains,
    };

    loop {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(cmd) => {
                let outcome = panic::catch_unwind(AssertUnwindSafe(|| engine.handle(cmd, &status)));
                if outcome.is_err() {
                    engine.player = None;
                    status.lock().unwrap().device_error =
                        Some("Le moteur audio a rencontré une erreur sur ce fichier.".to_string());
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }

        if let Some(p) = &engine.player {
            let mut st = status.lock().unwrap();
            st.position_secs = p.get_pos().as_secs_f64();
            if p.empty() && st.current_path.is_some() {
                st.finished = true;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id3_header_length_is_read_as_syncsafe_integer() {
        // Taille 0x00 0x00 0x02 0x01 en entiers « syncsafe » = 2*128 + 1 = 257 octets.
        let header = [b'I', b'D', b'3', 4, 0, 0, 0, 0, 2, 1];
        assert_eq!(leading_id3_len(&header), 10 + 257);
        assert_eq!(leading_id3_len(b"fLaC\0\0\0\0\0\0"), 0);
    }

    #[test]
    fn offset_reader_hides_the_leading_bytes() {
        let data = b"JUNKfLaCdata".to_vec();
        let mut r = OffsetReader { inner: Cursor::new(data), offset: 4 };
        r.seek(SeekFrom::Start(0)).unwrap();
        let mut buf = [0u8; 4];
        r.read_exact(&mut buf).unwrap();
        assert_eq!(&buf, b"fLaC");
        assert_eq!(r.stream_position().unwrap(), 4);
    }

    fn write_wav(path: &Path, secs: u32) {
        let rate = 8000u32;
        let n = rate * secs;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + n * 2).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&rate.to_le_bytes());
        bytes.extend_from_slice(&(rate * 2).to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&(n * 2).to_le_bytes());
        for i in 0..n {
            let s = ((i as f32 * 0.05).sin() * 8000.0) as i16;
            bytes.extend_from_slice(&s.to_le_bytes());
        }
        std::fs::write(path, bytes).unwrap();
    }

    #[test]
    fn a_wav_file_decodes_and_is_seekable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.wav");
        write_wav(&path, 2);
        let mut decoder = open_decoder(path.to_str().unwrap()).unwrap();
        assert!(decoder.try_seek(Duration::from_millis(500)).is_ok());
        assert!(decoder.take(100).count() == 100);
    }

    #[test]
    fn a_garbage_file_gives_an_error_instead_of_a_panic() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("casse.m4a");
        std::fs::write(&path, b"ceci n'est pas un m4a").unwrap();
        assert!(open_decoder(path.to_str().unwrap()).is_err());
    }
}
