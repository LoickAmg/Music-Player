<script setup lang="ts">
// Icônes vectorielles maison (aucune police d'icônes externe), dessinées sur une grille 24×24.
const props = withDefaults(defineProps<{ name: string; size?: number }>(), { size: 18 });

const PATHS: Record<string, string> = {
  play: "M8 5.2v13.6c0 .8.9 1.3 1.6.8l10.4-6.8a1 1 0 0 0 0-1.6L9.6 4.4C8.9 3.9 8 4.4 8 5.2Z",
  pause: "M7 4.5h3.2v15H7zM13.8 4.5H17v15h-3.2z",
  next: "M4.5 6.2v11.6c0 .7.8 1.1 1.4.7l8.1-5.8a.9.9 0 0 0 0-1.4L5.9 5.5c-.6-.4-1.4 0-1.4.7ZM16.5 5h2.5v14h-2.5z",
  prev: "M19.5 6.2v11.6c0 .7-.8 1.1-1.4.7L10 12.7a.9.9 0 0 1 0-1.4l8.1-5.8c.6-.4 1.4 0 1.4.7ZM5 5h2.5v14H5z",
  shuffle:
    "M16 4.5 19.5 8 16 11.5M4.5 8h3.3c2 0 3.3 1 4.4 2.6l1.6 2.8c1.1 1.6 2.4 2.6 4.4 2.6h1.3M16 12.5l3.5 3.5-3.5 3.5M4.5 16h3.3c1 0 1.8-.2 2.5-.7M13.7 8.7c.7-.5 1.5-.7 2.5-.7h3.3",
  repeat: "M17 3.5 20.5 7 17 10.5M20.5 7H8a4 4 0 0 0-4 4v1M7 20.5 3.5 17 7 13.5M3.5 17H16a4 4 0 0 0 4-4v-1",
  volume: "M4 9.5h3.5L12 5.5v13l-4.5-4H4zM15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.8 7.8 0 0 1 0 11",
  mute: "M4 9.5h3.5L12 5.5v13l-4.5-4H4zM16 9.5l5 5M21 9.5l-5 5",
  lyrics: "M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 17H11l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5ZM8 9.5h8M8 12.8h5",
  queue: "M4 6.5h11M4 11.5h11M4 16.5h7M17.5 14v6.5M17.5 20.5a2 2 0 1 1-2-2 2 2 0 0 1 2 2ZM17.5 14l3 1",
  search: "M10.5 17a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13ZM15.3 15.3 20 20",
  note: "M9 18.5V6.2l10-2v11.3M9 18.5a2.5 2.5 0 1 1-2.5-2.5A2.5 2.5 0 0 1 9 18.5ZM19 15.5a2.5 2.5 0 1 1-2.5-2.5 2.5 2.5 0 0 1 2.5 2.5ZM9 9.5l10-2",
  album: "M12 20.5a8.5 8.5 0 1 1 0-17 8.5 8.5 0 0 1 0 17ZM12 14a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z",
  artist: "M14.5 6.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0ZM4.5 20c.6-3.6 3.3-6 6.5-6s5.9 2.4 6.5 6M17 8.5l3.5-3.5",
  songs: "M9 17.5V5l9-1.5v11M9 17.5a2.3 2.3 0 1 1-2.3-2.3A2.3 2.3 0 0 1 9 17.5ZM18 14.5a2.3 2.3 0 1 1-2.3-2.3 2.3 2.3 0 0 1 2.3 2.3Z",
  clock: "M12 20.5a8.5 8.5 0 1 1 0-17 8.5 8.5 0 0 1 0 17ZM12 7.5V12l3 2",
  settings:
    "M12 15a3 3 0 1 1 0-6 3 3 0 0 1 0 6ZM19.4 13.5a7.7 7.7 0 0 0 0-3l2-1.5-2-3.4-2.4 1a7.6 7.6 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.6A7.6 7.6 0 0 0 7 6.6l-2.4-1-2 3.4 2 1.5a7.7 7.7 0 0 0 0 3l-2 1.5 2 3.4 2.4-1a7.6 7.6 0 0 0 2.6 1.5l.4 2.6h4l.4-2.6a7.6 7.6 0 0 0 2.6-1.5l2.4 1 2-3.4Z",
  plus: "M12 5v14M5 12h14",
  back: "M15 5.5 8.5 12l6.5 6.5",
  more: "M6 12h.01M12 12h.01M18 12h.01",
  close: "M6 6l12 12M18 6 6 18",
  playlist: "M4 6.5h12M4 11h12M4 15.5h7M15 19.5v-6.2l5-1v4.6M15 19.5a1.8 1.8 0 1 1-1.8-1.8 1.8 1.8 0 0 1 1.8 1.8ZM20 17a1.8 1.8 0 1 1-1.8-1.8A1.8 1.8 0 0 1 20 17Z",
  expand: "M14.5 4.5h5v5M9.5 19.5h-5v-5M19.5 4.5 13.5 10.5M4.5 19.5l6-6",
  collapse: "M9.5 4.5v5h-5M14.5 19.5v-5h5M4.5 4.5l5 5M19.5 19.5l-5-5",
  folder: "M3.5 7a1.5 1.5 0 0 1 1.5-1.5h4.2l2 2.2H19A1.5 1.5 0 0 1 20.5 9.2v8.3A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5Z",
  refresh: "M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4",
  trash: "M5 7h14M10 7V5h4v2M7 7l1 12.5h8L17 7",
  eq: "M6 4v16M12 4v16M18 4v16M4 14h4M10 8h4M16 12h4",
};

const FILLED = new Set(["play", "pause", "next", "prev"]);
</script>

<template>
  <svg
    :width="props.size"
    :height="props.size"
    viewBox="0 0 24 24"
    aria-hidden="true"
    :fill="FILLED.has(props.name) ? 'currentColor' : 'none'"
    :stroke="FILLED.has(props.name) ? 'none' : 'currentColor'"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path :d="PATHS[props.name] ?? ''" />
  </svg>
</template>
