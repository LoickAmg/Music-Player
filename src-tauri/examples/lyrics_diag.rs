//! Diagnostic : durée du scan, puis recherche de paroles sur un échantillon de pistes.
//! Usage : cargo run --release --example lyrics_diag -- "C:\Users\...\Music" 20
use music_player_lib::{library, lyrics};

fn main() {
    let root = std::env::args().nth(1).expect("dossier");
    let sample: usize = std::env::args()
        .nth(2)
        .and_then(|n| n.parse().ok())
        .unwrap_or(15);
    let t = std::time::Instant::now();
    let tracks = library::scan_library(std::path::Path::new(&root));
    println!(
        "scan : {} pistes en {:.1} s",
        tracks.len(),
        t.elapsed().as_secs_f64()
    );
    let albums: std::collections::HashSet<_> = tracks
        .iter()
        .filter(|t| t.album != library::UNKNOWN_ALBUM)
        .map(|t| (t.album_artist.clone(), t.album.clone()))
        .collect();
    println!(
        "albums : {} ; pistes sans album : {}",
        albums.len(),
        tracks
            .iter()
            .filter(|t| t.album == library::UNKNOWN_ALBUM)
            .count()
    );
    println!(
        "avec pochette : {}",
        tracks.iter().filter(|t| t.has_cover).count()
    );

    let cache = std::env::temp_dir().join("mp-lyrics-diag");
    let step = (tracks.len() / sample).max(1);
    let (mut synced, mut plain, mut none) = (0, 0, 0);
    for track in tracks.iter().step_by(step).take(sample) {
        let (artist, title) = lyrics::search_terms(track);
        match lyrics::lyrics_for(track, &cache, true, false) {
            Ok(Some(l)) if l.synced.is_some() => {
                synced += 1;
                println!("  synchro  {} — {:?} / {title}", l.source, artist)
            }
            Ok(Some(l)) => {
                plain += 1;
                println!("  texte    {} — {:?} / {title}", l.source, artist)
            }
            Ok(None) => {
                none += 1;
                println!("  aucune   {:?} / {title}", artist)
            }
            Err(e) => {
                none += 1;
                println!("  erreur   {e}")
            }
        }
    }
    println!("paroles : {synced} synchronisées, {plain} texte seul, {none} introuvables");
}
