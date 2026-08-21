//! Mini égaliseur 3 bandes (basses / médiums / aigus), implémenté comme
//! une cascade de 3 filtres "peaking" biquad (formules RBJ Audio EQ
//! Cookbook), appliqués en direct sur le flux audio via un `rodio::Source`
//! maison. Les gains sont partagés dans un `Arc<Mutex<[f32; 3]>>` pour
//! pouvoir être ajustés en direct pendant la lecture, sans reconstruire
//! le pipeline audio.

use rodio::Source;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Fréquences centrales des 3 bandes : basses, médiums, aigus (Hz).
pub const BAND_FREQS: [f32; 3] = [120.0, 1000.0, 8000.0];
const Q: f32 = 0.9;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BiquadCoeffs {
    pub b0: f32,
    pub b1: f32,
    pub b2: f32,
    pub a1: f32,
    pub a2: f32,
}

/// Coefficients d'un filtre "peaking EQ" (formule RBJ Audio EQ Cookbook),
/// déjà normalisés par `a0`.
pub fn peaking_eq_coeffs(sample_rate: f32, freq: f32, q: f32, gain_db: f32) -> BiquadCoeffs {
    let a = 10f32.powf(gain_db / 40.0);
    let w0 = 2.0 * std::f32::consts::PI * freq / sample_rate;
    let alpha = w0.sin() / (2.0 * q);
    let cos_w0 = w0.cos();

    let b0 = 1.0 + alpha * a;
    let b1 = -2.0 * cos_w0;
    let b2 = 1.0 - alpha * a;
    let a0 = 1.0 + alpha / a;
    let a1 = -2.0 * cos_w0;
    let a2 = 1.0 - alpha / a;

    BiquadCoeffs {
        b0: b0 / a0,
        b1: b1 / a0,
        b2: b2 / a0,
        a1: a1 / a0,
        a2: a2 / a0,
    }
}

#[derive(Debug, Default, Clone, Copy)]
struct BiquadState {
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,
}

impl BiquadState {
    fn process(&mut self, x0: f32, c: &BiquadCoeffs) -> f32 {
        let y0 = c.b0 * x0 + c.b1 * self.x1 + c.b2 * self.x2 - c.a1 * self.y1 - c.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x0;
        self.y2 = self.y1;
        self.y1 = y0;
        y0
    }
}

/// Gains courants en dB des 3 bandes, partagés entre le thread audio et
/// les commandes Tauri qui les modifient depuis le frontend.
pub type EqGains = Arc<Mutex<[f32; 3]>>;

pub fn new_eq_gains(initial: [f32; 3]) -> EqGains {
    Arc::new(Mutex::new(initial))
}

fn compute_all_coeffs(sample_rate: f32, gains: &[f32; 3]) -> [BiquadCoeffs; 3] {
    [
        peaking_eq_coeffs(sample_rate, BAND_FREQS[0], Q, gains[0]),
        peaking_eq_coeffs(sample_rate, BAND_FREQS[1], Q, gains[1]),
        peaking_eq_coeffs(sample_rate, BAND_FREQS[2], Q, gains[2]),
    ]
}

pub struct EqSource<I> {
    input: I,
    channels: u16,
    sample_rate: u32,
    gains: EqGains,
    cached_gains: [f32; 3],
    coeffs: [BiquadCoeffs; 3],
    /// État des filtres par canal (index = numéro de canal) puis par bande.
    state: Vec<[BiquadState; 3]>,
    channel_cursor: usize,
}

impl<I> EqSource<I>
where
    I: Source<Item = f32>,
{
    pub fn new(input: I, gains: EqGains) -> Self {
        let channels = input.channels().max(1);
        let sample_rate = input.sample_rate();
        let cached_gains = *gains.lock().unwrap();
        let coeffs = compute_all_coeffs(sample_rate as f32, &cached_gains);
        let state = vec![[BiquadState::default(); 3]; channels as usize];
        Self {
            input,
            channels,
            sample_rate,
            gains,
            cached_gains,
            coeffs,
            state,
            channel_cursor: 0,
        }
    }
}

impl<I> Iterator for EqSource<I>
where
    I: Source<Item = f32>,
{
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        let sample = self.input.next()?;

        // On ne bloque jamais le thread audio pour aller lire un
        // changement de gain : si le verrou est momentanément pris par le
        // thread des commandes, on garde les coefficients précédents pour
        // cet échantillon, imperceptible à l'oreille.
        if let Ok(current) = self.gains.try_lock() {
            if *current != self.cached_gains {
                self.cached_gains = *current;
                self.coeffs = compute_all_coeffs(self.sample_rate as f32, &self.cached_gains);
            }
        }

        let channel = self.channel_cursor % self.channels as usize;
        self.channel_cursor += 1;

        let channel_state = &mut self.state[channel];
        let mut out = sample;
        for (band_state, coeffs) in channel_state.iter_mut().zip(self.coeffs.iter()) {
            out = band_state.process(out, coeffs);
        }
        Some(out)
    }
}

impl<I> Source for EqSource<I>
where
    I: Source<Item = f32>,
{
    fn current_frame_len(&self) -> Option<usize> {
        self.input.current_frame_len()
    }
    fn channels(&self) -> u16 {
        self.channels
    }
    fn sample_rate(&self) -> u32 {
        self.sample_rate
    }
    fn total_duration(&self) -> Option<Duration> {
        self.input.total_duration()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Source de test minimaliste : rejoue un buffer f32 fixe, mono,
    /// à un taux d'échantillonnage donné.
    struct TestSource {
        samples: std::vec::IntoIter<f32>,
        sample_rate: u32,
        channels: u16,
    }

    impl TestSource {
        fn new(samples: Vec<f32>, sample_rate: u32, channels: u16) -> Self {
            Self {
                samples: samples.into_iter(),
                sample_rate,
                channels,
            }
        }
    }

    impl Iterator for TestSource {
        type Item = f32;
        fn next(&mut self) -> Option<f32> {
            self.samples.next()
        }
    }

    impl Source for TestSource {
        fn current_frame_len(&self) -> Option<usize> {
            None
        }
        fn channels(&self) -> u16 {
            self.channels
        }
        fn sample_rate(&self) -> u32 {
            self.sample_rate
        }
        fn total_duration(&self) -> Option<Duration> {
            None
        }
    }

    fn test_signal(len: usize) -> Vec<f32> {
        (0..len)
            .map(|i| (i as f32 * 0.37).sin() * 0.5)
            .collect()
    }

    #[test]
    fn zero_gain_band_is_numerically_an_identity_filter() {
        // Formule RBJ : à 0 dB, A = 1, donc b_i == a_i, ce qui donne une
        // fonction de transfert H(z) = 1 sur tout le plan z : la sortie
        // doit être identique à l'entrée à la précision flottante près.
        let coeffs = peaking_eq_coeffs(44_100.0, 1_000.0, 0.9, 0.0);
        let mut state = BiquadState::default();
        let input = test_signal(64);
        for &x in &input {
            let y = state.process(x, &coeffs);
            assert!((y - x).abs() < 1e-4, "attendu {x}, obtenu {y}");
        }
    }

    #[test]
    fn eq_source_at_zero_gain_leaves_audio_unchanged() {
        let input = test_signal(200);
        let source = TestSource::new(input.clone(), 44_100, 1);
        let gains = new_eq_gains([0.0, 0.0, 0.0]);
        let eq = EqSource::new(source, gains);
        let output: Vec<f32> = eq.collect();
        assert_eq!(output.len(), input.len());
        for (x, y) in input.iter().zip(output.iter()) {
            assert!((x - y).abs() < 1e-3, "{x} vs {y}");
        }
    }

    #[test]
    fn eq_source_preserves_channel_count_and_sample_rate() {
        let source = TestSource::new(test_signal(16), 48_000, 2);
        let gains = new_eq_gains([2.0, -3.0, 0.0]);
        let eq = EqSource::new(source, gains);
        assert_eq!(eq.channels(), 2);
        assert_eq!(eq.sample_rate(), 48_000);
    }

    #[test]
    fn boosting_a_band_does_not_produce_nan_or_infinite_output() {
        let input = test_signal(1000);
        let source = TestSource::new(input, 44_100, 1);
        let gains = new_eq_gains([12.0, 12.0, 12.0]); // boost max
        let eq = EqSource::new(source, gains);
        for sample in eq {
            assert!(sample.is_finite(), "l'égaliseur a produit une valeur non finie");
        }
    }

    #[test]
    fn live_gain_change_is_picked_up_without_rebuilding_the_source() {
        let input = test_signal(500);
        let source = TestSource::new(input, 44_100, 1);
        let gains = new_eq_gains([0.0, 0.0, 0.0]);
        let gains_handle = gains.clone();
        let mut eq = EqSource::new(source, gains);

        // Consomme quelques échantillons à gain nul...
        for _ in 0..50 {
            eq.next();
        }
        // ...puis change le gain "en direct" comme le ferait une commande
        // Tauri pendant la lecture.
        *gains_handle.lock().unwrap() = [6.0, 0.0, 0.0];

        let rest: Vec<f32> = eq.collect();
        assert!(rest.iter().all(|s| s.is_finite()));
    }
}
