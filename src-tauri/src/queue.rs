//! Gestion de la file d'attente de lecture : ordre, position courante,
//! lecture aléatoire (shuffle) et modes de répétition.
//!
//! Ce module est volontairement indépendant de tout ce qui touche à
//! l'audio réel (rodio) : c'est de la logique pure sur des identifiants
//! de pistes (String), ce qui la rend triviale à tester unitairement.

use rand::seq::SliceRandom;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RepeatMode {
    Off,
    One,
    All,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Queue {
    /// Ordre d'origine (celui dans lequel les pistes ont été ajoutées / la
    /// playlist a été chargée). Sert de base quand on désactive le shuffle.
    original: Vec<String>,
    /// Ordre de lecture effectif (== `original` tant que le shuffle est
    /// désactivé).
    playback: Vec<String>,
    /// Index courant dans `playback`, `None` si rien n'est en cours.
    position: Option<usize>,
    shuffle: bool,
    repeat: RepeatMode,
}

impl Default for Queue {
    fn default() -> Self {
        Self::new()
    }
}

impl Queue {
    pub fn new() -> Self {
        Self {
            original: Vec::new(),
            playback: Vec::new(),
            position: None,
            shuffle: false,
            repeat: RepeatMode::Off,
        }
    }

    pub fn len(&self) -> usize {
        self.playback.len()
    }

    pub fn is_empty(&self) -> bool {
        self.playback.is_empty()
    }

    pub fn playback_order(&self) -> &[String] {
        &self.playback
    }

    pub fn position(&self) -> Option<usize> {
        self.position
    }

    pub fn repeat(&self) -> RepeatMode {
        self.repeat
    }

    pub fn shuffle_enabled(&self) -> bool {
        self.shuffle
    }

    pub fn current(&self) -> Option<&String> {
        self.position.and_then(|p| self.playback.get(p))
    }

    /// Remplace entièrement la file (ex : l'utilisateur lance la lecture
    /// d'un album ou d'une playlist). `start_id`, si fourni, place la
    /// position de départ sur cette piste plutôt que sur la première.
    pub fn set_items(&mut self, ids: Vec<String>, start_id: Option<&str>) {
        self.original = ids.clone();
        self.playback = ids;
        if self.shuffle {
            self.reshuffle_keeping(start_id);
        }
        self.position = if self.playback.is_empty() {
            None
        } else if let Some(id) = start_id {
            self.playback.iter().position(|x| x == id).or(Some(0))
        } else {
            Some(0)
        };
    }

    pub fn clear(&mut self) {
        self.original.clear();
        self.playback.clear();
        self.position = None;
    }

    pub fn add(&mut self, id: String) {
        self.original.push(id.clone());
        self.playback.push(id);
        if self.position.is_none() {
            self.position = Some(self.playback.len() - 1);
        }
    }

    /// Retire la piste à l'index `index` de l'ordre de lecture courant.
    /// Retourne l'identifiant retiré, `None` si l'index est invalide.
    pub fn remove_at(&mut self, index: usize) -> Option<String> {
        if index >= self.playback.len() {
            return None;
        }
        let id = self.playback.remove(index);
        if let Some(pos) = self.original.iter().position(|x| *x == id) {
            self.original.remove(pos);
        }
        self.position = match self.position {
            None => None,
            Some(_) if self.playback.is_empty() => None,
            Some(p) if index < p => Some(p - 1),
            Some(p) if index == p => {
                // La piste retirée était celle en cours : reste sur le même
                // index (donc la piste suivante), sauf si on était à la fin.
                if p >= self.playback.len() {
                    Some(self.playback.len() - 1)
                } else {
                    Some(p)
                }
            }
            Some(p) => Some(p),
        };
        Some(id)
    }

    /// Avance à la piste suivante selon le mode de répétition.
    /// `None` signifie "fin de file, rien à jouer" (mode `Off`, dernière piste).
    ///
    /// Nommée `next`/`previous` à dessein (vocabulaire naturel d'un lecteur
    /// de musique) plutôt que pour coller à `Iterator` — `Queue` n'est pas
    /// un itérateur au sens Rust (on peut revenir en arrière, sauter à un
    /// id, etc.), d'où le `#[allow]` ci-dessous.
    #[allow(clippy::should_implement_trait)]
    pub fn next(&mut self) -> Option<&String> {
        if self.playback.is_empty() {
            self.position = None;
            return None;
        }
        match self.repeat {
            RepeatMode::One => {
                if self.position.is_none() {
                    self.position = Some(0);
                }
            }
            RepeatMode::Off | RepeatMode::All => {
                let next_pos = match self.position {
                    None => 0,
                    Some(p) if p + 1 < self.playback.len() => p + 1,
                    Some(_) if self.repeat == RepeatMode::All => 0,
                    Some(_) => {
                        self.position = None;
                        return None;
                    }
                };
                self.position = Some(next_pos);
            }
        }
        self.current()
    }

    /// Revient à la piste précédente. À la première piste : boucle en fin
    /// de file si `repeat == All`, sinon reste sur la première (au frontend
    /// de décider de plutôt "rembobiner" la piste en cours dans ce cas).
    pub fn previous(&mut self) -> Option<&String> {
        if self.playback.is_empty() {
            self.position = None;
            return None;
        }
        let prev_pos = match self.position {
            None => 0,
            Some(0) if self.repeat == RepeatMode::All => self.playback.len() - 1,
            Some(0) => 0,
            Some(p) => p - 1,
        };
        self.position = Some(prev_pos);
        self.current()
    }

    pub fn set_repeat(&mut self, mode: RepeatMode) {
        self.repeat = mode;
    }

    pub fn set_shuffle(&mut self, on: bool) {
        if on == self.shuffle {
            return;
        }
        self.shuffle = on;
        let current_id = self.current().cloned();
        if on {
            self.reshuffle_keeping(current_id.as_deref());
        } else {
            self.playback = self.original.clone();
        }
        self.position = match current_id {
            Some(id) => self.playback.iter().position(|x| *x == id),
            None => None,
        };
    }

    /// Régénère `playback` à partir de `original`, en plaçant `keep_id`
    /// (la piste en cours, si elle existe) en tête pour ne pas interrompre
    /// la lecture au moment où le shuffle est activé.
    fn reshuffle_keeping(&mut self, keep_id: Option<&str>) {
        let mut rng = rand::thread_rng();
        let mut rest: Vec<String> = self
            .original
            .iter()
            .filter(|id| Some(id.as_str()) != keep_id)
            .cloned()
            .collect();
        rest.shuffle(&mut rng);
        self.playback = match keep_id {
            Some(id) if self.original.iter().any(|x| x == id) => {
                let mut v = vec![id.to_string()];
                v.extend(rest);
                v
            }
            _ => rest,
        };
    }

    /// Déplace la position courante directement sur une piste donnée
    /// (par exemple double-clic sur une piste déjà présente dans la file).
    pub fn jump_to(&mut self, id: &str) -> bool {
        if let Some(pos) = self.playback.iter().position(|x| x == id) {
            self.position = Some(pos);
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn set_items_starts_at_first_track() {
        let mut q = Queue::new();
        q.set_items(ids(&["a", "b", "c"]), None);
        assert_eq!(q.current(), Some(&"a".to_string()));
        assert_eq!(q.position(), Some(0));
    }

    #[test]
    fn set_items_can_start_on_a_specific_track() {
        let mut q = Queue::new();
        q.set_items(ids(&["a", "b", "c"]), Some("b"));
        assert_eq!(q.current(), Some(&"b".to_string()));
    }

    #[test]
    fn next_advances_and_stops_at_end_when_repeat_off() {
        let mut q = Queue::new();
        q.set_items(ids(&["a", "b"]), None);
        assert_eq!(q.next(), Some(&"b".to_string()));
        assert_eq!(q.next(), None); // fin de file
        assert_eq!(q.current(), None);
    }

    #[test]
    fn next_wraps_around_when_repeat_all() {
        let mut q = Queue::new();
        q.set_items(ids(&["a", "b"]), None);
        q.set_repeat(RepeatMode::All);
        q.next(); // b
        assert_eq!(q.next(), Some(&"a".to_string()));
    }

    #[test]
    fn next_stays_on_same_track_when_repeat_one() {
        let mut q = Queue::new();
        q.set_items(ids(&["a", "b"]), None);
        q.set_repeat(RepeatMode::One);
        assert_eq!(q.next(), Some(&"a".to_string()));
        assert_eq!(q.next(), Some(&"a".to_string()));
    }

    #[test]
    fn previous_goes_back_and_wraps_only_on_repeat_all() {
        let mut q = Queue::new();
        q.set_items(ids(&["a", "b", "c"]), Some("c"));
        assert_eq!(q.previous(), Some(&"b".to_string()));
        assert_eq!(q.previous(), Some(&"a".to_string()));
        // Sans repeat All, reste bloqué sur la première piste.
        assert_eq!(q.previous(), Some(&"a".to_string()));

        q.set_repeat(RepeatMode::All);
        assert_eq!(q.previous(), Some(&"c".to_string()));
    }

    #[test]
    fn remove_at_current_position_shifts_to_next_track() {
        let mut q = Queue::new();
        q.set_items(ids(&["a", "b", "c"]), Some("b"));
        let removed = q.remove_at(1);
        assert_eq!(removed, Some("b".to_string()));
        assert_eq!(q.current(), Some(&"c".to_string()));
    }

    #[test]
    fn remove_at_last_track_moves_position_back() {
        let mut q = Queue::new();
        q.set_items(ids(&["a", "b", "c"]), Some("c"));
        q.remove_at(2);
        assert_eq!(q.current(), Some(&"b".to_string()));
    }

    #[test]
    fn remove_before_current_shifts_position_left() {
        let mut q = Queue::new();
        q.set_items(ids(&["a", "b", "c"]), Some("c"));
        q.remove_at(0);
        assert_eq!(q.current(), Some(&"c".to_string()));
        assert_eq!(q.position(), Some(1));
    }

    #[test]
    fn shuffle_keeps_current_track_playing_and_contains_all_ids() {
        let mut q = Queue::new();
        let all = ids(&["a", "b", "c", "d", "e"]);
        q.set_items(all.clone(), Some("c"));
        q.set_shuffle(true);
        assert_eq!(q.current(), Some(&"c".to_string()));
        let mut shuffled = q.playback_order().to_vec();
        shuffled.sort();
        let mut expected = all.clone();
        expected.sort();
        assert_eq!(shuffled, expected);
    }

    #[test]
    fn disabling_shuffle_restores_original_order_and_position() {
        let mut q = Queue::new();
        q.set_items(ids(&["a", "b", "c"]), Some("a"));
        q.set_shuffle(true);
        q.next();
        let current = q.current().cloned();
        q.set_shuffle(false);
        assert_eq!(q.playback_order(), ["a", "b", "c"]);
        assert_eq!(q.current(), current.as_ref());
    }

    #[test]
    fn jump_to_moves_position_without_changing_order() {
        let mut q = Queue::new();
        q.set_items(ids(&["a", "b", "c"]), None);
        assert!(q.jump_to("c"));
        assert_eq!(q.current(), Some(&"c".to_string()));
        assert!(!q.jump_to("z"));
    }

    #[test]
    fn empty_queue_next_and_previous_return_none() {
        let mut q = Queue::new();
        assert_eq!(q.next(), None);
        assert_eq!(q.previous(), None);
    }
}
