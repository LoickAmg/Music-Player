//! Visualiseur : les derniers échantillons joués (mono) sont gardés au passage dans le flux
//! audio (`Tap`), et l'interface demande le spectre quand elle l'affiche : 32 bandes de
//! fréquence en échelle logarithmique (40 Hz à 16 kHz), de 0 à 255.

use rodio::source::SeekError;
use rodio::{ChannelCount, SampleRate, Source};
use rustfft::num_complex::Complex;
use rustfft::FftPlanner;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

/// Taille de la fenêtre analysée (≈ 46 ms à 44,1 kHz).
const WINDOW: usize = 2048;
pub const BANDS: usize = 32;
/// Échantillons regroupés avant de prendre le verrou (jamais à chaque échantillon).
const BATCH: usize = 256;

struct Ring {
    samples: Vec<f32>,
    cursor: usize,
    sample_rate: u32,
    /// Nouveaux échantillons depuis la dernière analyse (sinon : lecture en pause).
    fresh: bool,
}

static RING: LazyLock<Mutex<Ring>> = LazyLock::new(|| {
    Mutex::new(Ring { samples: vec![0.0; WINDOW], cursor: 0, sample_rate: 44_100, fresh: false })
});

/// Source qui laisse passer le son tel quel en gardant une copie mono des échantillons.
pub struct Tap<I> {
    input: I,
    channels: usize,
    sample_rate: u32,
    channel: usize,
    sum: f32,
    batch: Vec<f32>,
}

impl<I: Source<Item = f32>> Tap<I> {
    pub fn new(input: I) -> Self {
        let channels = input.channels().get() as usize;
        let sample_rate = input.sample_rate().get();
        Self { input, channels, sample_rate, channel: 0, sum: 0.0, batch: Vec::with_capacity(BATCH) }
    }

    fn flush(&mut self) {
        // Le thread audio n'attend jamais : verrou pris ailleurs, ce lot est simplement perdu.
        if let Ok(mut ring) = RING.try_lock() {
            ring.sample_rate = self.sample_rate;
            for &s in &self.batch {
                let at = ring.cursor;
                ring.samples[at] = s;
                ring.cursor = (at + 1) % WINDOW;
            }
            ring.fresh = true;
        }
        self.batch.clear();
    }
}

impl<I: Source<Item = f32>> Iterator for Tap<I> {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        let sample = self.input.next()?;
        self.sum += sample;
        self.channel += 1;
        if self.channel >= self.channels {
            self.batch.push(self.sum / self.channels as f32);
            self.sum = 0.0;
            self.channel = 0;
            if self.batch.len() >= BATCH {
                self.flush();
            }
        }
        Some(sample)
    }
}

impl<I: Source<Item = f32>> Source for Tap<I> {
    fn current_span_len(&self) -> Option<usize> {
        self.input.current_span_len()
    }
    fn channels(&self) -> ChannelCount {
        self.input.channels()
    }
    fn sample_rate(&self) -> SampleRate {
        self.input.sample_rate()
    }
    fn total_duration(&self) -> Option<Duration> {
        self.input.total_duration()
    }
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        self.channel = 0;
        self.sum = 0.0;
        self.batch.clear();
        self.input.try_seek(pos)
    }
}

/// Spectre des derniers échantillons ; vide si rien n'a été joué depuis la dernière demande.
pub fn bands() -> Vec<u8> {
    let (window, sample_rate) = {
        let mut ring = RING.lock().unwrap();
        if !ring.fresh {
            return Vec::new();
        }
        ring.fresh = false;
        let mut window = Vec::with_capacity(WINDOW);
        window.extend_from_slice(&ring.samples[ring.cursor..]);
        window.extend_from_slice(&ring.samples[..ring.cursor]);
        (window, ring.sample_rate)
    };
    analyse(&window, sample_rate)
}

pub fn analyse(window: &[f32], sample_rate: u32) -> Vec<u8> {
    let n = window.len();
    let mut buffer: Vec<Complex<f32>> = window
        .iter()
        .enumerate()
        .map(|(i, &s)| {
            // Fenêtre de Hann : pas de fuite spectrale aux bords de la fenêtre.
            let w = 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (n - 1) as f32).cos();
            Complex::new(s * w, 0.0)
        })
        .collect();
    FftPlanner::<f32>::new().plan_fft_forward(n).process(&mut buffer);
    let bin_hz = sample_rate as f32 / n as f32;
    let (low, high) = (40.0f32, 16_000.0f32.min(sample_rate as f32 / 2.0));
    (0..BANDS)
        .map(|b| {
            let f0 = low * (high / low).powf(b as f32 / BANDS as f32);
            let f1 = low * (high / low).powf((b + 1) as f32 / BANDS as f32);
            let i0 = ((f0 / bin_hz) as usize).max(1);
            let i1 = ((f1 / bin_hz) as usize).max(i0 + 1).min(n / 2);
            let peak = buffer[i0..i1].iter().map(|c| c.norm()).fold(0.0f32, f32::max);
            // Amplitude → dB, de -70 dB (0) à 0 dB (255) pour une sinusoïde pleine échelle.
            let db = 20.0 * (peak / (n as f32 / 4.0)).max(1e-9).log10();
            (((db + 70.0) / 70.0).clamp(0.0, 1.0) * 255.0) as u8
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pure_tone_lights_its_own_band() {
        let rate = 44_100;
        let tone: Vec<f32> =
            (0..WINDOW).map(|i| (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / rate as f32).sin() * 0.8).collect();
        let bands = analyse(&tone, rate);
        assert_eq!(bands.len(), BANDS);
        let loudest = bands.iter().enumerate().max_by_key(|(_, v)| **v).unwrap().0;
        // 1 kHz : bande ≈ 32 × log(1000/40) / log(16000/40) ≈ 17.
        assert!((16..=18).contains(&loudest), "{loudest} {bands:?}");
        assert!(bands[2] < bands[loudest] / 2, "{bands:?}");
    }

    #[test]
    fn silence_is_flat() {
        assert!(analyse(&[0.0; WINDOW], 44_100).iter().all(|&v| v == 0));
    }
}
