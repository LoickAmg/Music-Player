# Music Player

Lecteur de musique de bureau, léger et multiplateforme (Windows/macOS/Linux) :
bibliothèque locale, playlists, file d'attente avec lecture aléatoire et
répétition, et un mini égaliseur 3 bandes appliqué en direct.

## Stack

Backend **Rust** (le vrai moteur de l'app : lecture audio, scan de
bibliothèque, égaliseur, persistance) encapsulé dans **Tauri v2**, frontend
**Vue 3** (Composition API) + **Pinia** + **Vite** en **TypeScript**, sans
framework CSS (thème sombre écrit à la main).

C'est le premier projet de la roadmap qui n'est ni du Laravel/PHP ni du
Node — Rust/Tauri était la stack recommandée dès le départ, et contrairement
aux projets précédents (Task Manager, Expense Tracker), **aucun pivot n'a
été nécessaire** : Rust, Cargo et toutes les libs système Tauri
(`webkit2gtk`, `gtk3`, `alsa`...) sont disponibles dans l'environnement de
build.

Bibliothèques Rust clés : `rodio` (lecture audio, décodage via
`symphonia` — mp3/flac/ogg/wav/m4a/aac), `lofty` (métadonnées + pochettes),
`walkdir` (scan récursif), `tauri-plugin-dialog` (sélecteur de dossier).

## Lancer l'application

Aucune commande à taper : après `npm run tauri build`, double-cliquez sur l'installateur
`src-tauri/target/release/bundle/nsis/Music Player_x.y.z_x64-setup.exe` (raccourci dans le
menu Démarrer), ou directement sur l'exécutable autonome `src-tauri/target/release/music-player.exe`
(l'interface est intégrée, WebView2 est déjà présent sur Windows 10/11).

## Interface

Inspirée d'Apple Music : barre de navigation latérale (Ajouts récents, Artistes, Albums,
Morceaux, Playlists), barre de lecture façon « écran LCD » (pochette, titre, progression que
l'on peut faire glisser), grilles de pochettes, pages d'album et d'artiste, recherche
instantanée, menu contextuel (clic droit), écran « À l'écoute » plein écran avec la pochette
floutée et animée en fond, raccourcis clavier (Espace, Ctrl+←/→, ←/→, Ctrl+F, Ctrl+L).
Les listes sont virtualisées : des milliers de morceaux restent fluides.

## Paroles synchronisées

Panneau « Paroles » et écran « À l'écoute » : la ligne chantée s'allume, la vue défile toute
seule, un clic sur une ligne saute à ce passage. Sources, dans l'ordre :

1. un fichier `.lrc` du même nom posé à côté du morceau ;
2. les paroles intégrées aux étiquettes du fichier (ID3 USLT, Vorbis `LYRICS`, MP4 `©lyr`) ;
3. sur autorisation explicite (demandée une fois), [LRCLIB](https://lrclib.net), base libre et
   sans clé : seuls titre, artiste, album et durée sont envoyés, les titres « de vidéo »
   (« (Lyrics) », « [Official Video] », « Artiste - Titre »…) sont nettoyés avant la recherche,
   et les réponses sont mises en cache (`lyrics/` dans le dossier de l'application).

## Fonctionnalités

- **Bibliothèque locale** : scan **parallèle** d'un dossier (≈ 5 000 fichiers en 3,5 s),
  métadonnées tolérantes aux étiquettes abîmées (un fichier audio n'est jamais écarté),
  pochettes embarquées **ou** `cover.jpg`/`folder.jpg` du dossier, **cache** : la
  bibliothèque s'affiche instantanément au lancement puis se met à jour en arrière-plan
- **Presque tous les formats audio** : MP3, FLAC, OGG, WAV, AAC, M4A/ALAC, AIFF, MKA, WebM
  lus directement ; **Opus, WMA, AC3 / E-AC3 (Dolby), APE, WavPack, DSD, MPC…** lus via
  [ffmpeg](https://ffmpeg.org) s'il est installé (Windows : `winget install ffmpeg`). Sans
  ffmpeg, ces fichiers restent listés et un message explique quoi installer.
- **Lecture** : lecture/pause, piste suivante/précédente, recherche dans la
  piste (seek), volume, **lecture aléatoire** et **3 modes de répétition**
  (off/piste/liste)
- **File d'attente** consultable et modifiable (retirer une piste, sauter à
  une piste précise)
- **Playlists** persistées : créer/renommer/supprimer, ajouter/retirer des
  pistes
- **Égaliseur 3 bandes** (basses/médiums/aigus, ±12 dB), réglable en direct
  pendant la lecture (filtres peaking biquad, sans librairie de DSP externe)
- **Session persistée** : dossier de bibliothèque, file d'attente, piste et
  position, volume, réglages d'égaliseur — tout est restauré au lancement
  suivant

## Architecture audio (pourquoi un thread dédié)

`cpal`/`rodio` maintiennent un flux de sortie qui contient un pointeur brut
non-`Send` sur certaines plateformes : il ne peut donc pas vivre directement
dans l'état géré par Tauri (`State<T>` exige `Send + Sync`). Tout ce qui
touche à rodio tourne donc sur un unique thread audio dédié
(`src-tauri/src/audio.rs`), piloté par messages (`AudioCommand`) depuis les
commandes Tauri ; seul un statut (`AudioStatus`, protégé par un `Mutex`) est
partagé avec le reste de l'app. Si aucun périphérique audio n'est détecté
(ex : machine sans carte son), l'app démarre quand même — les commandes de
lecture renvoient une erreur lisible plutôt que de faire planter
l'application.

## Structure du repo

```
src-tauri/            Backend Rust
  src/queue.rs         File d'attente : ordre, shuffle, répétition (logique pure, testée)
  src/library.rs       Scan parallèle, métadonnées (lofty), cache, pochettes
  src/lyrics.rs        Paroles : .lrc, étiquettes, LRCLIB (+ cache)
  src/playlists.rs     Playlists persistées en JSON
  src/session.rs       Sauvegarde/restauration de session
  src/eq.rs            Égaliseur 3 bandes (filtres biquad + Source rodio maison)
  src/audio.rs         Thread audio dédié (rodio), piloté par messages
  src/commands.rs       Commandes Tauri (IPC) : coordonne les modules ci-dessus
  src/state.rs          État applicatif partagé
src/                  Frontend Vue 3 (Vite + TypeScript)
  stores/               Pinia (library, player, playlists, eq)
  components/           Sidebar, TrackTable, NowPlayingBar, QueueDrawer, EqualizerPanel...
  lib/tauriMock.ts       Mock de l'IPC Tauri, chargé UNIQUEMENT en `vite dev` hors webview
                         (sert à faire de la QA visuelle dans un navigateur classique)
tests/                 Tests frontend (vitest + @vue/test-utils)
```

## Développement en local

Prérequis : Node 20+, Rust stable (`rustup`), et sur Linux les libs système
Tauri :

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev libasound2-dev build-essential curl wget file libssl-dev libsoup-3.0-dev
```

(sur Windows/macOS, voir la [doc officielle Tauri](https://tauri.app/start/prerequisites/) —
rien de spécifique à ce projet.)

```bash
npm install
npm run tauri dev     # lance l'app desktop (backend Rust + frontend Vite)
```

### Mode démo dans un navigateur

> ⚠️ Dans ce mode, **rien ne joue et l'ajout de dossier ne fait rien** : les pistes sont
> fictives. Une bannière l'indique. Pour un vrai lecteur, lancez `npm run tauri dev`.

`npm run dev` (sans `tauri`) lance juste le frontend Vite dans un
navigateur classique, avec l'IPC Tauri simulé (bibliothèque de démo, lecture
simulée sans son réel) — pratique pour itérer vite sur l'UI sans recompiler
Rust à chaque changement. Ce mock (`src/lib/tauriMock.ts`) est éliminé du
bundle de production (tree-shaké via `import.meta.env.DEV`).

## Tests et lint

```bash
npm run lint                          # eslint (frontend)
cd src-tauri && cargo clippy --all-targets -- -D warnings   # lint Rust

npm test                              # 23 tests frontend (vitest)
cd src-tauri && cargo test            # 33 tests backend (queue, bibliothèque,
                                       # playlists, session, égaliseur)
```

La logique testée automatiquement est volontairement celle qui ne dépend
d'aucun périphérique réel (file d'attente, calcul des filtres de
l'égaliseur, persistance JSON, extraction de métadonnées sur des fichiers
WAV générés à la volée). La lecture audio elle-même et l'interface ont été
vérifiées manuellement : build de production, lancement du binaire compilé
sous un display virtuel (aucun crash, dégradation propre sans carte son), et
QA visuelle de chaque écran via le mode démo navigateur (Playwright).

## Build et distribution

```bash
npm run tauri build    # installeur pour la plateforme courante uniquement
```

Sur cet environnement de build (Linux), ça produit un `.deb`, un `.rpm` et
un `.AppImage` dans `src-tauri/target/release/bundle/`.

**Pour obtenir les installeurs Windows (.msi/.exe) et macOS (.dmg) :** il
n'existe pas de toolchain de cross-compilation fiable depuis Linux pour
Tauri (il faudrait un vrai MSVC / SDK macOS). La CI GitHub Actions s'en
charge à ta place, sur de vraies machines Windows/macOS/Linux fournies par
GitHub :

```bash
git tag app-v0.1.0
git push origin app-v0.1.0
```

Si le tag existe déjà (`app-v0.1.0`), supprimez-le puis recréez-le après avoir poussé le correctif du
workflow : `git tag -d app-v0.1.0 && git push origin :refs/tags/app-v0.1.0`, puis les deux
commandes ci-dessus. Le job `release` a besoin de `permissions: contents: write` (ajouté) : sans cela
la construction réussit mais la création de la Release échoue avec « Resource not accessible by integration ».

Ce tag déclenche le job `release` du workflow (`.github/workflows/ci.yml`),
qui construit les 3 installeurs et crée une **Release GitHub en brouillon**
avec les fichiers attachés — il ne reste qu'à la publier depuis l'onglet
*Releases* du repo.

## Licence

MIT — voir [LICENSE](./LICENSE).

## Identité visuelle

Typographie **Outfit** auto-hébergée via `@fontsource` (aucun Google Fonts, aucun
appel réseau) pour l’ensemble de l’interface — géométrique et technique, en
cohérence avec le logiciel « console audio » ; pile de repli système.

Couleurs déclarées comme variables CSS dans `src/style.css` (`--bg`, `--border`,
`--text`, `--accent`, `--accent-contrast`, `--accent-soft`, `--danger`, etc.) —
aucun code hex ou `rgba` en dur dans les composants. Pas de motif décoratif de
fond (« dot grid ») ni dégradé en orbe.

## Pages légales et erreurs

Application de bureau Tauri (fenêtre unique, sans routage web) : les informations
légales sont accessibles depuis la barre de pied de page via une boîte de dialogue
`src/components/LegalDialog.vue` regroupant trois onglets : **Mentions légales**,
**Confidentialité (RGPD)** et **Contact**.

Les champs `[À compléter]` (éditeur, adresse, directeur de publication, responsable
de traitement) et l’adresse `contact@exemple.fr` sont à personnaliser avant la
distribution.
