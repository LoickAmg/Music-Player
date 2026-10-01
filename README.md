# Music Player

Lecteur de musique léger et multiplateforme (Windows, macOS, Linux et Android) :
bibliothèque locale, playlists, file d'attente avec lecture aléatoire et
répétition, paroles synchronisées trouvées automatiquement, et un mini égaliseur
3 bandes appliqué en direct.

## Configuration requise

| Système | Minimum | Fichier à télécharger |
| --- | --- | --- |
| **Android** | Android 8.0 (API 26) ou plus, processeur ARM 64 bits (arm64-v8a) ou 32 bits (armeabi-v7a), **Android System WebView à jour** (version 111 ou plus, mise à jour par le Play Store ou la boutique du téléphone) | `Music-Player-android.apk` |
| **Windows** | Windows 10 ou 11, 64 bits (x64) ; WebView2, déjà présent sur Windows 10/11 | `Music.Player_x.y.z_x64-setup.exe` (ou `.msi`) |
| **macOS** | macOS 10.15 ou plus, **Mac Apple Silicon** (M1 et suivants) ; la CI ne produit pas encore de version pour Mac Intel | `Music.Player_x.y.z_aarch64.dmg` |
| **Linux** | x86_64 avec WebKitGTK 4.1 (Ubuntu 22.04, Debian 12, Fedora 38 ou plus récents) | `.deb`, `.rpm` ou `.AppImage` |

Recommandé partout : **2 Go de mémoire** ou plus, une centaine de Mo libres (application,
plus le cache des pochettes et des paroles, qui grandit avec la bibliothèque). Une connexion
internet n'est utile que pour trouver les paroles et les mises à jour.

**Large gamme d'appareils** : l'interface s'adapte de l'écran extérieur d'un pliable
(dès 280 px de large) aux tablettes et aux pliables ouverts (Galaxy Z Flip et Z Fold,
Huawei Mate X, Pixel Fold…).
- **Téléphones :** interface tactile en portrait, sans jamais passer sous la barre d'état,
  la barre de navigation ou l'encoche (dimensions transmises par Android).
- **Pliables :** pochette et paroles côte à côte quand l'appareil est ouvert ; paroles en
  haut et commandes sous la charnière quand il est à moitié plié.
- **Téléphones modestes :** un **affichage léger** automatique (Réglages → Affichage) leur
  épargne les effets coûteux.

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
`walkdir` (scan récursif), `tauri-plugin-dialog` (sélecteur de dossier), `ureq`
(paroles LRCLIB, versions GitHub), `tauri-plugin-updater` (mise à jour automatique sur
ordinateur).

Android : même application Tauri (Rust + Vue) compilée pour ARM, complétée par de petites
classes **Kotlin** générées par `scripts/android-patch.mjs` :
- service de lecture et notification (écran verrouillé) ;
- bouton retour ;
- dimensions des barres système ;
- orientation ;
- installation des mises à jour.

## Installer (Windows)

Téléchargez `Music Player_x.y.z_x64-setup.exe` depuis la page [Releases](https://github.com/LoickAmg/Music-Player/releases)
de ce dépôt, puis double-cliquez dessus : l'installation se fait pour votre compte (aucun droit
administrateur), avec un raccourci dans le menu Démarrer et sur le Bureau. Chaque tag `app-v*`
construit et publie automatiquement les installateurs Windows, macOS et Linux (voir `.github/workflows/ci.yml`).

## Android

Chaque version publiée (tag `app-v*`) contient aussi **`Music-Player-android.apk`**,
compilé par la CI pour les téléphones Android 8 et plus (arm64 et armv7 : Pixel 6 Pro,
Redmi 15C, Huawei Y8p…). Installation : télécharger l'APK sur le téléphone, l'ouvrir et
autoriser l'installation depuis cette source. Au premier lancement, l'application demande
l'accès aux fichiers audio, puis « Analyser la musique du téléphone » parcourt le stockage
partagé (Musique, Téléchargements…).

Sur un écran étroit, l'interface passe en mode mobile : onglets en bas, mini-lecteur,
écran « À l'écoute » plein écran avec pochette ou paroles.

Sur le téléphone :
- **commandes sur l'écran verrouillé** et dans le volet de notifications (précédent,
  lecture/pause, suivant, position), aussi pilotables par un casque Bluetooth : un service
  de lecture garde la musique active écran éteint, et les morceaux s'enchaînent côté Rust ;
- **bouton retour** : revient à la page précédente (ou ferme « À l'écoute ») ; depuis
  l'accueil, l'appli passe en arrière-plan sans couper la musique ;
- **mises à jour sans désinstaller** : les APK publiés sont toujours signés avec la même clé
  (secrets `ANDROID_KEYSTORE_B64` et `ANDROID_KEYSTORE_PASSWORD` du dépôt ; la CI refuse de
  publier une version sans eux) ;
- icône adaptative : l'image entière dans la zone visible, fond assorti ;
- l'écran reste allumé tant que les paroles défilent (lecture en cours) ;
- **affichage léger** pour les téléphones modestes (Réglages → Affichage : Automatique,
  Complet, Léger) : fond fixe aux couleurs de la pochette, ligne chantée surlignée en entier,
  horloge d'affichage à 10 images par seconde. « Automatique » le choisit selon la puce
  graphique (Mali-G51 du Huawei Y8p…), la mémoire, le nombre de cœurs, la préférence
  « animations réduites » du système, ou s'il constate des saccades pendant la lecture.
  Dans tous les modes, rien ne tourne en pause ni appli cachée, le défilement automatique des
  paroles est animé par le compositeur, et l'égaliseur neutre ne calcule rien ;
- écran des paroles façon Apple Music : petite pochette, titre et artiste en haut ;
- mise à jour depuis l'appli : la dernière version publiée est détectée au démarrage et
  proposée dans une fenêtre centrée ; « Mettre à jour » télécharge l'APK et ouvre
  l'installation d'Android (par-dessus) ;
- sortie audio rétablie toute seule quand le système la coupe (enregistrement d'écran qui
  capte le son, casque ou Bluetooth branché ou débranché…) : le moteur rouvre la sortie et
  reprend le morceau au même endroit, aussi quand la lecture cesse d'avancer sans prévenir.

## Mises à jour

- **Ordinateur** : à partir de la 0.4.3, l'application vérifie au démarrage si une nouvelle
  version est publiée sur GitHub et propose « Mettre à jour » (bandeau, ou Réglages →
  Mises à jour). L'installateur, dont la signature est vérifiée avec la clé publique de
  `tauri.conf.json`, s'installe puis l'application redémarre, sans perdre la bibliothèque ni
  les réglages. Les versions sont signées par la CI (secrets `TAURI_SIGNING_PRIVATE_KEY` et
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) ; sans eux, la CI refuse de publier.
- **Android** : à partir de la 0.4.4, l'application détecte la nouvelle version (liste des
  versions GitHub), télécharge l'APK et ouvre l'installation d'Android, par-dessus l'ancienne
  (même signature, voir plus haut). Android demande une fois d'autoriser l'installation
  d'applis depuis Music Player.

## Lancer l'application depuis les sources

Aucune commande à taper : après `npm run tauri build`, double-cliquez sur l'installateur
`src-tauri/target/release/bundle/nsis/Music Player_x.y.z_x64-setup.exe` (raccourci dans le
menu Démarrer), ou directement sur l'exécutable autonome `src-tauri/target/release/music-player.exe`
(l'interface est intégrée, WebView2 est déjà présent sur Windows 10/11).

## Interface

Direction artistique inspirée de **Persona 3 Reload** (bleu nuit profond, cyan électrique, titres
en capitales italiques condensées, sélection en barre blanche inclinée à ombre cyan, boutons en
parallélogramme, rais de lumière sur l'écran « À l'écoute »), ergonomie inspirée d'Apple Music : barre de navigation latérale (Ajouts récents, Artistes, Albums,
Morceaux, Playlists), barre de lecture façon « écran LCD » (pochette, titre, progression que
l'on peut faire glisser), grilles de pochettes, pages d'album et d'artiste, recherche
instantanée, menu contextuel (clic droit), écran « À l'écoute » plein écran avec la pochette
floutée et animée en fond, raccourcis clavier (Espace, Ctrl+←/→, ←/→, Ctrl+F, Ctrl+L).
Les listes sont virtualisées : des milliers de morceaux restent fluides.

## Paroles synchronisées

Panneau « Paroles » et écran « À l'écoute » : la ligne chantée se remplit au rythme de la
voix (effet karaoké), la vue suit la chanson ; on peut faire défiler librement au doigt ou à
la molette (le suivi reprend seul après quelques secondes, ou avec « Reprendre »), et un
clic sur une ligne saute à ce passage. Rien à télécharger : les paroles sont cherchées dès
le début du morceau (et celles du suivant préparées en avance). Sources, dans l'ordre :

1. un fichier `.lrc` du même nom posé à côté du morceau ;
2. les paroles intégrées aux étiquettes du fichier (ID3 USLT, Vorbis `LYRICS`, MP4 `©lyr`) ;
3. automatiquement (désactivable dans les Réglages), [LRCLIB](https://lrclib.net), base libre
   et sans clé : seuls titre, artiste, album et durée sont envoyés. Les titres « de vidéo »
   (« (Lyrics) », « [Official Video] », « Artiste - Titre »…) sont nettoyés, puis plusieurs
   recherches sont tentées, de la plus précise à la plus large (sans invités « feat. », sans
   mention « Remastered », artiste principal seul) ; le meilleur résultat est retenu selon le
   titre, l'artiste, la durée et la présence d'horodatages. Quand l'artiste est connu, il doit
   correspondre : un titre courant (« Sans toi ») existe chez des dizaines d'artistes, et mieux
   vaut « paroles introuvables » que celles d'une autre chanson (bouton « Chercher à nouveau »).
   Les réponses sont mises en cache (`lyrics/` dans le dossier de l'application).

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
  src/updater.rs       Mise à jour automatique (ordinateur)
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
