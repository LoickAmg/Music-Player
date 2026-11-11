//! Correspondance pure entre un morceau demandé et un résultat de recherche.
//!
//! Le score combine le titre, l'artiste et, quand elle est connue, la durée. Les mentions
//! « feat. », les mots de présentation des vidéos (« clip officiel », « remastered »…), le nom de
//! l'artiste répété dans le titre et l'année ajoutée sont ignorés. Une autre version (remix,
//! slowed, sped up, live, acoustique, instrumentale, karaoké) n'est jamais acceptée d'office.

use std::collections::HashSet;

/// Informations utiles pour comparer deux morceaux.
#[derive(Clone, Copy, Debug)]
pub struct TrackInfo<'a> {
    pub title: &'a str,
    pub artist: &'a str,
    pub duration_secs: Option<f64>,
}

/// Détail du score calculé. Les scores vont de `0.0` à `1.0`.
#[derive(Clone, Debug, PartialEq)]
pub struct MatchScore {
    pub total: f64,
    pub title_similarity: f64,
    pub artist_similarity: f64,
    pub duration_delta_secs: Option<f64>,
    pub version_mismatch: bool,
    pub accepted: bool,
}

/// Versions d'un même morceau qu'on ne confond pas avec l'originale.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct VersionFlags {
    remix: bool,
    slowed: bool,
    sped: bool,
    live: bool,
    acoustic: bool,
    instrumental: bool,
    karaoke: bool,
}

/// Mots de présentation des vidéos, sans rapport avec le morceau.
const NOISE: &[&str] = &[
    "official", "officiel", "officielle", "video", "clip", "audio", "lyrics", "lyric", "paroles", "hd", "hq", "4k",
    "music", "musique", "visualizer", "visualiser", "remastered", "remaster", "version", "topic",
];

/// Tolérance sur la durée : jusqu'à 3 s sans pénalité, refus au-delà de 12 s.
const DURATION_FREE: f64 = 3.0;
const DURATION_MAX: f64 = 12.0;

/// Compare un morceau demandé à un résultat candidat.
///
/// Une durée demandée doit être vérifiable sur le candidat.
pub fn score_match(wanted: TrackInfo<'_>, candidate: TrackInfo<'_>) -> MatchScore {
    let wanted_words = words(wanted.title);
    let candidate_words = words(candidate.title);
    let wanted_artist = tokens(&words(wanted.artist));
    let wanted_title = tokens(&wanted_words);

    // Le titre du candidat, débarrassé de ce qui n'est pas le titre : l'artiste répété
    // (« Damso - Bruxelles vie ») et une année ajoutée (« Remastered 2011 »).
    let candidate_title: HashSet<String> = tokens(&candidate_words)
        .into_iter()
        .filter(|w| wanted_title.contains(w) || !(wanted_artist.contains(w) || is_year(w)))
        .collect();

    let title_similarity = token_similarity(&wanted_title, &candidate_title);
    let artist_similarity = token_similarity(&wanted_artist, &tokens(&words(candidate.artist)));

    let wanted_duration = valid_duration(wanted.duration_secs);
    let duration_delta_secs = wanted_duration
        .zip(valid_duration(candidate.duration_secs))
        .map(|(expected, actual)| (expected - actual).abs());

    let duration_similarity = match duration_delta_secs {
        Some(delta) if delta <= DURATION_FREE => 1.0,
        Some(delta) if delta <= DURATION_MAX => 1.0 - ((delta - DURATION_FREE) / (DURATION_MAX - DURATION_FREE)),
        Some(_) => 0.0,
        None if wanted_duration.is_none() => 0.75,
        None => 0.0,
    };

    let version_mismatch = version_flags(&wanted_words) != version_flags(&candidate_words);
    let total = if wanted_duration.is_some() {
        title_similarity * 0.56 + artist_similarity * 0.32 + duration_similarity * 0.12
    } else {
        title_similarity * 0.64 + artist_similarity * 0.36
    };

    let duration_is_acceptable = match (wanted_duration, duration_delta_secs) {
        (Some(_), Some(delta)) => delta <= DURATION_MAX,
        (Some(_), None) => false,
        (None, _) => true,
    };

    let accepted = !wanted_title.is_empty()
        && !candidate_title.is_empty()
        && title_similarity >= 0.68
        && artist_similarity >= 0.50
        && total >= 0.68
        && duration_is_acceptable
        && !version_mismatch;

    MatchScore { total, title_similarity, artist_similarity, duration_delta_secs, version_mismatch, accepted }
}

fn valid_duration(duration: Option<f64>) -> Option<f64> {
    duration.filter(|value| value.is_finite() && *value > 0.0)
}

fn token_similarity(left: &HashSet<String>, right: &HashSet<String>) -> f64 {
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let shared = left.intersection(right).count() as f64;
    let largest = left.len().max(right.len()) as f64;
    shared / largest
}

/// Mots d'un texte, dans l'ordre, sous la forme comparable du projet (minuscules, sans accents
/// ni ponctuation ; « Don't » et « Dont » se valent), jusqu'à la mention « feat. ».
fn words(text: &str) -> Vec<String> {
    crate::lyrics::normalize(text)
        .split_whitespace()
        .take_while(|w| !matches!(*w, "feat" | "ft" | "featuring"))
        .map(str::to_owned)
        .collect()
}

/// Les mots qui comptent pour comparer (sans les mots de présentation des vidéos). Les chaînes
/// officielles collent « VEVO » au nom (« DamsoVEVO ») : retiré, il reste l'artiste.
fn tokens(words: &[String]) -> HashSet<String> {
    words
        .iter()
        .filter(|w| !NOISE.contains(&w.as_str()) && w.as_str() != "vevo")
        .map(|w| match w.strip_suffix("vevo") {
            Some(name) if !name.is_empty() => name.to_owned(),
            _ => w.clone(),
        })
        .collect()
}

fn is_year(word: &str) -> bool {
    word.len() == 4 && word.parse::<u16>().is_ok_and(|y| (1900..=2099).contains(&y))
}

/// Version d'après des mots ou des paires de mots (« sped up » ; « slow » seul ne compte pas :
/// « Slow Dancing in the Dark » est un titre, pas une version ralentie).
fn version_flags(words: &[String]) -> VersionFlags {
    let has = |w: &str| words.iter().any(|x| x == w);
    let pair = |a: &str, b: &str| words.windows(2).any(|p| p[0] == a && p[1] == b);
    VersionFlags {
        remix: has("remix") || has("remixed") || has("rework") || has("bootleg"),
        slowed: has("slowed") || has("reverb") || has("nightcore") || pair("slow", "reverb"),
        sped: has("sped") || pair("speed", "up"),
        live: has("live") || pair("en", "concert"),
        acoustic: has("acoustic") || has("acoustique") || has("unplugged"),
        instrumental: has("instrumental") || has("instru"),
        karaoke: has("karaoke"),
    }
}

#[cfg(test)]
mod tests {
    use super::{score_match, TrackInfo};

    fn info<'a>(title: &'a str, artist: &'a str, duration_secs: Option<f64>) -> TrackInfo<'a> {
        TrackInfo { title, artist, duration_secs }
    }

    #[test]
    fn normalise_les_accents_et_les_mentions_feat() {
        let score = score_match(
            info("Papaoutai", "Stromae", Some(232.0)),
            info("Papaoutai (feat. Another Artist) [Official Audio]", "Stromae", Some(233.0)),
        );
        assert!(score.accepted);
        assert_eq!(score.title_similarity, 1.0);
        assert_eq!(score.artist_similarity, 1.0);
    }

    #[test]
    fn accepte_une_difference_de_duree_dans_la_tolerance() {
        let score = score_match(info("Beyoncé", "Beyoncé", Some(200.0)), info("Beyonce", "Beyonce", Some(205.0)));
        assert!(score.accepted);
        assert_eq!(score.duration_delta_secs, Some(5.0));
    }

    #[test]
    fn refuse_un_artiste_different() {
        let score = score_match(info("Royals", "Lorde", Some(190.0)), info("Royals", "Adele", Some(190.0)));
        assert!(!score.accepted);
        assert_eq!(score.artist_similarity, 0.0);
    }

    #[test]
    fn refuse_un_ecart_de_duree_trop_grand() {
        let score = score_match(info("Song", "Artist", Some(180.0)), info("Song", "Artist", Some(205.0)));
        assert!(!score.accepted);
        assert_eq!(score.duration_delta_secs, Some(25.0));
    }

    #[test]
    fn refuse_un_remix_si_la_version_demandee_est_originale() {
        let score = score_match(info("Song", "Artist", Some(180.0)), info("Song Remix", "Artist", Some(180.0)));
        assert!(score.version_mismatch);
        assert!(!score.accepted);
    }

    #[test]
    fn permet_la_comparaison_sans_duree_attendue() {
        let score = score_match(info("Formidable", "Stromae", None), info("Formidable", "Stromae", Some(215.0)));
        assert!(score.accepted);
        assert_eq!(score.duration_delta_secs, None);
    }

    #[test]
    fn une_duree_attendue_invalide_compte_comme_inconnue() {
        let score = score_match(info("Song", "Artist", Some(f64::NAN)), info("Song", "Artist", Some(180.0)));
        assert!(score.accepted);
        assert_eq!(score.duration_delta_secs, None);
    }

    // Titres tels qu'on les trouve sur YouTube.

    #[test]
    fn accepte_un_titre_de_video_avec_l_artiste_et_clip_officiel() {
        let score = score_match(
            info("Bruxelles vie", "Damso", Some(200.0)),
            info("Damso - Bruxelles vie (Clip officiel)", "Damso", Some(201.0)),
        );
        assert!(score.accepted, "{score:?}");
    }

    #[test]
    fn accepte_une_version_remasterisee_avec_son_annee() {
        let score = score_match(info("Song", "Artist", Some(180.0)), info("Song (Remastered 2011)", "Artist", Some(181.0)));
        assert!(score.accepted, "{score:?}");
    }

    #[test]
    fn garde_une_annee_qui_fait_partie_du_titre() {
        let score = score_match(info("1999", "Prince", Some(379.0)), info("1999 (2019 Remaster)", "Prince", Some(380.0)));
        assert!(score.accepted, "{score:?}");
        assert!(!score_match(info("1999", "Prince", Some(379.0)), info("Purple Rain", "Prince", Some(380.0))).accepted);
    }

    #[test]
    fn accepte_une_chaine_topic_et_une_apostrophe_retiree() {
        assert!(score_match(info("Formidable", "Stromae", Some(213.0)), info("Formidable", "Stromae - Topic", Some(213.0))).accepted);
        let s = score_match(info("Don't Stop Me Now", "Queen", Some(209.0)), info("Dont Stop Me Now", "Queen", Some(209.0)));
        assert_eq!(s.title_similarity, 1.0);
    }

    #[test]
    fn reconnait_l_artiste_derriere_une_chaine_officielle() {
        // Avec yt-dlp, l'« artiste » lu dans le fichier est souvent la chaîne YouTube.
        let wanted = info("Bruxelles vie", "Damso", Some(200.0));
        assert!(score_match(wanted, info("Damso - Bruxelles vie (Clip officiel)", "DamsoVEVO", Some(201.0))).accepted);
        assert!(score_match(wanted, info("Bruxelles vie", "Damso VEVO", Some(200.0))).accepted);
        assert!(score_match(wanted, info("Bruxelles vie", "Damso - Topic", Some(200.0))).accepted);
    }

    #[test]
    fn refuse_les_autres_versions() {
        let wanted = info("Royals", "Lorde", Some(190.0));
        for title in ["Royals (Live)", "Royals (sped up)", "Royals (Acoustic)", "Royals (Instrumental)", "Royals (Karaoke)"] {
            let score = score_match(wanted, info(title, "Lorde", Some(190.0)));
            assert!(score.version_mismatch && !score.accepted, "{title} : {score:?}");
        }
    }

    #[test]
    fn slow_dans_le_titre_n_est_pas_une_version_ralentie() {
        let wanted = info("Slow Dancing in the Dark", "Joji", Some(209.0));
        assert!(score_match(wanted, info("Slow Dancing in the Dark", "Joji", Some(209.0))).accepted);
        assert!(!score_match(wanted, info("Slow Dancing in the Dark (slowed + reverb)", "Joji", Some(209.0))).accepted);
    }

    #[test]
    fn la_version_demandee_peut_etre_un_remix() {
        let score = score_match(info("Song (Remix)", "Artist", Some(200.0)), info("Artist - Song Remix", "Artist", Some(201.0)));
        assert!(score.accepted, "{score:?}");
    }
}
