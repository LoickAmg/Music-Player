//! Synchronisation automatique de paroles sans minutage (texte de lyrics.ovh, des étiquettes
//! ou choisi à la main) : reconnaissance vocale locale avec Whisper « base » quantifié, exécuté
//! par Candle (Rust pur), puis calage des lignes connues sur les mots reconnus et leurs
//! horodatages. Rien ne quitte l'appareil : seul le modèle (environ 80 Mo) est téléchargé, une
//! fois, depuis une révision figée et vérifiée par empreinte SHA-256.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use candle::{Device, IndexOp, Tensor, D};
use candle_transformers::models::whisper::{self as m, quantized_model::Whisper, Config};
use sha2::{Digest, Sha256};

use crate::lyrics::{normalize, LyricLine};

const REPO: &str = "https://huggingface.co/oxide-lab/whisper-base-GGUF/resolve";
/// Révision figée du dépôt (licence MIT, poids d'OpenAI Whisper) : un fichier modifié en amont
/// ne serait pas accepté (empreintes ci-dessous).
const REVISION: &str = "f4721d8552658ff921f4a572eb19f7fa5739e4cc";
const USER_AGENT: &str = "MusicPlayer (https://github.com/LoickAmg/Music-Player)";

struct ModelFile {
    name: &'static str,
    size: u64,
    sha256: &'static str,
}

/// Q8 : en dessous (Q4…), la qualité de reconnaissance s'effondre d'après les auteurs.
const FILES: [ModelFile; 3] = [
    ModelFile {
        name: "whisper-base-q8_0.gguf",
        size: 78_067_328,
        sha256: "7073e51db7ab02b38cc4fceeac39adc2d7a19beb98badf66aa708f4f0ac71aa9",
    },
    ModelFile {
        name: "config.json",
        size: 1_983,
        sha256: "a153c53883a6799b6f056b4a8d1a515c9926d03994682ba88a7616618d7da0c1",
    },
    ModelFile {
        name: "tokenizer.json",
        size: 2_480_466,
        sha256: "27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566",
    },
];

/// Tranche d'un téléchargement (une requête « Range » chacune).
const SLICE: u64 = 8 * 1024 * 1024;

/// Taille totale à télécharger (octets).
pub const MODEL_BYTES: u64 = 78_067_328 + 1_983 + 2_480_466;

/// Filtres mel (80 bandes) de l'exemple Whisper de Candle (MIT ou Apache-2.0).
const MEL_FILTERS: &[u8] = include_bytes!("../assets/melfilters.bytes");

pub fn model_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("modeles").join("whisper-base")
}

pub fn installed(data_dir: &Path) -> bool {
    let dir = model_dir(data_dir);
    FILES
        .iter()
        .all(|f| fs::metadata(dir.join(f.name)).is_ok_and(|m| m.len() == f.size))
}

pub fn remove(data_dir: &Path) {
    let _ = fs::remove_dir_all(model_dir(data_dir));
}

/// Télécharge le modèle (fichiers absents seulement), en vérifiant taille et empreinte de
/// chaque fichier avant de le garder. `progress(fait, total)` en octets.
pub fn install(data_dir: &Path, mut progress: impl FnMut(u64, u64)) -> Result<(), String> {
    let dir = model_dir(data_dir);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Téléchargement par tranches de 8 Mo, chacune avec son propre délai : ureq ne connaît
    // qu'une durée totale de réception, et une connexion qui ne répond plus (constaté à 57 Mo
    // sur 78) bloquerait sinon jusqu'à la fin de ce délai. Une tranche en échec est retentée.
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(20)))
        .timeout_recv_response(Some(Duration::from_secs(30)))
        .timeout_recv_body(Some(Duration::from_secs(4 * 60)))
        .http_status_as_error(false)
        .build()
        .into();
    let mut done = 0u64;
    for file in &FILES {
        let target = dir.join(file.name);
        if fs::metadata(&target).is_ok_and(|m| m.len() == file.size) {
            done += file.size;
            progress(done, MODEL_BYTES);
            continue;
        }
        let url = format!("{REPO}/{REVISION}/{}", file.name);
        let partial = dir.join(format!("{}.part", file.name));
        // Téléchargement interrompu la dernière fois : on reprend où il s'était arrêté.
        let mut hasher = Sha256::new();
        let mut received = 0u64;
        if let Ok(mut previous) = fs::File::open(&partial) {
            let mut buffer = vec![0u8; 256 * 1024];
            loop {
                let n = previous.read(&mut buffer).map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                hasher.update(&buffer[..n]);
                received += n as u64;
            }
            if received >= file.size {
                hasher = Sha256::new();
                received = 0;
            }
        }
        let mut out = if received > 0 {
            fs::OpenOptions::new().append(true).open(&partial)
        } else {
            fs::File::create(&partial)
        }
        .map_err(|e| e.to_string())?;
        progress(done + received, MODEL_BYTES);
        let mut buffer = vec![0u8; 256 * 1024];
        let mut failures = 0;
        while received < file.size {
            let end = (received + SLICE).min(file.size) - 1;
            let attempt = (|| -> Result<u64, String> {
                let mut response = agent
                    .get(&url)
                    .header("User-Agent", USER_AGENT)
                    .header("Range", &format!("bytes={received}-{end}"))
                    .call()
                    .map_err(|e| format!("Téléchargement impossible : {e}"))?;
                let status = response.status().as_u16();
                // 200 : fichier entier renvoyé sans tenir compte de la tranche (petits fichiers).
                let whole = status == 200 && received == 0 && end + 1 == file.size;
                if status != 206 && !whole {
                    return Err(format!("Téléchargement impossible (réponse {status})."));
                }
                let mut reader = response.body_mut().as_reader();
                let mut got = 0u64;
                let want = end + 1 - received;
                while got < want {
                    let room = (want - got).min(buffer.len() as u64) as usize;
                    let n = reader
                        .read(&mut buffer[..room])
                        .map_err(|e| format!("Téléchargement interrompu : {e}"))?;
                    if n == 0 {
                        break;
                    }
                    hasher.update(&buffer[..n]);
                    out.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
                    got += n as u64;
                    progress(done + received + got, MODEL_BYTES);
                }
                Ok(got)
            })();
            match attempt {
                Ok(got) if got > 0 => {
                    received += got;
                    failures = 0;
                }
                outcome => {
                    // Les octets déjà écrits de la tranche sont dans le fichier : on garde
                    // la position réelle pour la reprise.
                    out.flush().map_err(|e| e.to_string())?;
                    let written = fs::metadata(&partial).map(|m| m.len()).unwrap_or(received);
                    if written > received {
                        received = written;
                        failures = 0;
                        continue;
                    }
                    failures += 1;
                    if failures >= 3 {
                        return Err(outcome.err().unwrap_or_else(|| "Téléchargement interrompu.".into()));
                    }
                    std::thread::sleep(Duration::from_secs(2 * failures));
                }
            }
        }
        drop(out);
        let digest = format!("{:x}", hasher.finalize());
        if received != file.size || digest != file.sha256 {
            let _ = fs::remove_file(&partial);
            return Err("Fichier du modèle incomplet ou modifié : téléchargement refusé.".into());
        }
        fs::rename(&partial, &target).map_err(|e| e.to_string())?;
        done += file.size;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------
// Audio : morceau entier en 16 kHz mono
// ---------------------------------------------------------------------------------------

/// Décode le morceau (formats lus par l'application) et le ramène en 16 kHz mono.
fn decode_mono_16k(path: &Path) -> Result<Vec<f32>, String> {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};

    let unreadable = || "Ce format de fichier ne peut pas être synchronisé automatiquement.".to_string();
    let mut format = crate::library::open_format(path).ok_or_else(unreadable)?;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(unreadable)?
        .clone();
    let rate = track.codec_params.sample_rate.ok_or_else(unreadable)? as usize;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|_| unreadable())?;
    let mut mono: Vec<f32> = Vec::new();
    let mut buffer: Option<SampleBuffer<f32>> = None;
    while let Ok(packet) = format.next_packet() {
        if packet.track_id() != track.id {
            continue;
        }
        let Ok(decoded) = decoder.decode(&packet) else {
            continue;
        };
        let spec = *decoded.spec();
        let channels = spec.channels.count().max(1);
        let buf = buffer.get_or_insert_with(|| SampleBuffer::new(decoded.capacity() as u64, spec));
        if buf.capacity() < decoded.capacity() {
            *buf = SampleBuffer::new(decoded.capacity() as u64, spec);
        }
        buf.copy_interleaved_ref(decoded);
        for frame in buf.samples().chunks(channels) {
            mono.push(frame.iter().sum::<f32>() / channels as f32);
        }
    }
    if mono.is_empty() {
        return Err(unreadable());
    }
    Ok(resample(&mono, rate, m::SAMPLE_RATE))
}

/// Rééchantillonnage : moyenne sur la fenêtre de chaque échantillon de sortie (filtre passe-bas
/// grossier, suffisant pour la reconnaissance vocale), interpolation sinon.
fn resample(input: &[f32], from: usize, to: usize) -> Vec<f32> {
    if from == to || input.is_empty() {
        return input.to_vec();
    }
    let ratio = from as f64 / to as f64;
    let out_len = (input.len() as f64 / ratio).floor() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let start = i as f64 * ratio;
        if ratio > 1.0 {
            let a = start as usize;
            let b = ((start + ratio) as usize).min(input.len()).max(a + 1);
            let slice = &input[a..b.min(input.len())];
            out.push(slice.iter().sum::<f32>() / slice.len().max(1) as f32);
        } else {
            let a = start.floor() as usize;
            let b = (a + 1).min(input.len() - 1);
            let t = (start - a as f64) as f32;
            out.push(input[a] * (1.0 - t) + input[b] * t);
        }
    }
    out
}

// ---------------------------------------------------------------------------------------
// Jetons Whisper : décodage du texte (BPE au niveau de l'octet, comme GPT-2)
// ---------------------------------------------------------------------------------------

struct Tokens {
    text: HashMap<u32, String>,
    special: HashMap<String, u32>,
    byte_of: HashMap<char, u8>,
}

impl Tokens {
    fn load(path: &Path) -> Result<Self, String> {
        #[derive(serde::Deserialize)]
        struct Added {
            id: u32,
            content: String,
        }
        #[derive(serde::Deserialize)]
        struct Model {
            vocab: HashMap<String, u32>,
        }
        #[derive(serde::Deserialize)]
        struct File {
            model: Model,
            added_tokens: Vec<Added>,
        }
        let file: File = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        Ok(Self {
            text: file.model.vocab.into_iter().map(|(s, id)| (id, s)).collect(),
            special: file.added_tokens.into_iter().map(|a| (a.content, a.id)).collect(),
            byte_of: bytes_to_unicode().into_iter().map(|(b, c)| (c, b)).collect(),
        })
    }

    fn id(&self, name: &str) -> Result<u32, String> {
        self.special
            .get(name)
            .copied()
            .ok_or_else(|| format!("Jeton {name} absent du modèle."))
    }

    fn decode(&self, ids: &[u32]) -> String {
        let mut bytes = Vec::new();
        for id in ids {
            if let Some(piece) = self.text.get(id) {
                bytes.extend(piece.chars().filter_map(|c| self.byte_of.get(&c).copied()));
            }
        }
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

/// Table octet → caractère du BPE de GPT-2 (reprise par Whisper).
fn bytes_to_unicode() -> Vec<(u8, char)> {
    let mut printable: Vec<u32> = (u32::from('!')..=u32::from('~')).collect();
    printable.extend(u32::from('¡')..=u32::from('¬'));
    printable.extend(u32::from('®')..=u32::from('ÿ'));
    let mut out = Vec::with_capacity(256);
    let mut extra = 0;
    for b in 0u32..256 {
        let c = if printable.contains(&b) {
            b
        } else {
            extra += 1;
            255 + extra
        };
        out.push((b as u8, char::from_u32(c).unwrap_or('?')));
    }
    out
}

// ---------------------------------------------------------------------------------------
// Reconnaissance avec horodatages
// ---------------------------------------------------------------------------------------

/// Passage reconnu : texte et position dans le morceau (secondes).
#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// Modèle tel qu'exécuté sur cet appareil. ARM 64 bits (téléphones) : poids compressés (Q8),
/// rapides grâce à NEON, toujours présent. PC : les calculs rapides des poids compressés de
/// Candle n'existent que si AVX2 est activé à la compilation, ce que l'appli publiée ne peut
/// pas exiger (elle ne démarrerait plus sur les vieux processeurs) ; les poids sont donc
/// décompressés au chargement, et le calcul ordinaire choisit AVX tout seul au lancement
/// (8 s au lieu de 5 min pour 26 s de voix, mesuré en version optimisée).
enum Model {
    Compressed(Whisper),
    Full(m::model::Whisper),
}

impl Model {
    fn load(path: &Path, config: Config, device: &Device) -> candle::Result<Self> {
        if cfg!(target_arch = "aarch64") {
            let vb = candle_transformers::quantized_var_builder::VarBuilder::from_gguf(path, device)?;
            return Ok(Self::Compressed(Whisper::load(&vb, config)?));
        }
        let mut file = fs::File::open(path)?;
        let content = candle::quantized::gguf_file::Content::read(&mut file)?;
        let mut tensors = HashMap::new();
        for name in content.tensor_infos.keys() {
            let tensor = content.tensor(&mut file, name, device)?.dequantize(device)?;
            tensors.insert(name.clone(), tensor);
        }
        let vb = candle_nn::VarBuilder::from_tensors(tensors, candle::DType::F32, device);
        Ok(Self::Full(m::model::Whisper::load(&vb, config)?))
    }

    fn config(&self) -> &Config {
        match self {
            Self::Compressed(w) => &w.config,
            Self::Full(w) => &w.config,
        }
    }

    fn encode(&mut self, mel: &Tensor) -> candle::Result<Tensor> {
        match self {
            Self::Compressed(w) => w.encoder.forward(mel, true),
            Self::Full(w) => w.encoder.forward(mel, true),
        }
    }

    fn decode(&mut self, tokens: &Tensor, audio: &Tensor, first: bool) -> candle::Result<Tensor> {
        match self {
            Self::Compressed(w) => w.decoder.forward(tokens, audio, first),
            Self::Full(w) => w.decoder.forward(tokens, audio, first),
        }
    }

    fn final_linear(&self, x: &Tensor) -> candle::Result<Tensor> {
        match self {
            Self::Compressed(w) => w.decoder.final_linear(x),
            Self::Full(w) => w.decoder.final_linear(x),
        }
    }
}

struct Recognizer {
    model: Model,
    tokens: Tokens,
    suppress: Tensor,
    sot: u32,
    transcribe: u32,
    eot: u32,
    no_speech: u32,
    first_timestamp: u32,
    languages: Vec<u32>,
    device: Device,
}

impl Recognizer {
    fn load(data_dir: &Path) -> Result<Self, String> {
        let dir = model_dir(data_dir);
        let device = Device::Cpu;
        let err = |e: candle::Error| format!("Modèle de reconnaissance illisible : {e}");
        let config: Config =
            serde_json::from_slice(&fs::read(dir.join("config.json")).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        let model = Model::load(&dir.join(FILES[0].name), config.clone(), &device).map_err(err)?;
        let tokens = Tokens::load(&dir.join("tokenizer.json"))?;
        let no_timestamps = tokens.id(m::NO_TIMESTAMPS_TOKEN)?;
        let mut mask = vec![0f32; config.vocab_size];
        for &t in &config.suppress_tokens {
            if let Some(v) = mask.get_mut(t as usize) {
                *v = f32::NEG_INFINITY;
            }
        }
        mask[no_timestamps as usize] = f32::NEG_INFINITY;
        let suppress = Tensor::new(mask.as_slice(), &device).map_err(err)?;
        // Jetons de langue : de <|en|> à celui qui précède <|translate|>.
        let first_language = tokens.id("<|en|>")?;
        let translate = tokens.id(m::TRANSLATE_TOKEN)?;
        Ok(Self {
            sot: tokens.id(m::SOT_TOKEN)?,
            transcribe: tokens.id(m::TRANSCRIBE_TOKEN)?,
            eot: tokens.id(m::EOT_TOKEN)?,
            no_speech: m::NO_SPEECH_TOKENS
                .iter()
                .find_map(|t| tokens.id(t).ok())
                .ok_or("Jeton « pas de voix » absent du modèle.")?,
            first_timestamp: no_timestamps + 1,
            languages: (first_language..translate).collect(),
            model,
            tokens,
            suppress,
            device,
        })
    }

    /// Prédiction du jeton suivant ; au premier pas, aussi celle qui suit le seul début de
    /// transcription (probabilité « pas de voix », langue).
    fn logits(&mut self, tokens: &[u32], audio: &Tensor, first: bool) -> candle::Result<(Option<Tensor>, Tensor)> {
        let input = Tensor::new(tokens, &self.device)?.unsqueeze(0)?;
        let ys = self.model.decode(&input, audio, first)?;
        let (_, len, _) = ys.dims3()?;
        let start = if first {
            Some(self.model.final_linear(&ys.i((..1, ..1))?)?.i(0)?.i(0)?)
        } else {
            None
        };
        let last = self.model.final_linear(&ys.i((..1, len - 1..))?)?.i(0)?.i(0)?;
        Ok((start, last))
    }

    /// Langue chantée, devinée par le modèle sur la première fenêtre (le français et l'anglais
    /// se mélangent souvent : c'est la langue dominante qui compte).
    fn detect_language(&mut self, audio: &Tensor) -> candle::Result<u32> {
        let (_, logits) = self.logits(&[self.sot], audio, true)?;
        let ids = Tensor::new(self.languages.as_slice(), &self.device)?;
        let scores = logits.index_select(&ids, 0)?.to_vec1::<f32>()?;
        let best = scores
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .map_or(0, |(i, _)| i);
        Ok(self.languages[best])
    }

    /// Fenêtre de 30 s au plus : décodage glouton, avec les règles d'horodatage de Whisper
    /// (paires de bornes, bornes croissantes, première borne au début de la fenêtre).
    /// `on_step(jetons produits, maximum)` : avancement à l'intérieur de la fenêtre (le
    /// décodage d'une fenêtre chantée prend jusqu'à une minute sur un téléphone).
    fn decode_window(
        &mut self,
        mel: &Tensor,
        language: u32,
        offset: f64,
        mut on_step: impl FnMut(usize, usize),
    ) -> candle::Result<Vec<Segment>> {
        let audio = self.model.encode(mel)?;
        let mut tokens = vec![self.sot, language, self.transcribe];
        let prefix = tokens.len();
        let max_len = 224;
        let mut no_speech_prob = 0.0;
        let mut logprob_sum = 0.0;
        let mut generated = 0usize;
        for step in 0..max_len {
            let (first, logits) = self.logits(&tokens, &audio, step == 0)?;
            if let Some(first) = first {
                let probs = candle_nn::ops::softmax(&first, D::Minus1)?;
                no_speech_prob = probs.i(self.no_speech as usize)?.to_scalar::<f32>()? as f64;
            }
            let mut logits = logits.broadcast_add(&self.suppress)?.to_vec1::<f32>()?;
            let ts = self.first_timestamp as usize;
            let generated_part = &tokens[prefix..];
            let last_ts = generated_part.last().is_some_and(|&t| t >= self.first_timestamp);
            let before_ts = generated_part.len() < 2
                || generated_part[generated_part.len() - 2] >= self.first_timestamp;
            if generated_part.is_empty() {
                // La première borne : au tout début de la fenêtre (1 s au plus).
                for (i, v) in logits.iter_mut().enumerate() {
                    if i < ts || i > ts + 50 {
                        *v = f32::NEG_INFINITY;
                    }
                }
            } else if last_ts {
                if before_ts {
                    // Paire de bornes complète : on attend du texte.
                    for v in logits.iter_mut().skip(ts) {
                        *v = f32::NEG_INFINITY;
                    }
                } else {
                    // Borne de fin attendue : pas de texte.
                    for (i, v) in logits.iter_mut().enumerate() {
                        if i < self.eot as usize {
                            *v = f32::NEG_INFINITY;
                        }
                    }
                }
            }
            // Bornes croissantes.
            if let Some(&previous) = generated_part.iter().rev().find(|&&t| t >= self.first_timestamp) {
                for v in logits.iter_mut().take(previous as usize).skip(ts) {
                    *v = f32::NEG_INFINITY;
                }
            }
            let (next, best) = logits
                .iter()
                .enumerate()
                .max_by(|a, b| a.1.total_cmp(b.1))
                .map(|(i, v)| (i as u32, *v))
                .unwrap_or((self.eot, 0.0));
            let total: f32 = logits.iter().filter(|v| v.is_finite()).map(|v| (v - best).exp()).sum();
            logprob_sum += -(total.ln() as f64);
            generated += 1;
            on_step(generated, max_len);
            tokens.push(next);
            if next == self.eot || looping(&tokens[prefix..]) {
                break;
            }
        }
        let avg_logprob = logprob_sum / generated.max(1) as f64;
        if no_speech_prob > m::NO_SPEECH_THRESHOLD && avg_logprob < m::LOGPROB_THRESHOLD {
            return Ok(Vec::new());
        }
        Ok(self.segments(&tokens[prefix..], offset))
    }

    fn segments(&self, tokens: &[u32], offset: f64) -> Vec<Segment> {
        let mut out = Vec::new();
        let mut start: Option<f64> = None;
        let mut text: Vec<u32> = Vec::new();
        for &t in tokens {
            if t >= self.first_timestamp {
                // Borne : fin du passage en cours et début du suivant (Whisper la répète
                // souvent, « <|2.40|><|2.40|> », mais pas toujours).
                let time = offset + f64::from(t - self.first_timestamp) * 0.02;
                if let Some(s) = start {
                    let words = self.tokens.decode(&text);
                    if !words.trim().is_empty() && time > s {
                        out.push(Segment { start: s, end: time, text: words.trim().to_string() });
                    }
                }
                text.clear();
                start = Some(time);
            } else if t < self.eot {
                text.push(t);
            }
        }
        out
    }
}

/// Le décodage tourne en rond (« la la la la… ») : on arrête la fenêtre.
fn looping(tokens: &[u32]) -> bool {
    let n = tokens.len();
    (1..=4).any(|period| {
        n >= period * 6 && (0..period * 5).all(|i| tokens[n - 1 - i] == tokens[n - 1 - i - period])
    })
}

/// Synchronisation en cours devenue inutile (autre morceau à l'écran) : arrêtée à la fin de
/// la fenêtre de 30 s en cours, pour laisser la place au nouveau morceau.
static CANCEL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn cancel() {
    CANCEL.store(true, std::sync::atomic::Ordering::SeqCst);
}

pub fn reset_cancel() {
    CANCEL.store(false, std::sync::atomic::Ordering::SeqCst);
}

/// Reconnaît le morceau entier, fenêtre par fenêtre. `progress` va de 0 à 1.
fn transcribe(data_dir: &Path, samples: &[f32], mut progress: impl FnMut(f32)) -> Result<Vec<Segment>, String> {
    let err = |e: candle::Error| format!("Reconnaissance impossible : {e}");
    let mut recognizer = Recognizer::load(data_dir)?;
    let filters: Vec<f32> = MEL_FILTERS.as_chunks::<4>().0.iter().map(|b| f32::from_le_bytes(*b)).collect();
    let mel = m::audio::pcm_to_mel(recognizer.model.config(), samples, &filters);
    let bins = recognizer.model.config().num_mel_bins;
    let frames = mel.len() / bins;
    let mel = Tensor::from_vec(mel, (1, bins, frames), &recognizer.device).map_err(err)?;
    let first_window = mel.narrow(2, 0, frames.min(m::N_FRAMES)).map_err(err)?;
    let audio = recognizer.model.encode(&first_window).map_err(err)?;
    let language = recognizer.detect_language(&audio).map_err(err)?;
    let mut segments = Vec::new();
    let mut seek = 0;
    while seek < frames {
        if CANCEL.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("Synchronisation interrompue.".into());
        }
        let size = (frames - seek).min(m::N_FRAMES);
        // Dernière fenêtre trop courte pour contenir une ligne : ignorée.
        if size < 100 {
            break;
        }
        let window = mel.narrow(2, seek, size).map_err(err)?;
        let offset = (seek * m::HOP_LENGTH) as f64 / m::SAMPLE_RATE as f64;
        // Une fenêtre chantée produit rarement plus de ~120 jetons : avancement estimé sur
        // cette base (plafonné), puis exact à la fin de la fenêtre.
        let (start, span) = (seek as f32, size as f32);
        let found = recognizer
            .decode_window(&window, language, offset, |step, _| {
                progress((start + span * (step as f32 / 120.0).min(0.95)) / frames as f32);
            })
            .map_err(err)?;
        segments.extend(found);
        seek += size;
        progress(seek as f32 / frames as f32);
    }
    Ok(segments)
}

// ---------------------------------------------------------------------------------------
// Calage des paroles connues sur les mots reconnus
// ---------------------------------------------------------------------------------------

/// Mot reconnu et instant (estimé) où il est chanté.
struct Heard {
    word: String,
    time: f64,
}

/// Les mots de chaque passage, répartis dans le temps selon leur longueur.
fn heard_words(segments: &[Segment]) -> Vec<Heard> {
    let mut out = Vec::new();
    for s in segments {
        let words: Vec<String> = normalize(&s.text).split(' ').filter(|w| !w.is_empty()).map(str::to_string).collect();
        let total: usize = words.iter().map(|w| w.chars().count() + 1).sum();
        let mut before = 0usize;
        for w in words {
            let time = s.start + (s.end - s.start) * before as f64 / total.max(1) as f64;
            before += w.chars().count() + 1;
            out.push(Heard { word: w, time });
        }
    }
    out
}

fn levenshtein(a: &[char], b: &[char]) -> usize {
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut previous = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let current = row[j + 1];
            row[j + 1] = if ca == cb { previous } else { 1 + previous.min(row[j]).min(row[j + 1]) };
            previous = current;
        }
    }
    row[b.len()]
}

/// Ressemblance de deux mots : 2 identiques, 1 proches (la reconnaissance du chant écorche
/// souvent les mots : « juninho » / « junino »), négatif sinon.
fn similarity(a: &str, b: &str) -> f32 {
    if a == b {
        return 2.0;
    }
    let (ca, cb): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let longest = ca.len().max(cb.len());
    if ca.len().min(cb.len()) >= 3 && levenshtein(&ca, &cb) as f32 / longest as f32 <= 0.34 {
        1.0
    } else {
        -1.0
    }
}

/// Instant de départ de chaque ligne de `lines`, d'après les passages reconnus : alignement
/// des mots (programmation dynamique, comme pour comparer deux textes), puis interpolation des
/// lignes sans mot reconnu. `None` si trop peu de lignes ont pu être calées pour s'y fier.
pub fn align_lines(lines: &[String], segments: &[Segment], duration: f64) -> Option<Vec<LyricLine>> {
    let lines: Vec<&String> = lines.iter().filter(|l| !normalize(l).is_empty()).collect();
    if lines.is_empty() {
        return None;
    }
    let mut words: Vec<(String, usize)> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        for w in normalize(line).split(' ').filter(|w| !w.is_empty()) {
            words.push((w.to_string(), i));
        }
    }
    let heard = heard_words(segments);
    let (n, k) = (words.len(), heard.len());
    if n == 0 || k == 0 {
        return None;
    }
    // Alignement global : correspondance, ou mot sauté d'un côté (pénalité légère : refrains
    // non reconnus, mots inventés par la reconnaissance).
    const GAP: f32 = -0.4;
    let mut score = vec![0f32; (n + 1) * (k + 1)];
    let mut from = vec![0u8; (n + 1) * (k + 1)];
    let at = |i: usize, j: usize| i * (k + 1) + j;
    for i in 1..=n {
        score[at(i, 0)] = score[at(i - 1, 0)] + GAP;
        from[at(i, 0)] = 1;
    }
    for j in 1..=k {
        score[at(0, j)] = score[at(0, j - 1)] + GAP;
        from[at(0, j)] = 2;
    }
    for i in 1..=n {
        for j in 1..=k {
            let diag = score[at(i - 1, j - 1)] + similarity(&words[i - 1].0, &heard[j - 1].word);
            let up = score[at(i - 1, j)] + GAP;
            let left = score[at(i, j - 1)] + GAP;
            let (best, dir) = if diag >= up && diag >= left {
                (diag, 0)
            } else if up >= left {
                (up, 1)
            } else {
                (left, 2)
            };
            score[at(i, j)] = best;
            from[at(i, j)] = dir;
        }
    }
    // Remontée : mots des paroles reconnus et leur instant.
    let mut anchor: Vec<Option<f64>> = vec![None; n];
    let (mut i, mut j) = (n, k);
    while i > 0 && j > 0 {
        match from[at(i, j)] {
            0 => {
                if similarity(&words[i - 1].0, &heard[j - 1].word) > 0.0 {
                    anchor[i - 1] = Some(heard[j - 1].time);
                }
                i -= 1;
                j -= 1;
            }
            1 => i -= 1,
            _ => j -= 1,
        }
    }
    const WORD_SECS: f64 = 0.32;
    let mut times: Vec<Option<f64>> = vec![None; lines.len()];
    let mut first_word = 0usize;
    for (line, slot) in times.iter_mut().enumerate() {
        let count = words.iter().filter(|(_, l)| *l == line).count();
        if let Some((pos, t)) = (first_word..first_word + count).find_map(|w| anchor[w].map(|t| (w - first_word, t))) {
            *slot = Some((t - pos as f64 * WORD_SECS).max(0.0));
        }
        first_word += count;
    }
    let anchored = times.iter().filter(|t| t.is_some()).count();
    let matched = anchor.iter().filter(|a| a.is_some()).count();
    if (anchored as f64) < lines.len() as f64 * 0.35 || (matched as f64) < n as f64 * 0.15 {
        return None;
    }
    // Lignes sans mot reconnu : réparties entre les lignes calées qui les entourent.
    let known: Vec<(usize, f64)> = times.iter().enumerate().filter_map(|(i, t)| t.map(|t| (i, t))).collect();
    let mut filled = vec![0f64; lines.len()];
    for (i, slot) in filled.iter_mut().enumerate() {
        *slot = match times[i] {
            Some(t) => t,
            None => {
                let before = known.iter().rev().find(|(k, _)| *k < i);
                let after = known.iter().find(|(k, _)| *k > i);
                match (before, after) {
                    (Some(&(a, ta)), Some(&(b, tb))) => ta + (tb - ta) * (i - a) as f64 / (b - a) as f64,
                    (Some(&(a, ta)), None) => ta + (i - a) as f64 * 3.0,
                    (None, Some(&(b, tb))) => (tb - (b - i) as f64 * 3.0).max(0.0),
                    (None, None) => 0.0,
                }
            }
        };
    }
    // Ordre croissant, et jamais après la fin du morceau.
    let limit = if duration > 0.0 { duration } else { f64::MAX };
    for i in 1..filled.len() {
        if filled[i] <= filled[i - 1] {
            filled[i] = filled[i - 1] + 0.2;
        }
    }
    Some(
        lines
            .iter()
            .zip(filled)
            .map(|(text, t)| LyricLine {
                time_ms: (t.min(limit) * 1000.0).round() as u64,
                text: text.trim().to_string(),
                words: None,
            })
            .collect(),
    )
}

/// Synchronise `plain` sur le morceau : décodage, reconnaissance, calage. `progress` de 0 à 1.
pub fn synchronize(
    data_dir: &Path,
    track_path: &Path,
    duration: f64,
    plain: &str,
    mut progress: impl FnMut(f32),
) -> Result<Vec<LyricLine>, String> {
    if !installed(data_dir) {
        return Err("Le modèle de synchronisation n'est pas installé.".into());
    }
    progress(0.02);
    let samples = decode_mono_16k(track_path)?;
    progress(0.08);
    let segments = transcribe(data_dir, &samples, |f| progress(0.08 + f * 0.9))?;
    let lines: Vec<String> = plain.lines().map(str::to_string).collect();
    let synced = align_lines(&lines, &segments, duration)
        .ok_or("La voix n'a pas pu être suivie assez sûrement pour synchroniser ces paroles.")?;
    progress(1.0);
    Ok(synced)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(start: f64, end: f64, text: &str) -> Segment {
        Segment { start, end, text: text.into() }
    }

    #[test]
    fn byte_table_matches_gpt2() {
        let table: HashMap<u8, char> = bytes_to_unicode().into_iter().collect();
        assert_eq!(table[&b'a'], 'a');
        // L'espace devient « Ġ », marque de début de mot du BPE.
        assert_eq!(table[&b' '], 'Ġ');
        assert_eq!(table.len(), 256);
    }

    #[test]
    fn resampling_keeps_duration() {
        let input = vec![0.5f32; 44_100];
        let out = resample(&input, 44_100, 16_000);
        assert_eq!(out.len(), 16_000);
        assert!(out.iter().all(|v| (v - 0.5).abs() < 1e-6));
    }

    #[test]
    fn lines_follow_the_recognised_words_even_when_misheard() {
        let lines: Vec<String> = [
            "Il veut s'la foutre au Don Junio, quand Junie Juninho",
            "",
            "C'est c'bod' qui donne le La",
            "Mais bébé viens on rentre",
            "carrément il s'fait tard",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let segments = [
            seg(4.0, 9.0, "il veut sa foutre au don junio quand junie junino"),
            seg(10.0, 13.0, "c'est ce bod qui donne le la"),
            // « Mais bébé viens on rentre » pas reconnu du tout.
            seg(20.0, 23.0, "carrément il se fait tard"),
        ];
        let synced = align_lines(&lines, &segments, 120.0).unwrap();
        assert_eq!(synced.len(), 4, "les lignes vides ne sont pas minutées");
        assert!((synced[0].time_ms as i64 - 4_000).abs() < 500);
        assert!((synced[1].time_ms as i64 - 10_000).abs() < 500);
        // Ligne non reconnue : entre ses voisines.
        assert!(synced[2].time_ms > synced[1].time_ms && synced[2].time_ms < synced[3].time_ms);
        assert!((synced[3].time_ms as i64 - 20_000).abs() < 500);
    }

    #[test]
    fn unrelated_recognition_is_refused() {
        let lines: Vec<String> = ["Sous les néons de la ville", "Je compte les heures qui filent"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let segments = [seg(0.0, 5.0, "thank you for watching"), seg(6.0, 9.0, "music")];
        assert!(align_lines(&lines, &segments, 60.0).is_none());
    }

    /// De bout en bout, avec le vrai modèle (téléchargé dans MP_ALIGN_DATA) et un fichier de
    /// voix (MP_ALIGN_WAV) : les cinq lignes ci-dessous lues avec 4 s de silence entre elles.
    #[test]
    #[ignore = "télécharge le modèle (80 Mo) ; à lancer en --release avec MP_ALIGN_DATA et MP_ALIGN_WAV"]
    fn end_to_end_on_a_spoken_file() {
        let wav = std::env::var("MP_ALIGN_WAV").expect("MP_ALIGN_WAV");
        let data = PathBuf::from(std::env::var("MP_ALIGN_DATA").expect("MP_ALIGN_DATA"));
        install(&data, |_, _| {}).unwrap();
        assert!(installed(&data));
        let plain = "Sous les néons de la ville\nJe compte les heures qui filent\nEt la nuit me répond\nPar des échos sans nom\nMinuit passé, je reste là";
        let started = std::time::Instant::now();
        let lines = synchronize(&data, Path::new(&wav), 0.0, plain, |_| {}).unwrap();
        eprintln!("synchronisé en {:.1} s", started.elapsed().as_secs_f64());
        for l in &lines {
            eprintln!("{:>6} ms  {}", l.time_ms, l.text);
        }
        assert_eq!(lines.len(), 5);
        // Whisper place souvent le début du premier passage à 0 s, même après un silence.
        assert!(lines[0].time_ms <= 3_500);
        for w in lines.windows(2) {
            assert!(w[1].time_ms >= w[0].time_ms + 3_500, "{} puis {}", w[0].time_ms, w[1].time_ms);
        }
    }

    /// Durée réelle sur un vrai morceau (MP_ALIGN_SONG, paroles texte dans MP_ALIGN_TEXT),
    /// modèle déjà installé dans MP_ALIGN_DATA. Affiche l'avancement et le temps total.
    #[test]
    #[ignore = "vrai morceau : à lancer en --release avec MP_ALIGN_DATA, MP_ALIGN_SONG et MP_ALIGN_TEXT"]
    fn timing_on_a_real_song() {
        let data = PathBuf::from(std::env::var("MP_ALIGN_DATA").expect("MP_ALIGN_DATA"));
        let song = std::env::var("MP_ALIGN_SONG").expect("MP_ALIGN_SONG");
        let plain = std::fs::read_to_string(std::env::var("MP_ALIGN_TEXT").expect("MP_ALIGN_TEXT")).unwrap();
        let started = std::time::Instant::now();
        let mut last = -1.0;
        let result = synchronize(&data, Path::new(&song), 0.0, &plain, |f| {
            if f - last >= 0.1 {
                last = f;
                eprintln!("{:>3.0} % après {:.1} s", f * 100.0, started.elapsed().as_secs_f64());
            }
        });
        eprintln!("terminé en {:.1} s : {:?}", started.elapsed().as_secs_f64(), result.as_ref().map(|l| l.len()));
    }

    #[test]
    fn looping_decoder_is_detected() {
        assert!(looping(&[5, 6, 5, 6, 5, 6, 5, 6, 5, 6, 5, 6]));
        assert!(!looping(&[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
    }
}
