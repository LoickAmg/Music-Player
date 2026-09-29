//! Vérifie le moteur audio réel (périphérique de sortie compris) à volume nul.
use music_player_lib::{audio::AudioHandle, eq::new_eq_gains};
use std::time::Duration;

fn main() {
    let path = std::env::args().nth(1).expect("fichier");
    let audio = AudioHandle::spawn(new_eq_gains([0.0; 3]));
    let t = std::time::Instant::now();
    let result = audio.play(&path, 0.0);
    println!("play → {result:?} en {:.2} s", t.elapsed().as_secs_f64());
    std::thread::sleep(Duration::from_millis(1500));
    println!("position après 1,5 s : {:.2} s", audio.status().position_secs);
    audio.seek(Duration::from_secs(60));
    std::thread::sleep(Duration::from_millis(700));
    println!("position après saut à 60 s : {:.2} s", audio.status().position_secs);
    println!("erreur : {:?}", audio.status().device_error);
}
