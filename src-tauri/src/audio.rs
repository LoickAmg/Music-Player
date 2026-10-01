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
use std::sync::atomic::{AtomicBool, Ordering};
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
    /// Instant de la mesure de `position_secs` (la position n'est relevée que toutes les
    /// 200 ms) : sert à l'extrapoler, voir [`AudioStatus::position_now`].
    pub measured_at: Option<std::time::Instant>,
    /// La piste s'est terminée d'elle-même et n'a pas encore été "consommée" par
    /// `poll_auto_advance`.
    pub finished: bool,
    /// Dernière erreur de sortie audio ou de décodage, affichée par l'interface.
    pub device_error: Option<String>,
}

impl AudioStatus {
    /// Position à l'instant présent : la dernière mesure plus le temps écoulé depuis, si
    /// la lecture est en cours. Évite une position en retard de 0 à 200 ms, qui faisait
    /// « reculer » les paroles à chaque sondage de l'interface.
    pub fn position_now(&self) -> f64 {
        match self.measured_at {
            Some(at) if !self.is_paused && self.current_path.is_some() && !self.finished => {
                self.position_secs + at.elapsed().as_secs_f64().min(0.5)
            }
            _ => self.position_secs,
        }
    }
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
        answer
            .recv_timeout(Duration::from_secs(60))
            .unwrap_or_else(|_| {
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
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    let reader = BufReader::new(OffsetReader {
        inner: file,
        offset,
    });
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
    /// Volume courant, réappliqué quand la sortie est rouverte.
    volume: f32,
    /// Levé par le système quand il coupe le flux audio.
    lost: Arc<AtomicBool>,
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
                    self.volume = volume;
                    player.append(EqSource::new(decoder, self.eq_gains.clone()));
                    self.player = Some(player);
                    let mut st = status.lock().unwrap();
                    st.current_path = Some(path);
                    st.is_paused = false;
                    st.finished = false;
                    st.position_secs = 0.0;
                    st.measured_at = Some(std::time::Instant::now());
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
                st.measured_at = None;
                st.finished = false;
            }
            AudioCommand::Seek(pos) => {
                if let Some(p) = &self.player {
                    let _ = p.try_seek(pos);
                }
            }
            AudioCommand::SetVolume(v) => {
                self.volume = v;
                if let Some(p) = &self.player {
                    p.set_volume(v);
                }
            }
        }
    }
}

/// Texte lisible d'une panique interceptée.
fn panic_text(payload: Box<dyn std::any::Any + Send>) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "erreur interne".to_string())
}

/// Ouvre la sortie audio. D'abord la configuration par défaut du système ; en secours
/// (utile sur Android, où l'interrogation du système peut échouer), une configuration
/// fixe 48 kHz stéréo, sans rien demander au système. Toute panique est interceptée
/// pour que la cause remonte jusqu'à l'interface.
fn open_output(lost: &Arc<AtomicBool>) -> Result<rodio::MixerDeviceSink, String> {
    use rodio::cpal::traits::HostTrait;
    use std::num::NonZero;

    // Flux coupé par le système (enregistrement d'écran qui capte le son, casque ou
    // Bluetooth branché ou débranché…) : signalé au fil audio, qui rouvre la sortie.
    let on_error = {
        let lost = lost.clone();
        move |error: rodio::cpal::StreamError| {
            if matches!(
                error,
                rodio::cpal::StreamError::DeviceNotAvailable
                    | rodio::cpal::StreamError::StreamInvalidated
            ) {
                lost.store(true, Ordering::SeqCst);
            }
        }
    };

    let mut errors = Vec::new();
    let preferred = {
        let on_error = on_error.clone();
        panic::catch_unwind(AssertUnwindSafe(move || {
            DeviceSinkBuilder::from_default_device()
                .and_then(|b| b.with_error_callback(on_error).open_sink_or_fallback())
        }))
    };
    match preferred {
        Ok(Ok(device)) => return Ok(device),
        Ok(Err(e)) => errors.push(e.to_string()),
        Err(p) => errors.push(panic_text(p)),
    }
    match panic::catch_unwind(DeviceSinkBuilder::open_default_sink) {
        Ok(Ok(device)) => return Ok(device),
        Ok(Err(e)) => errors.push(e.to_string()),
        Err(p) => errors.push(panic_text(p)),
    }
    for format in [
        rodio::cpal::SampleFormat::F32,
        rodio::cpal::SampleFormat::I16,
    ] {
        let on_error = on_error.clone();
        let attempt = panic::catch_unwind(AssertUnwindSafe(
            move || -> Result<rodio::MixerDeviceSink, String> {
                let device = rodio::cpal::default_host()
                    .default_output_device()
                    .ok_or_else(|| "aucun périphérique de sortie".to_string())?;
                DeviceSinkBuilder::default()
                    .with_error_callback(on_error)
                    .with_device(device)
                    .with_channels(NonZero::new(2).unwrap())
                    .with_sample_rate(NonZero::new(48_000).unwrap())
                    .with_sample_format(format)
                    .with_buffer_size(rodio::cpal::BufferSize::Fixed(2048))
                    .open_stream()
                    .map_err(|e| e.to_string())
            },
        ));
        match attempt {
            Ok(Ok(device)) => return Ok(device),
            Ok(Err(e)) => errors.push(e),
            Err(p) => errors.push(panic_text(p)),
        }
    }
    Err(errors.join(" ; "))
}

fn new_engine(eq_gains: &EqGains) -> Result<Engine, String> {
    let lost = Arc::new(AtomicBool::new(false));
    let mut device = open_output(&lost)?;
    device.log_on_drop(false);
    let mixer = device.mixer().clone();
    Ok(Engine {
        _device: device,
        mixer,
        player: None,
        eq_gains: eq_gains.clone(),
        volume: 1.0,
        lost,
    })
}

/// Où reprendre après la perte du flux audio.
#[derive(Clone)]
struct Resume {
    path: Option<String>,
    position: Duration,
    paused: bool,
    volume: f32,
}

impl Resume {
    fn of(engine: &Engine, status: &Mutex<AudioStatus>) -> Self {
        let st = status.lock().unwrap();
        Self {
            path: st.current_path.clone(),
            position: engine
                .player
                .as_ref()
                .map(|p| p.get_pos())
                .unwrap_or_default(),
            paused: st.is_paused,
            volume: engine.volume,
        }
    }
}

/// Reconstruit la sortie audio et reprend le morceau au même endroit (et dans le même état,
/// lecture ou pause). `None` si la sortie ne peut pas encore être rouverte.
fn reopen(resume: &Resume, eq_gains: &EqGains, status: &Mutex<AudioStatus>) -> Option<Engine> {
    let mut engine = new_engine(eq_gains).ok()?;
    engine.volume = resume.volume;
    if let Some(path) = &resume.path {
        engine.handle(
            AudioCommand::Play(path.clone(), resume.volume, None),
            status,
        );
        if resume.position > Duration::from_millis(500) {
            engine.handle(AudioCommand::Seek(resume.position), status);
        }
        if resume.paused {
            engine.handle(AudioCommand::Pause, status);
        }
    }
    Some(engine)
}

fn audio_thread_main(
    rx: Receiver<AudioCommand>,
    status: Arc<Mutex<AudioStatus>>,
    eq_gains: EqGains,
) {
    // La sortie audio est ouverte au démarrage, et de nouveau à chaque lecture tant
    // qu'elle n'a pas pu l'être : le thread ne meurt jamais, et chaque échec est expliqué.
    let mut engine = match new_engine(&eq_gains) {
        Ok(engine) => Some(engine),
        Err(e) => {
            status.lock().unwrap().device_error =
                Some(format!("Aucune sortie audio disponible : {e}"));
            None
        }
    };

    let mut watch = StreamWatch::default();
    loop {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(cmd) => {
                if engine.is_none() {
                    if let AudioCommand::Play(_, _, reply) = &cmd {
                        match new_engine(&eq_gains) {
                            Ok(e) => {
                                engine = Some(e);
                                status.lock().unwrap().device_error = None;
                            }
                            Err(e) => {
                                let message = format!("Aucune sortie audio disponible : {e}");
                                status.lock().unwrap().device_error = Some(message.clone());
                                if let Some(reply) = reply {
                                    let _ = reply.send(Err(message));
                                }
                                continue;
                            }
                        }
                    } else {
                        continue;
                    }
                }
                let Some(active) = engine.as_mut() else {
                    continue;
                };
                let outcome = panic::catch_unwind(AssertUnwindSafe(|| active.handle(cmd, &status)));
                if let Err(p) = outcome {
                    active.player = None;
                    status.lock().unwrap().device_error = Some(format!(
                        "Le moteur audio a rencontré une erreur sur ce fichier : {}",
                        panic_text(p)
                    ));
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }

        if let Some(p) = engine.as_ref().and_then(|e| e.player.as_ref()) {
            let mut st = status.lock().unwrap();
            let position = p.get_pos();
            st.position_secs = position.as_secs_f64();
            st.measured_at = Some(std::time::Instant::now());
            if p.empty() && st.current_path.is_some() {
                st.finished = true;
            }
            // Lecture censée avancer mais position figée : le flux ne tourne plus (coupé
            // sans prévenir par certains téléphones).
            let playing = !st.is_paused && !st.finished && !p.empty();
            if playing && position == watch.last_position {
                watch
                    .stalled_since
                    .get_or_insert_with(std::time::Instant::now);
            } else {
                watch.stalled_since = None;
            }
            watch.last_position = position;
        }

        // Flux coupé par le système, ou lecture figée depuis 2 s : l'ancienne sortie est
        // libérée et l'endroit où reprendre retenu…
        let lost = engine
            .as_ref()
            .is_some_and(|e| e.lost.load(Ordering::SeqCst));
        let stalled = watch
            .stalled_since
            .is_some_and(|t| t.elapsed() > Duration::from_secs(2));
        if lost || stalled {
            watch.stalled_since = None;
            if let Some(old) = engine.take() {
                watch.pending = Some(Resume::of(&old, &status));
                drop(old);
            }
        }
        // …puis la sortie est rouverte et le morceau repris, avec un nouvel essai toutes les
        // 2 s tant que le système ne la rend pas (enregistreur d'écran qui la monopolise…).
        if engine.is_none()
            && watch.pending.is_some()
            && watch
                .last_reopen
                .is_none_or(|t| t.elapsed() > Duration::from_secs(2))
        {
            watch.last_reopen = Some(std::time::Instant::now());
            let resume = watch.pending.clone().unwrap();
            match reopen(&resume, &eq_gains, &status) {
                Some(e) => {
                    engine = Some(e);
                    watch.pending = None;
                }
                None => {
                    status.lock().unwrap().device_error =
                        Some("La sortie audio a été coupée par le système ; nouvel essai…".into());
                }
            }
        }
    }
}

/// Surveillance du flux audio par le fil audio.
#[derive(Default)]
struct StreamWatch {
    last_position: Duration,
    stalled_since: Option<std::time::Instant>,
    last_reopen: Option<std::time::Instant>,
    /// Morceau à reprendre dès que la sortie audio pourra être rouverte.
    pending: Option<Resume>,
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
        let mut r = OffsetReader {
            inner: Cursor::new(data),
            offset: 4,
        };
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
