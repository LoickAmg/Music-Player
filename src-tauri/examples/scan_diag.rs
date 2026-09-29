//! Diagnostic : scanne un dossier comme l'application et teste le décodage de chaque piste.
//! Usage : cargo run --release --example scan_diag -- "C:\Users\...\Music"
use music_player_lib::{audio, library};
use std::collections::BTreeMap;

fn main() {
    let root = std::env::args().nth(1).expect("dossier");
    let tracks = library::scan_library(std::path::Path::new(&root));
    let unknown_artist = tracks.iter().filter(|t| t.artist == "Artiste inconnu").count();
    println!("pistes détectées : {} (dont {} sans artiste)", tracks.len(), unknown_artist);
    let mut per_ext: BTreeMap<String, (usize, Vec<String>)> = BTreeMap::new();
    for t in &tracks {
        let ext = std::path::Path::new(&t.path).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
        let slot = per_ext.entry(ext).or_default();
        match audio::open_decoder(&t.path) {
            Ok(mut d) => {
                if d.by_ref().take(4096).count() > 0 { slot.0 += 1 } else { slot.1.push(format!("vide : {}", t.path)) }
            }
            Err(e) => slot.1.push(format!("{e} : {}", t.path)),
        }
    }
    for (ext, (ok, errors)) in per_ext {
        println!("{ext}: {ok} lisibles, {} en échec", errors.len());
        for e in errors.iter().take(3) {
            println!("   {e}");
        }
    }
}
