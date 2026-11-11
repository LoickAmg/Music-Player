# Prompt pour ChatGPT — moteur de téléchargement de Music Player

> Mode d'emploi (version gratuite) : colle d'abord le **bloc 1** seul. ChatGPT répond par un plan
> court et attend. Ensuite, pour chaque étape, écris simplement « Étape N » : il livre **un seul
> fichier** par réponse. Si une réponse est coupée, écris « Continue exactement où tu t'es arrêté ».
> Rapporte-moi chaque fichier : je le vérifie, je le teste et je le mets au propre avant tout commit.

---

## Bloc 1 — à coller tel quel

Tu es un développeur Rust senior. Tu vas écrire, par petites étapes, un module pour une appli de
bureau existante (Tauri 2, Rust 2021, frontend Vue 3 + TypeScript). Tu ne vois pas le dépôt : tout
ce dont tu as besoin est ci-dessous. N'invente aucune fonction du projet qui n'est pas listée.

### Objectif

Remplacer la boucle actuelle « spotDL un morceau à la fois » par un **moteur de téléchargement**
propre à l'appli, qui garde spotDL et yt-dlp comme **outils externes derrière des adaptateurs
remplaçables**. Pas de fork, pas de réécriture de la recherche YouTube. Usage personnel, sur PC
(Windows d'abord, puis Linux/macOS). Android : renvoyer proprement « non disponible ».

Le moteur doit apporter :
1. une **file persistante** (reprise après fermeture de l'appli ou plantage) ;
2. une **correspondance vérifiée** : titre, artiste, durée attendue (écart toléré) ;
3. des **essais limités** avec délai croissant, et des erreurs classées ;
4. une **progression détaillée** par morceau (événements vers l'interface) ;
5. un **import** du fichier téléchargé dans la bibliothèque, puis l'ajout à la playlist demandée.

### Ce qui existe déjà (à réutiliser, ne pas réécrire)

```rust
// src-tauri/src/bounded.rs — lance un programme avec délai maximal et arrêt (arbre de processus tué)
pub enum Bounded {
    Finished { status: std::process::ExitStatus, stdout: String, stderr: String },
    TimedOut { stdout: String, stderr: String },
    Cancelled { stdout: String, stderr: String },
}
pub fn run(command: &mut std::process::Command, limit: std::time::Duration, cancel: &std::sync::atomic::AtomicBool)
    -> std::io::Result<Bounded>;

// src-tauri/src/ffmpeg.rs — pas de fenêtre de console sous Windows
pub(crate) fn quiet(command: &mut std::process::Command) -> &mut std::process::Command;

// src-tauri/src/state.rs (extrait)
pub struct AppState {
    pub library: std::sync::Mutex<Vec<Track>>,
    pub library_root: std::sync::Mutex<Option<String>>,
    pub playlists: std::sync::Mutex<PlaylistStore>,
    pub data_dir: std::path::PathBuf, // dossier de données de l'appli (fichiers JSON)
    // ...
}
// Verrou : `state.library.locked()` (trait `Locked`, tolérant aux verrous empoisonnés).
// Règle du projet : ne jamais tenir deux verrous en même temps.

// src-tauri/src/commands.rs
pub fn run_scan(app: &tauri::AppHandle, root: &str) -> Result<Vec<Track>, String>; // rescanne et émet "library-updated"

// src-tauri/src/playlists.rs
impl PlaylistStore {
    pub fn add_tracks(&mut self, id: &str, track_ids: Vec<String>) -> Result<usize, PlaylistError>; // ignore les doublons
    pub fn save(&self, path: &std::path::Path) -> std::io::Result<()>;
}
// state.playlists_path() -> PathBuf

// src-tauri/src/library.rs
pub struct Track { pub id: String, pub path: String, pub title: String, pub artist: String,
                   pub album: String, pub duration_secs: f64, /* ... */ }
pub fn track_id_for_path(path: &std::path::Path) -> String;
```

Commande Tauri actuelle (à remplacer à terme, garder compatible pendant la transition) :
`spotdl_download_missing(queries: Vec<{title, artist}>) -> { items, imported, library }`,
événement `spotdl-progress { index, total, title, artist, status }`, commande `spotdl_cancel`.

### Architecture demandée

Nouveau dossier `src-tauri/src/fetch/` :
- `mod.rs` : types publics (`Wanted { title, artist, album, duration_secs: Option<f64>, playlist_id: Option<String> }`,
  `JobState`, `JobError` en enum avec `#[serde(rename_all = "snake_case")]`), et la façade.
- `source.rs` : `trait Source { fn name(&self) -> &'static str; fn available(&self) -> bool;
  fn fetch(&self, wanted: &Wanted, dest_dir: &Path, cancel: &AtomicBool) -> Result<PathBuf, JobError>; }`
- `spotdl.rs` et `ytdlp.rs` : les deux adaptateurs (spotDL d'abord ; yt-dlp en recherche
  `ytsearch1:` avec extraction audio).
- `queue.rs` : file persistante dans `data_dir/telechargements.json`, écriture atomique
  (fichier temporaire puis renommage), un seul travailleur à la fois.
- `matching.rs` : fonctions pures de score (normalisation sans accents, mots « feat », « remix »,
  « slowed », écart de durée) — **entièrement testées**.
- `import.rs` : ajout du fichier dans la bibliothèque et à la playlist.

### Règles de sécurité (obligatoires, je les vérifierai)

1. **Jamais de shell** : `std::process::Command` avec arguments séparés ; aucune chaîne
   construite pour `cmd /C`, `sh -c` ou `powershell`.
2. Tout texte venu de l'utilisateur ou de Spotify (titre, artiste) passe en **un seul argument**,
   précédé de `--` si l'outil l'accepte, et ne doit jamais pouvoir être pris pour une option
   (refuser ou préfixer s'il commence par `-`).
3. **Chemins confinés** : les fichiers ne sont écrits que dans le dossier de destination ; refuser
   `..`, les chemins absolus et les noms réservés Windows (CON, NUL, COM1…) ; nettoyer les noms.
4. **Aucun téléchargement ni installation d'outil** par l'appli (pas de `pip install`, pas de
   binaire récupéré sur Internet). Si un outil manque, renvoyer `JobError::ToolMissing` avec un
   message d'aide.
5. **Délais et arrêt** : chaque appel externe passe par `bounded::run` (6 min au plus) et le
   drapeau d'arrêt ; sous Windows, `quiet()` sur chaque `Command`.
6. **Limites** : 500 morceaux par lot, sorties de journal tronquées (12 000 caractères), fichier
   JSON de la file < 5 Mo.
7. **Pas de `unwrap()` / `expect()`** hors tests ; pas de `unsafe`.
8. **Mémoire** : pas de clone de toute la bibliothèque dans une boucle ; lire `library.locked()`
   le temps nécessaire, copier seulement ce qu'il faut ; ne jamais charger un fichier audio en
   mémoire (le moteur ne manipule que des chemins).
9. Messages d'erreur et commentaires **en français**, concis.

### Qualité attendue

- Compile sans avertissement avec `cargo clippy --all-targets -- -D warnings`.
- Tests unitaires pour `matching.rs`, `queue.rs` (persistance, reprise) et la validation des
  noms/chemins ; les adaptateurs sont testés avec un faux outil (programme de test qui imite la
  sortie), jamais avec un vrai téléchargement.
- Code lisible : fonctions courtes, pas d'abstraction inutile.

### Façon de travailler (important : je suis sur la version gratuite)

- **Réponds maintenant uniquement par un plan numéroté de 6 à 8 étapes**, une étape = un fichier,
  avec pour chacune une ligne de description. Puis **attends**.
- Ensuite, à chaque « Étape N », livre **un seul fichier complet**, sans répéter le plan ni les
  règles, suivi de 3 lignes au plus : ce qu'il fait, ce qui reste à brancher, comment le tester.
- Si quelque chose est ambigu, pose **une** question courte au lieu de deviner.
- Ne modifie pas les fichiers existants listés plus haut ; si un branchement est nécessaire
  (enregistrer une commande dans `lib.rs`, par exemple), décris-le en 2 lignes à la fin.

---

## Bloc 2 — si ChatGPT perd le fil (à recoller)

Rappel : moteur `src-tauri/src/fetch/` pour Music Player (Tauri 2, Rust). Adaptateurs spotDL et
yt-dlp derrière `trait Source`. Règles : pas de shell, arguments séparés, chemins confinés, aucun
téléchargement d'outil, `bounded::run` + `quiet()` pour chaque appel, pas d'`unwrap`, pas de
clone de la bibliothèque, tests pour matching, file et chemins. Un seul fichier par réponse.
Nous en sommes à l'étape N : continue.
