//! Ordinateur : pas de mise en veille automatique pendant la lecture. Windows ne compte pas
//! le son comme une activité ; sans ce signal, le PC s'endormait au bout du délai
//! d'inactivité et la musique s'arrêtait. L'écran peut toujours s'éteindre, et une mise en
//! veille demandée (bouton, capot fermé) reste possible.

/// Signal « système requis » tenu tant que la lecture continue. À appeler toujours depuis
/// le même fil (Windows attache ce signal au fil qui le pose).
#[derive(Default)]
pub struct KeepAwake {
    on: bool,
}

impl KeepAwake {
    pub fn set(&mut self, playing: bool) {
        if playing == self.on {
            return;
        }
        self.on = playing;
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED};
            SetThreadExecutionState(if playing { ES_CONTINUOUS | ES_SYSTEM_REQUIRED } else { ES_CONTINUOUS });
        }
    }
}
