# Relais de partage

Petit service qui permet à deux appareils éloignés (pas sur le même Wi-Fi) de s'échanger un
morceau ou une playlist avec un code du type `4821-soleil-guitare`.

- Il met en relation les deux appareils qui ont le même numéro de salle (`4821`) et passe les
  messages de l'un à l'autre.
- Il ne voit que des données chiffrées de bout en bout : la clé vient des mots du code
  (`soleil-guitare`), qui ne lui sont jamais envoyés (échange de clé SPAKE2 entre les deux
  appareils).
- Il n'enregistre rien. Une salle se ferme au bout de 15 minutes.

## Mise en ligne (une fois)

Avec un compte Cloudflare (offre gratuite suffisante) :

```bash
cd relay
npx wrangler login
npx wrangler deploy
```

`wrangler deploy` affiche l'adresse du relais, par exemple
`https://music-player-relais.<votre-sous-domaine>.workers.dev`. Elle se règle :

- pour tout le monde : variable `MP_RELAY_URL` au moment de construire l'application
  (CI : secret ou variable du dépôt du même nom) ;
- sur un appareil : Réglages → Partage → « Relais pour le partage à distance ».

## Essai en local

```bash
cd relay
npx wrangler dev
```

Le relais répond alors sur `http://localhost:8787`.
