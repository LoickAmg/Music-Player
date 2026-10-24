# Design system de Music Player

Référence des jetons et des composants de l'interface. Les jetons vivent dans
`src/style.css` (`:root`) ; les thèmes de la personnalisation (`src/lib/themes.ts`) en
redéfinissent une partie (couleurs, polices, style des boutons). Un nouveau composant
utilise ces jetons plutôt que des valeurs écrites en dur.

## Couleurs

| Jeton | Rôle |
| --- | --- |
| `--bg`, `--bg-content`, `--bg-sidebar`, `--bg-elevated` | Fonds : fenêtre, contenu, barre latérale, fenêtres flottantes |
| `--bg-hover`, `--bg-active` | Survol, élément actif ou sélectionné |
| `--text`, `--text-2`, `--text-3` | Texte principal, secondaire, discret |
| `--separator` | Filets entre lignes |
| `--accent`, `--accent-soft`, `--on-accent` | Couleur d'accent (thème), sa version translucide, texte posé dessus |
| `--danger`, `--danger-text`, `--danger-soft`, `--danger-strong` | Erreur, action destructrice (icône, texte, fond léger, bouton plein) |
| `--success`, `--success-soft` | Réussite (partage reçu, copie gardée) |
| `--warning` | Avertissement |
| `--fg-rgb`, `--surface-rgb`, `--bar-rgb` | Canaux RVB pour les voiles : `rgba(var(--fg-rgb), 0.08)` |

« À l'écoute » a son propre fond, tiré de la pochette et toujours sombre : `--amb-base`,
`--amb-primary`, `--amb-secondary`, `--amb-glow` et `--amb-energy` (0 à 1), calculés par
`stores/ambience.ts`. Les visuels de cet écran (vinyle, CD, visualiseur, barre de
progression) s'y teintent.

## Forme, espace, profondeur

- Rayons : `--radius-sm` (6 px, puces, badges), `--radius` (10 px, cartes, menus),
  `--radius-lg` (14 px, grandes cartes), `--radius-pill` (pilules, puces de filtre).
- Espacements sur une grille de 4 px : `--space-1` (4) à `--space-6` (32).
- Ombres : `--shadow` (menus, fenêtres), `--shadow-lg` (pochette, objets 3D).

## Mouvement

- `--ease` pour tout ce qui entre ou se déplace ; `--dur-fast` (0,15 s, survols, boutons),
  `--dur` (0,3 s, panneaux), `--dur-slow` (0,6 s, pochette, transitions d'écran).
- Les objets « physiques » (vinyle, boîtier de CD) sont animés image par image avec élan et
  ressort, jamais par une durée fixe : démarrage et arrêt progressifs du disque, retour en
  douceur du boîtier lâché.
- `prefers-reduced-motion` : plus de rotation continue ni de flottement ; les états restent
  lisibles (bras du vinyle posé, couvercle ouvert).
- Mode léger (`:root[data-perf="lite"]`) : pas de flou ni de reflets coûteux.

## Composants partagés

| Composant | Usage |
| --- | --- |
| `.pill` + `.pill-accent` / `.pill-ghost` / `.pill-danger` | Boutons texte : action principale, secondaire, destructrice confirmée |
| `.icon-btn` (+ `.on`) | Bouton icône 32 px, état actif |
| `.toggle` | Case à cocher avec libellé (réglages) |
| `Icon.vue` | Icônes au trait (24 × 24), épaisseur réglable dans la personnalisation |
| `Artwork.vue` | Pochette d'un morceau, repli coloré d'après le nom |
| `SeekBar.vue` | Barre de progression : `hero` (« À l'écoute ») ou `lcd` (barre du haut) ; curseur et heure au survol, bulle pendant le glisser, flèches ±5 s |
| `VinylArt.vue` | Pochette en vinyle : disque à 33 tours, étiquette = pochette, bras qui se pose, rotation au doigt |
| `CdCase.vue` | Boîtier de CD en 3D : clic pour ouvrir, glisser pour tourner, motif du disque choisi par points |
| `Visualizer.vue` | Spectre du son joué : barres (`bars`) ou couronne (`ring`), couleur `--viz-color` |
| `FriendAvatar.vue` | Photo d'un proche ou initiales, anneau d'accent quand il écoute |
| `VirtualList.vue`, `VirtualGrid.vue` | Longues listes et grilles (seules les lignes visibles sont dessinées) |

## Règles d'écriture

- Libellés en français, phrases courtes, verbes d'action sur les boutons (« Retirer les
  copies en trop », pas « OK »).
- Une action destructrice demande une confirmation en place (le bouton devient « Oui,
  retirer 2 copies ») plutôt qu'une boîte de dialogue.
- Les nombres et durées utilisent `font-variant-numeric: tabular-nums`.
