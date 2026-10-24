# Relais de partage

Petit service qui permet à deux appareils éloignés (pas sur le même Wi-Fi) de s'échanger un
morceau ou une playlist avec un code du type `4821-soleil-guitare`.

- Il met en relation les deux appareils qui ont le même numéro de salle (`4821`) et passe les
  messages de l'un à l'autre.
- Il ne voit que des données chiffrées de bout en bout : la clé vient des mots du code
  (`soleil-guitare`), qui ne lui sont jamais envoyés (échange de clé SPAKE2 entre les deux
  appareils).
- Il n'enregistre rien. Une salle se ferme au bout de 15 minutes.

## Proches

Le même relais sert aux Proches (voir ce qu'écoutent ses amis) :

- chaque appareil qui active les Proches reçoit un code d'ami (`K7QM-2D9X`) et un secret
  qui reste sur l'appareil ;
- on s'ajoute par ce code (ou depuis les appareils du même Wi-Fi) ; l'ajout n'aboutit que si
  l'autre accepte, et chacun donne à l'autre un jeton qui lui permet de lire son statut ;
- le relais garde par profil : nom, petite photo, morceau en cours (effacé au bout de
  6 heures), demandes en attente, jetons des amis autorisés (empreintes seulement) ;
- annuaire de ville, sur option : nom et code des profils qui ont choisi d'y être visibles,
  d'après l'adresse IP vue par Cloudflare ; une annonce s'efface au bout de 10 minutes.

## Mise en ligne (une fois)

Avec un compte Cloudflare (offre gratuite suffisante) :

```bash
cd relay
npx wrangler login
npx wrangler deploy
```

`wrangler deploy` affiche l'adresse du relais. Après une mise à jour du relais (nouvelle
version de `src/index.js`), relancer `npx wrangler deploy`. Celle du projet,
`https://music-player-relais.loickamg.workers.dev`, est intégrée à l'application
(`PROJECT_RELAY` dans `src-tauri/src/remote.rs`). Un autre relais se règle :

- pour tout le monde : variable `MP_RELAY_URL` au moment de construire l'application
  (CI : variable du dépôt du même nom) ;
- sur un appareil : Réglages → Partage → « Relais pour le partage à distance ».

## Essai en local

```bash
cd relay
npx wrangler dev
```

Le relais répond alors sur `http://localhost:8787`.
