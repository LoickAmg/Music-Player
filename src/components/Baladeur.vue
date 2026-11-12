<script setup lang="ts">
// Mode baladeur (téléphone seulement) : tout l'écran devient un lecteur de poche, avec son
// écran encastré, sa molette tactile et son verrou. Direction artistique propre à l'appli,
// mêlant plusieurs familles de lecteurs (molette, écran monochrome, boutons en caoutchouc).
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Artwork from "@/components/Artwork.vue";
import Icon from "@/components/Icon.vue";
import { angleDelta, clock, initialOf, moveSelection, pointAngle, wheelSteps, wheelZone, windowTop, type WheelZone } from "@/lib/baladeur";
import { useNow } from "@/lib/clock";
import { activeItemIndex, buildItems, progress } from "@/lib/lyricsTiming";
import type { Track } from "@/lib/types";
import { useBaladeurStore } from "@/stores/baladeur";
import { useFavoritesStore } from "@/stores/favorites";
import { useLibraryStore } from "@/stores/library";
import { useLyricsStore } from "@/stores/lyrics";
import { usePlayerStore } from "@/stores/player";
import { usePlaylistsStore } from "@/stores/playlists";

const baladeur = useBaladeurStore();
const player = usePlayerStore();
const library = useLibraryStore();
const playlists = usePlaylistsStore();
const favorites = useFavoritesStore();
const lyricsStore = useLyricsStore();
const now = useNow();

/** Lignes visibles dans une liste. */
const ROWS = 6;

interface Row {
  label: string;
  sub?: string;
  /** Mène à un autre écran (chevron). */
  more?: boolean;
  /** Valeur d'un réglage, à droite. */
  value?: string;
  run: () => void;
}
interface ListScreen {
  kind: "list";
  title: string;
  rows: () => Row[];
  selected: number;
  top: number;
  /** Liste alphabétique : initiale affichée en grand pendant un défilement rapide. */
  alpha?: boolean;
}
type Screen = ListScreen | { kind: "now" } | { kind: "lyrics" };

// ——— Bibliothèque, triée une fois ———
const collator = new Intl.Collator("fr", { sensitivity: "base", numeric: true });
const songs = computed(() => [...library.tracks].sort((a, b) => collator.compare(a.title, b.title)));
const artists = computed(() => [...library.artists].sort((a, b) => collator.compare(a.name, b.name)));
const albums = computed(() => [...library.albums].sort((a, b) => collator.compare(a.title, b.title)));

function trackRows(list: () => Track[]): Row[] {
  const tracks = list();
  const ids = tracks.map((t) => t.id);
  const rows: Row[] = tracks.map((t) => ({
    label: t.title,
    sub: t.artist,
    run: () => {
      void player.playQueue(ids, t.id);
      open({ kind: "now" });
    },
  }));
  if (tracks.length > 1) {
    rows.unshift({
      label: "Lecture aléatoire",
      sub: `${tracks.length} morceaux`,
      run: () => {
        void player.playShuffled(ids);
        open({ kind: "now" });
      },
    });
  }
  return rows;
}

function listScreen(title: string, rows: () => Row[], alpha = false): ListScreen {
  return { kind: "list", title, rows, selected: 0, top: 0, alpha };
}

const musicScreen = () =>
  listScreen("Musique", () => [
    {
      label: "Playlists",
      more: true,
      run: () =>
        open(
          listScreen("Playlists", () =>
            playlists.items.map((p) => ({
              label: p.name,
              sub: `${p.track_ids.length} morceau${p.track_ids.length > 1 ? "x" : ""}`,
              more: true,
              run: () => open(listScreen(p.name, () => trackRows(() => p.track_ids.map((id) => library.byId(id)).filter((t): t is Track => !!t)))),
            })),
          ),
        ),
    },
    {
      label: "Artistes",
      more: true,
      run: () =>
        open(
          listScreen(
            "Artistes",
            () =>
              artists.value.map((artist) => ({
                label: artist.name,
                more: true,
                run: () =>
                  open(
                    listScreen(artist.name, () => [
                      { label: "Tous les morceaux", sub: `${artist.tracks.length}`, more: true, run: () => open(listScreen(artist.name, () => trackRows(() => artist.tracks))) },
                      ...artist.albums.map((album) => ({
                        label: album.title,
                        sub: album.year ? String(album.year) : undefined,
                        more: true,
                        run: () => open(listScreen(album.title, () => trackRows(() => album.tracks))),
                      })),
                    ]),
                  ),
              })),
            true,
          ),
        ),
    },
    {
      label: "Albums",
      more: true,
      run: () =>
        open(
          listScreen(
            "Albums",
            () =>
              albums.value.map((album) => ({
                label: album.title,
                sub: album.artist,
                more: true,
                run: () => open(listScreen(album.title, () => trackRows(() => album.tracks))),
              })),
            true,
          ),
        ),
    },
    { label: "Morceaux", more: true, run: () => open(listScreen("Morceaux", () => trackRows(() => songs.value), true)) },
    {
      label: "Titres aimés",
      more: true,
      run: () => open(listScreen("Titres aimés", () => trackRows(() => library.tracks.filter((t) => favorites.isFavorite(t.id))))),
    },
  ]);

const yesNo = (on: boolean) => (on ? "Oui" : "Non");
const settingsScreen = () =>
  listScreen("Réglages", () => [
    { label: "Finition", value: baladeur.skin.name, run: () => baladeur.nextSkin() },
    { label: "Clic de la molette", value: yesNo(baladeur.clicks === "1"), run: () => (baladeur.clicks = baladeur.clicks === "1" ? "0" : "1") },
    { label: "Vibration", value: yesNo(baladeur.haptics === "1"), run: () => (baladeur.haptics = baladeur.haptics === "1" ? "0" : "1") },
    { label: "Rétroéclairage", value: baladeur.backlight === "0" ? "Toujours" : `${baladeur.backlight} s`, run: () => baladeur.nextBacklight() },
    { label: "Aléatoire", value: yesNo(player.shuffle), run: () => void player.setShuffle(!player.shuffle) },
    { label: "Répétition", value: player.repeat === "off" ? "Non" : player.repeat === "all" ? "Tout" : "Un", run: () => void player.cycleRepeat() },
  ]);

const rootScreen = (): ListScreen =>
  listScreen("Music Player", () => {
    const rows: Row[] = [{ label: "Musique", more: true, run: () => open(musicScreen()) }];
    if (player.currentTrack) {
      rows.push({ label: "En lecture", more: true, run: () => open({ kind: "now" }) });
      rows.push({ label: "Paroles", more: true, run: () => open({ kind: "lyrics" }) });
    }
    rows.push(
      {
        label: "Tout mélanger",
        run: () => {
          if (!library.tracks.length) return;
          void player.playShuffled(library.tracks.map((t) => t.id));
          open({ kind: "now" });
        },
      },
      { label: "Réglages", more: true, run: () => open(settingsScreen()) },
      { label: "Quitter le baladeur", run: () => (baladeur.enabled = false) },
    );
    return rows;
  });

// ——— Pile des écrans ———
const stack = ref<Screen[]>([rootScreen()]);
const screen = computed(() => stack.value[stack.value.length - 1]);
const list = computed(() => (screen.value.kind === "list" ? screen.value : null));
const rows = computed(() => list.value?.rows() ?? []);
const visible = computed(() => (list.value ? rows.value.slice(list.value.top, list.value.top + ROWS) : []));
/** Sens de la dernière transition (glissement de l'écran). */
const direction = ref<"in" | "out">("in");

function open(next: Screen) {
  direction.value = "in";
  stack.value = [...stack.value, next];
}

function back() {
  if (stack.value.length <= 1) return;
  direction.value = "out";
  stack.value = stack.value.slice(0, -1);
}

const title = computed(() => (screen.value.kind === "list" ? screen.value.title : screen.value.kind === "now" ? "En lecture" : "Paroles"));

// ——— Lecture en cours ———
const track = computed(() => player.currentTrack);
const position = computed(() => player.positionAt(now.value));
const duration = computed(() => track.value?.duration_secs ?? 0);
const queueLabel = computed(() =>
  player.queuePosition !== null && player.queueIds.length ? `${player.queuePosition + 1} sur ${player.queueIds.length}` : "",
);
const volumeShown = ref(false);
let volumeTimer: ReturnType<typeof setTimeout> | undefined;
let volumeTarget = player.volume;
let volumeSend: ReturnType<typeof setTimeout> | undefined;

function nudgeVolume(steps: number) {
  volumeTarget = Math.min(1, Math.max(0, volumeTarget + steps * 0.03));
  player.volume = volumeTarget;
  volumeShown.value = true;
  clearTimeout(volumeTimer);
  volumeTimer = setTimeout(() => (volumeShown.value = false), 1400);
  clearTimeout(volumeSend);
  volumeSend = setTimeout(() => void player.setVolume(volumeTarget), 120);
}

// ——— Paroles adaptées au petit écran ———
const synced = computed(() => lyricsStore.lyrics?.synced ?? null);
const items = computed(() => (synced.value ? buildItems(synced.value, duration.value * 1000).filter((i) => i.kind === "line") : []));
const plainLines = computed(() => (synced.value ? [] : (lyricsStore.lyrics?.plain ?? "").split("\n").map((l) => l.trim()).filter(Boolean)));
const positionMs = computed(() => position.value * 1000 + 150 + lyricsStore.offsetMs);
const activeLine = computed(() => Math.max(0, activeItemIndex(items.value, positionMs.value)));
/** Ligne choisie à la molette (le suivi reprend tout seul après quelques secondes). */
const manualLine = ref<number | null>(null);
let manualTimer: ReturnType<typeof setTimeout> | undefined;
const shownLine = computed(() => manualLine.value ?? (items.value.length ? activeLine.value : 0));
const lyricLines = computed(() => {
  const source = items.value.length ? items.value.map((i) => i.text) : plainLines.value;
  const center = shownLine.value;
  return [-1, 0, 1, 2].map((offset) => ({ index: center + offset, text: source[center + offset] ?? "" }));
});
const fill = computed(() => {
  if (manualLine.value !== null || !items.value.length) return 1;
  const item = items.value[activeLine.value];
  return item ? progress(item.start, item.end, positionMs.value) : 0;
});
const lyricsState = computed(() => {
  if (lyricsStore.loading && !lyricsStore.lyrics) return "Recherche des paroles…";
  if (lyricsStore.lyrics?.instrumental) return "♪ Instrumental ♪";
  if (!items.value.length && !plainLines.value.length) return "Pas de paroles pour ce morceau.";
  return "";
});

function scrollLyrics(steps: number) {
  const count = items.value.length || plainLines.value.length;
  if (!count) return;
  manualLine.value = moveSelection(shownLine.value, steps, count);
  clearTimeout(manualTimer);
  if (items.value.length) manualTimer = setTimeout(() => (manualLine.value = null), 4000);
}

watch(track, () => (manualLine.value = null));

// ——— Molette ———
const wheel = ref<HTMLElement | null>(null);
const pressed = ref<WheelZone | null>(null);
const bigInitial = ref("");
let initialTimer: ReturnType<typeof setTimeout> | undefined;
let gesture: { zone: WheelZone; x: number; y: number; angle: number; rest: number; at: number; rotating: boolean; long: boolean } | null = null;
let longTimer: ReturnType<typeof setTimeout> | undefined;
let seekTimer: ReturnType<typeof setInterval> | undefined;

function geometry(event: PointerEvent) {
  const box = wheel.value?.getBoundingClientRect();
  if (!box) return null;
  const dx = event.clientX - (box.left + box.width / 2);
  const dy = event.clientY - (box.top + box.height / 2);
  return { dx, dy, radius: box.width / 2 };
}

function onWheelDown(event: PointerEvent) {
  if (locked.value) return flashLock();
  if (wake()) return;
  const g = geometry(event);
  if (!g) return;
  const zone = wheelZone(g.dx, g.dy, g.radius);
  if (!zone) return;
  try {
    wheel.value?.setPointerCapture(event.pointerId);
  } catch {
    // capture refusée (pointeur déjà relâché) : les mouvements restent suivis sur la molette
  }
  gesture = { zone, x: event.clientX, y: event.clientY, angle: pointAngle(g.dx, g.dy), rest: 0, at: performance.now(), rotating: false, long: false };
  pressed.value = zone;
  if (zone === "prev" || zone === "next") {
    longTimer = setTimeout(() => {
      if (!gesture || gesture.rotating) return;
      gesture.long = true;
      const step = zone === "next" ? 5 : -5;
      void player.skip(step);
      seekTimer = setInterval(() => void player.skip(step), 300);
    }, 550);
  }
}

function onWheelMove(event: PointerEvent) {
  if (!gesture) return;
  const g = geometry(event);
  if (!g) return;
  const moved = Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y);
  if (!gesture.rotating && moved > 10 && gesture.zone !== "center") {
    gesture.rotating = true;
    pressed.value = null;
    clearTimeout(longTimer);
  }
  if (!gesture.rotating) return;
  const angle = pointAngle(g.dx, g.dy);
  const t = performance.now();
  const { steps, rest } = wheelSteps(gesture.rest, angleDelta(gesture.angle, angle), t - gesture.at);
  gesture.angle = angle;
  gesture.rest = rest;
  gesture.at = t;
  if (steps) scroll(steps);
}

function onWheelUp() {
  clearTimeout(longTimer);
  clearInterval(seekTimer);
  const done = gesture;
  gesture = null;
  pressed.value = null;
  if (!done || done.rotating || done.long) return;
  press(done.zone);
}

function scroll(steps: number) {
  touched();
  const current = screen.value;
  if (current.kind === "list") {
    const count = rows.value.length;
    const next = moveSelection(current.selected, steps, count);
    if (next === current.selected) return;
    current.selected = next;
    current.top = windowTop(current.top, next, ROWS, count);
    tick();
    if (current.alpha && Math.abs(steps) > 1) {
      bigInitial.value = initialOf(rows.value[next]?.label ?? "");
      clearTimeout(initialTimer);
      initialTimer = setTimeout(() => (bigInitial.value = ""), 700);
    }
  } else if (current.kind === "now") {
    nudgeVolume(steps);
    tick();
  } else {
    scrollLyrics(steps);
    tick();
  }
}

function press(zone: WheelZone) {
  touched();
  tick(true);
  if (zone === "menu") return back();
  if (zone === "play") return void player.togglePlayPause();
  if (zone === "next") return void player.next();
  if (zone === "prev") return void player.previous();
  const current = screen.value;
  if (current.kind === "list") rows.value[current.selected]?.run();
  else if (current.kind === "now") open({ kind: "lyrics" });
  else if (manualLine.value !== null && items.value[manualLine.value]) {
    void player.seek(Math.max(0, (items.value[manualLine.value].start - lyricsStore.offsetMs) / 1000));
    manualLine.value = null;
  } else back();
}

// ——— Clic et vibration ———
let audio: AudioContext | null = null;
let lastTick = 0;
function tick(strong = false) {
  const t = performance.now();
  if (t - lastTick < 28) return;
  lastTick = t;
  // Vibration seulement après un vrai toucher (sinon le navigateur la refuse avec une erreur).
  const activated = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive ?? true;
  if (baladeur.haptics === "1" && activated) navigator.vibrate?.(strong ? 12 : 5);
  if (baladeur.clicks !== "1") return;
  try {
    audio ??= new AudioContext();
    const length = Math.floor(audio.sampleRate * 0.006);
    const buffer = audio.createBuffer(1, length, audio.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
    const source = audio.createBufferSource();
    const gain = audio.createGain();
    const filter = audio.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = strong ? 1800 : 3200;
    gain.gain.value = strong ? 0.35 : 0.22;
    source.buffer = buffer;
    source.connect(filter).connect(gain).connect(audio.destination);
    source.start();
  } catch {
    // son indisponible : la vibration suffit
  }
}

// ——— Verrou et rétroéclairage ———
const locked = ref(false);
const lockFlash = ref(false);
let lockTimer: ReturnType<typeof setTimeout> | undefined;
function flashLock() {
  lockFlash.value = true;
  clearTimeout(lockTimer);
  lockTimer = setTimeout(() => (lockFlash.value = false), 1200);
}
function toggleLock() {
  locked.value = !locked.value;
  tick(true);
  flashLock();
}

const asleep = ref(false);
let lastTouch = performance.now();
function touched() {
  lastTouch = performance.now();
}
/** Réveille l'écran ; vrai si l'appui ne servait qu'à ça (comme sur un vrai lecteur). */
function wake(): boolean {
  touched();
  if (!asleep.value) return false;
  asleep.value = false;
  return true;
}
const sleepCheck = setInterval(() => {
  const secs = Number(baladeur.backlight);
  asleep.value = secs > 0 && performance.now() - lastTouch > secs * 1000;
}, 1000);

// ——— Batterie (si le navigateur la donne) ———
const battery = ref<{ level: number; charging: boolean } | null>(null);
type BatteryLike = { level: number; charging: boolean; addEventListener: (type: string, cb: () => void) => void };
onMounted(async () => {
  const get = (navigator as Navigator & { getBattery?: () => Promise<BatteryLike> }).getBattery;
  if (!get) return;
  try {
    const b = await get.call(navigator);
    const read = () => (battery.value = { level: b.level, charging: b.charging });
    read();
    b.addEventListener("levelchange", read);
    b.addEventListener("chargingchange", read);
  } catch {
    // indisponible
  }
});

// ——— Démarrage ———
const booting = ref(true);
onMounted(() => setTimeout(() => (booting.value = false), 900));

// Titre trop long pour l'écran : il défile.
const titleBox = ref<HTMLElement | null>(null);
const marquee = ref(false);
watch(
  [track, screen],
  async () => {
    await nextTick();
    const box = titleBox.value;
    marquee.value = !!box && box.scrollWidth > box.clientWidth + 2;
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  clearInterval(sleepCheck);
  clearInterval(seekTimer);
  [longTimer, volumeTimer, volumeSend, manualTimer, initialTimer, lockTimer].forEach((t) => clearTimeout(t));
  void audio?.close();
});
</script>

<template>
  <div class="baladeur" :class="[`skin-${baladeur.skin.id}`, { mono: baladeur.skin.mono, pads: baladeur.skin.pads }]" @pointerdown.capture="touched">
    <div class="edge">
      <span class="brand">Music Player</span>
      <button type="button" class="hold" :class="{ on: locked }" :aria-pressed="locked" aria-label="Verrou" @click="toggleLock">
        <span class="hold-knob" />
      </button>
    </div>

    <div class="bezel">
      <div class="screen" :class="{ asleep }">
        <div v-if="booting" class="boot">
          <Icon name="note" :size="34" />
          <span>Music Player</span>
          <i class="boot-bar"><b /></i>
        </div>
        <template v-else>
          <header class="status">
            <span class="status-title">{{ title }}</span>
            <span class="status-icons">
              <Icon v-if="locked" name="close" :size="11" />
              <Icon v-if="track" :name="player.isPaused ? 'pause' : 'play'" :size="11" />
              <span v-if="battery" class="battery" :class="{ charging: battery.charging, low: battery.level < 0.2 }">
                <i :style="{ width: `${Math.round(battery.level * 100)}%` }" />
              </span>
            </span>
          </header>

          <Transition :name="direction === 'in' ? 'slide-in' : 'slide-out'">
            <div :key="stack.length + title" class="page">
              <!-- Liste -->
              <ul v-if="list" class="rows" role="listbox" :aria-label="title">
                <li v-for="(row, i) in visible" :key="list.top + i" class="row" :class="{ sel: list.top + i === list.selected }" role="option" :aria-selected="list.top + i === list.selected">
                  <span class="row-text">
                    <span class="row-label">{{ row.label }}</span>
                    <span v-if="row.sub" class="row-sub">{{ row.sub }}</span>
                  </span>
                  <span v-if="row.value" class="row-value">{{ row.value }}</span>
                  <span v-else-if="row.more" class="row-more">›</span>
                </li>
                <li v-if="!rows.length" class="empty">Rien ici pour l'instant.</li>
                <span v-if="rows.length > ROWS" class="scrollbar"><i :style="{ top: `${(list.top / rows.length) * 100}%`, height: `${(ROWS / rows.length) * 100}%` }" /></span>
              </ul>

              <!-- En lecture -->
              <div v-else-if="screen.kind === 'now'" class="now">
                <template v-if="track">
                  <div class="now-top">
                    <div class="cover"><Artwork :track="track" :radius="4" eager /></div>
                    <div class="now-text">
                      <div ref="titleBox" class="now-title" :class="{ marquee }"><span>{{ track.title }}</span><span v-if="marquee" aria-hidden="true">{{ track.title }}</span></div>
                      <div class="now-artist">{{ track.artist }}</div>
                      <div class="now-album">{{ track.album }}</div>
                      <div class="now-flags">
                        <Icon v-if="player.shuffle" name="shuffle" :size="11" />
                        <Icon v-if="player.repeat !== 'off'" name="repeat" :size="11" />
                        <span v-if="player.repeat === 'one'" class="one">1</span>
                      </div>
                    </div>
                  </div>
                  <div class="now-bottom">
                    <span class="now-count">{{ queueLabel }}</span>
                    <div class="bar"><i :style="{ width: `${duration ? (position / duration) * 100 : 0}%` }" /></div>
                    <div class="times"><span>{{ clock(position) }}</span><span>{{ clock(position - duration) }}</span></div>
                  </div>
                  <Transition name="fade">
                    <div v-if="volumeShown" class="volume">
                      <Icon name="volume" :size="12" />
                      <div class="bar"><i :style="{ width: `${player.volume * 100}%` }" /></div>
                    </div>
                  </Transition>
                </template>
                <p v-else class="empty">Aucun morceau en cours.</p>
              </div>

              <!-- Paroles -->
              <div v-else class="lyrics">
                <p v-if="!track" class="empty">Aucun morceau en cours.</p>
                <p v-else-if="lyricsState" class="empty">{{ lyricsState }}</p>
                <template v-else>
                  <p
                    v-for="line in lyricLines"
                    :key="line.index"
                    class="lyric"
                    :class="{ cur: line.index === shownLine, past: line.index < shownLine, picked: manualLine !== null && line.index === shownLine }"
                  >
                    <span v-if="line.index === shownLine && items.length" class="lyric-fill" :style="{ '--fill': `${fill * 100}%` }">{{ line.text }}</span>
                    <template v-else>{{ line.text }}</template>
                  </p>
                  <span v-if="manualLine !== null && items.length" class="lyrics-hint">Centre : aller à cette ligne</span>
                </template>
              </div>
            </div>
          </Transition>

          <Transition name="fade">
            <div v-if="bigInitial" class="initial">{{ bigInitial }}</div>
          </Transition>
          <Transition name="fade">
            <div v-if="lockFlash" class="lock-toast">{{ locked ? "Verrouillé" : "Déverrouillé" }}</div>
          </Transition>
        </template>
      </div>
    </div>

    <div class="wheel-area">
      <div
        ref="wheel"
        class="wheel"
        :class="pressed ? `press-${pressed}` : ''"
        role="group"
        aria-label="Molette : tourner pour défiler"
        @pointerdown="onWheelDown"
        @pointermove="onWheelMove"
        @pointerup="onWheelUp"
        @pointercancel="onWheelUp"
        @contextmenu.prevent
      >
        <span class="label l-menu">MENU</span>
        <span class="label l-prev"><Icon name="prev" :size="15" /></span>
        <span class="label l-next"><Icon name="next" :size="15" /></span>
        <span class="label l-play"><Icon name="play" :size="11" /><Icon name="pause" :size="11" /></span>
        <span class="center" />
        <!-- Boutons accessibles au lecteur d'écran (la molette elle-même se manipule au doigt). -->
        <span class="sr">
          <button type="button" @click="press('menu')">Menu</button>
          <button type="button" @click="scroll(-1)">Monter</button>
          <button type="button" @click="scroll(1)">Descendre</button>
          <button type="button" @click="press('center')">Valider</button>
          <button type="button" @click="press('play')">Lecture ou pause</button>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.baladeur {
  /* Finition par défaut : Craie. */
  --body: linear-gradient(165deg, #f6f4ef 0%, #e4e0d8 55%, #d6d1c7 100%);
  --edge: rgba(0, 0, 0, 0.08);
  --brand: rgba(0, 0, 0, 0.32);
  --bezel: #16181c;
  --screen-bg: linear-gradient(180deg, #fbfcfe, #eef1f6);
  --screen-fg: #18202c;
  --screen-dim: #6a7280;
  --status-bg: linear-gradient(180deg, #e9edf3, #d9dee7);
  --hl-bg: linear-gradient(180deg, #4d8dff, #2a62d9);
  --hl-fg: #fff;
  --wheel: radial-gradient(circle at 50% 35%, #ffffff, #ecebe7 70%, #e1dfda);
  --wheel-ring: rgba(0, 0, 0, 0.07);
  --wheel-label: #8b9099;
  --center: radial-gradient(circle at 50% 30%, #f3f2ee, #e2e0db);
  --center-ring: rgba(0, 0, 0, 0.1);
  --press: rgba(0, 0, 0, 0.06);
  --font: inherit;

  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2.2vh;
  padding: calc(env(safe-area-inset-top, 0px) + 10px) 18px calc(env(safe-area-inset-bottom, 0px) + 18px);
  background: var(--body);
  color: var(--screen-fg);
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
  overflow: hidden;
}
.skin-graphite {
  --body: linear-gradient(165deg, #4a4e55 0%, #2c2f34 50%, #1b1d21 100%);
  --edge: rgba(255, 255, 255, 0.07);
  --brand: rgba(255, 255, 255, 0.28);
  --bezel: #07080a;
  --screen-bg: linear-gradient(180deg, #0f2236, #08131f);
  --screen-fg: #d6ecff;
  --screen-dim: #7d9bb8;
  --status-bg: linear-gradient(180deg, #1b3550, #11253a);
  --hl-bg: linear-gradient(180deg, #4ba3ff, #1e6fd6);
  --wheel: radial-gradient(circle at 50% 35%, #44484f, #2b2e33 70%, #232529);
  --wheel-ring: rgba(255, 255, 255, 0.06);
  --wheel-label: #a7b0bb;
  --center: radial-gradient(circle at 50% 30%, #3c4046, #2a2d32);
  --center-ring: rgba(255, 255, 255, 0.08);
  --press: rgba(255, 255, 255, 0.07);
}
.skin-pistache {
  --body: linear-gradient(165deg, #d9ead0 0%, #b9d6aa 55%, #9fc48d 100%);
  --edge: rgba(30, 60, 20, 0.12);
  --brand: rgba(30, 60, 20, 0.4);
  --screen-bg: linear-gradient(180deg, #fbfdf8, #eef5e8);
  --screen-fg: #1d2a1a;
  --screen-dim: #66785f;
  --status-bg: linear-gradient(180deg, #e6f0de, #d3e4c8);
  --hl-bg: linear-gradient(180deg, #74b45e, #4f8f3b);
  --wheel: radial-gradient(circle at 50% 35%, #ffffff, #f1f5ec 70%, #e3ebdb);
  --wheel-label: #6f8667;
  --center: radial-gradient(circle at 50% 30%, #eef4e8, #dbe6d1);
}
.skin-lagon {
  --body: radial-gradient(120% 70% at 30% 10%, rgba(255, 255, 255, 0.35), transparent 60%),
    repeating-linear-gradient(90deg, rgba(255, 255, 255, 0.05) 0 2px, transparent 2px 22px),
    linear-gradient(165deg, #5cc6ef 0%, #1d93cf 50%, #0d6aa6 100%);
  --edge: rgba(255, 255, 255, 0.25);
  --brand: rgba(255, 255, 255, 0.7);
  --bezel: rgba(4, 30, 52, 0.9);
  --screen-bg: linear-gradient(180deg, #effaff, #dcf0fc);
  --screen-fg: #0a2742;
  --screen-dim: #4f7896;
  --status-bg: linear-gradient(180deg, #d4edfb, #bfe2f7);
  --hl-bg: linear-gradient(180deg, #1aa3e8, #0b78bd);
  --wheel: radial-gradient(circle at 50% 30%, rgba(255, 255, 255, 0.55), rgba(255, 255, 255, 0.22) 70%, rgba(255, 255, 255, 0.14));
  --wheel-ring: rgba(255, 255, 255, 0.35);
  --wheel-label: #ffffff;
  --center: radial-gradient(circle at 50% 30%, rgba(255, 255, 255, 0.7), rgba(255, 255, 255, 0.35));
  --center-ring: rgba(255, 255, 255, 0.45);
  --press: rgba(255, 255, 255, 0.25);
}
.skin-ambre {
  --body: linear-gradient(165deg, #2a2926 0%, #191816 60%, #0e0d0c 100%);
  --edge: rgba(255, 255, 255, 0.05);
  --brand: rgba(255, 176, 0, 0.45);
  --bezel: #050505;
  --screen-bg: radial-gradient(120% 90% at 50% 40%, #3a2406, #1e1203);
  --screen-fg: #ffb000;
  --screen-dim: #a86f00;
  --status-bg: transparent;
  --hl-bg: #ffb000;
  --hl-fg: #1e1203;
  --wheel: radial-gradient(circle at 50% 35%, #2e2c29, #1d1c1a 75%);
  --wheel-ring: rgba(255, 255, 255, 0.04);
  --wheel-label: #c9c2b5;
  --center: radial-gradient(circle at 50% 30%, #3a3733, #24221f);
  --center-ring: rgba(0, 0, 0, 0.6);
  --press: rgba(255, 176, 0, 0.12);
  --font: ui-monospace, "Cascadia Mono", "Roboto Mono", monospace;
}

/* ——— Tranche : marque et verrou ——— */
.edge {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: min(92vw, 440px);
  padding: 0 4px;
}
.brand {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--brand);
}
.hold {
  position: relative;
  width: 38px;
  height: 18px;
  border: 0;
  border-radius: 9px;
  background: var(--edge);
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.35);
}
.hold::after {
  content: "";
  position: absolute;
  inset: 5px 6px 5px auto;
  width: 8px;
  border-radius: 2px;
  background: #e8572e;
  opacity: 0;
  transition: opacity 0.2s;
}
.hold.on::after {
  opacity: 1;
  inset: 5px auto 5px 6px;
}
.hold-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 14px;
  border-radius: 7px;
  background: linear-gradient(180deg, #fdfdfd, #cfcfcf);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
  transition: transform 0.18s;
}
.hold.on .hold-knob {
  transform: translateX(18px);
}

/* ——— Écran ——— */
.bezel {
  width: min(92vw, 440px);
  flex: 0 0 auto;
  height: min(48vh, 76vw, 400px);
  padding: 9px;
  border-radius: 16px;
  background: var(--bezel);
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.35),
    inset 0 2px 6px rgba(0, 0, 0, 0.6);
}
.screen {
  position: relative;
  height: 100%;
  border-radius: 8px;
  overflow: hidden;
  background: var(--screen-bg);
  font-family: var(--font);
  transition: filter 0.6s;
}
.screen::after {
  /* Reflet de la vitre. */
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(155deg, rgba(255, 255, 255, 0.16), transparent 38%);
  pointer-events: none;
}
.mono .screen::before {
  /* Lignes de l'écran monochrome. */
  content: "";
  position: absolute;
  inset: 0;
  z-index: 3;
  background: repeating-linear-gradient(0deg, rgba(0, 0, 0, 0.18) 0 1px, transparent 1px 3px);
  pointer-events: none;
}
.mono .screen {
  text-shadow: 0 0 6px rgba(255, 176, 0, 0.45);
}
.screen.asleep {
  filter: brightness(0.32) saturate(0.6);
}
.boot {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--screen-fg);
}
.boot-bar {
  width: 120px;
  height: 5px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--screen-fg) 15%, transparent);
  overflow: hidden;
}
.boot-bar b {
  display: block;
  height: 100%;
  background: var(--screen-fg);
  animation: boot 0.85s ease-out forwards;
}
@keyframes boot {
  from {
    width: 0;
  }
  to {
    width: 100%;
  }
}

.status {
  position: relative;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 22px;
  padding: 0 9px;
  background: var(--status-bg);
  border-bottom: 1px solid color-mix(in srgb, var(--screen-fg) 14%, transparent);
  font-size: 11.5px;
  font-weight: 700;
}
.status-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status-icons {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.battery {
  position: relative;
  width: 20px;
  height: 10px;
  padding: 1px;
  border: 1px solid currentColor;
  border-radius: 2px;
}
.battery::after {
  content: "";
  position: absolute;
  right: -3px;
  top: 2px;
  width: 2px;
  height: 4px;
  background: currentColor;
}
.battery i {
  display: block;
  height: 100%;
  background: currentColor;
}
.battery.low i {
  background: #e8572e;
}
.battery.charging i {
  background: #3fbf5a;
}

.page {
  position: absolute;
  inset: 22px 0 0;
}
.slide-in-enter-active,
.slide-in-leave-active,
.slide-out-enter-active,
.slide-out-leave-active {
  transition: transform 0.22s ease, opacity 0.22s;
}
.slide-in-enter-from,
.slide-out-leave-to {
  transform: translateX(100%);
}
.slide-in-leave-to,
.slide-out-enter-from {
  transform: translateX(-35%);
  opacity: 0;
}

/* ——— Listes ——— */
.rows {
  position: relative;
  display: grid;
  grid-template-rows: repeat(6, 1fr);
  height: 100%;
  margin: 0;
  padding: 0;
  list-style: none;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 0 14px 0 10px;
  font-size: 14px;
  font-weight: 600;
}
.row.sel {
  background: var(--hl-bg);
  color: var(--hl-fg);
}
.row-text {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  line-height: 1.15;
}
.row-label,
.row-sub {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-sub {
  font-size: 10.5px;
  font-weight: 500;
  color: var(--screen-dim);
}
.row.sel .row-sub {
  color: inherit;
  opacity: 0.8;
}
.row-value {
  font-size: 12px;
  font-weight: 500;
  color: var(--screen-dim);
}
.row.sel .row-value {
  color: inherit;
}
.row-more {
  font-size: 18px;
  line-height: 1;
}
.scrollbar {
  position: absolute;
  top: 3px;
  right: 3px;
  bottom: 3px;
  width: 4px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--screen-fg) 10%, transparent);
}
.scrollbar i {
  position: absolute;
  left: 0;
  right: 0;
  min-height: 8px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--screen-fg) 45%, transparent);
}
.empty {
  display: grid;
  place-items: center;
  height: 100%;
  margin: 0;
  padding: 0 18px;
  text-align: center;
  font-size: 13px;
  color: var(--screen-dim);
}

/* ——— En lecture ——— */
.now {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  height: 100%;
  padding: 12px 12px 10px;
}
.now-top {
  display: flex;
  gap: 12px;
  min-height: 0;
}
.cover {
  flex: 0 0 auto;
  width: 40%;
  max-width: 150px;
  aspect-ratio: 1;
  border-radius: 4px;
  overflow: hidden;
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.3);
}
.mono .cover {
  filter: grayscale(1) sepia(1) saturate(3.5) hue-rotate(-12deg) brightness(0.75) contrast(1.3);
}
.now-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  padding-top: 4px;
}
.now-title {
  overflow: hidden;
  white-space: nowrap;
  font-size: 15px;
  font-weight: 700;
}
.now-title.marquee span {
  display: inline-block;
  padding-right: 32px;
  animation: marquee 9s linear infinite;
}
@keyframes marquee {
  0%,
  12% {
    transform: translateX(0);
  }
  100% {
    transform: translateX(-100%);
  }
}
.now-artist,
.now-album {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  color: var(--screen-dim);
}
.now-artist {
  font-weight: 600;
  color: var(--screen-fg);
}
.now-flags {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
  color: var(--screen-dim);
}
.one {
  font-size: 9px;
  font-weight: 800;
}
.now-bottom {
  display: grid;
  gap: 4px;
}
.now-count {
  font-size: 11px;
  font-weight: 600;
  color: var(--screen-dim);
}
.bar {
  height: 7px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--screen-fg) 13%, transparent);
  box-shadow: inset 0 1px 1px rgba(0, 0, 0, 0.15);
  overflow: hidden;
}
.bar i {
  display: block;
  height: 100%;
  background: var(--hl-bg);
}
.times {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--screen-dim);
}
.volume {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--screen-bg);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--screen-fg) 15%, transparent);
}
.volume .bar {
  flex: 1;
}

/* ——— Paroles ——— */
.lyrics {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
  height: 100%;
  padding: 8px 14px 18px;
  text-align: center;
}
.lyric {
  margin: 0;
  font-size: 13px;
  line-height: 1.3;
  color: var(--screen-dim);
  opacity: 0.75;
  overflow-wrap: anywhere;
  transition: opacity 0.25s;
}
.lyric.past {
  opacity: 0.4;
}
.lyric.cur {
  font-size: 17px;
  font-weight: 800;
  color: var(--screen-fg);
  opacity: 1;
}
.lyric.picked {
  border-radius: 4px;
  background: var(--hl-bg);
  color: var(--hl-fg);
}
.lyric-fill {
  background: linear-gradient(90deg, var(--screen-fg) var(--fill), color-mix(in srgb, var(--screen-fg) 35%, transparent) var(--fill));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.mono .lyric-fill {
  text-shadow: none;
}
.lyrics-hint {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 4px;
  font-size: 10px;
  color: var(--screen-dim);
}

.initial,
.lock-toast {
  position: absolute;
  left: 50%;
  top: 55%;
  z-index: 4;
  transform: translate(-50%, -50%);
  display: grid;
  place-items: center;
  border-radius: 12px;
  background: color-mix(in srgb, var(--screen-fg) 78%, transparent);
  color: #fff;
  font-weight: 800;
}
.initial {
  width: 64px;
  height: 64px;
  font-size: 34px;
}
.lock-toast {
  padding: 8px 14px;
  font-size: 13px;
}
.mono .initial,
.mono .lock-toast {
  background: var(--hl-bg);
  color: var(--hl-fg);
}

/* ——— Molette ——— */
.wheel-area {
  display: grid;
  place-items: center;
  flex: 1;
  width: 100%;
  min-height: 0;
}
.wheel {
  position: relative;
  width: min(74vw, 40vh, 330px);
  aspect-ratio: 1;
  border-radius: 50%;
  background: var(--wheel);
  box-shadow:
    0 0 0 1px var(--wheel-ring),
    0 10px 24px rgba(0, 0, 0, 0.18),
    inset 0 2px 3px rgba(255, 255, 255, 0.5),
    inset 0 -3px 6px rgba(0, 0, 0, 0.08);
  touch-action: none;
  cursor: grab;
}
.wheel::before {
  /* Reflet de l'appui : un quart d'anneau éclairé. */
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: conic-gradient(from var(--from, 0deg), var(--press) 0 90deg, transparent 90deg);
  opacity: 0;
  transition: opacity 0.12s;
  -webkit-mask: radial-gradient(circle, transparent 35%, #000 35.5%);
  mask: radial-gradient(circle, transparent 35%, #000 35.5%);
}
.wheel.press-menu::before {
  --from: -45deg;
  opacity: 1;
}
.wheel.press-next::before {
  --from: 45deg;
  opacity: 1;
}
.wheel.press-play::before {
  --from: 135deg;
  opacity: 1;
}
.wheel.press-prev::before {
  --from: 225deg;
  opacity: 1;
}
.label {
  position: absolute;
  display: inline-flex;
  gap: 1px;
  color: var(--wheel-label);
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.12em;
  pointer-events: none;
}
.l-menu {
  top: 9%;
  left: 50%;
  transform: translateX(-50%);
}
.l-play {
  bottom: 9%;
  left: 50%;
  transform: translateX(-50%);
}
.l-prev {
  left: 9%;
  top: 50%;
  transform: translateY(-50%);
}
.l-next {
  right: 9%;
  top: 50%;
  transform: translateY(-50%);
}
.center {
  position: absolute;
  inset: 32%;
  border-radius: 50%;
  background: var(--center);
  box-shadow:
    0 0 0 1px var(--center-ring),
    0 2px 5px rgba(0, 0, 0, 0.15),
    inset 0 1px 2px rgba(255, 255, 255, 0.6);
  transition: transform 0.08s;
  pointer-events: none;
}
.wheel.press-center .center {
  transform: scale(0.96);
  box-shadow:
    0 0 0 1px var(--center-ring),
    inset 0 2px 6px rgba(0, 0, 0, 0.18);
}

/* Finition à boutons : quatre pavés en caoutchouc autour du centre. */
.pads .wheel {
  background: var(--wheel);
}
.pads .label {
  display: grid;
  place-items: center;
  width: 26%;
  height: 22%;
  border-radius: 10px;
  background: linear-gradient(180deg, #34312d, #242220);
  box-shadow:
    0 3px 0 #0a0a09,
    0 4px 8px rgba(0, 0, 0, 0.5),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
  font-size: 10px;
}
.pads .l-prev,
.pads .l-next {
  width: 22%;
  height: 26%;
}
.pads .l-play {
  grid-auto-flow: column;
  place-content: center;
}
.pads .l-menu {
  top: 5%;
}
.pads .l-play {
  bottom: 5%;
}
.pads .l-prev {
  left: 5%;
}
.pads .l-next {
  right: 5%;
}
.pads .wheel.press-menu .l-menu,
.pads .wheel.press-play .l-play,
.pads .wheel.press-prev .l-prev,
.pads .wheel.press-next .l-next {
  transform: translate(var(--tx, 0), var(--ty, 0)) translateY(2px);
  box-shadow:
    0 1px 0 #0a0a09,
    inset 0 2px 4px rgba(0, 0, 0, 0.5);
  color: #ffb000;
}
.pads .l-menu,
.pads .l-play {
  --tx: -50%;
}
.pads .l-prev,
.pads .l-next {
  --ty: -50%;
}
.pads .wheel::before {
  display: none;
}

.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .now-title.marquee span {
    animation: none;
  }
  .slide-in-enter-active,
  .slide-in-leave-active,
  .slide-out-enter-active,
  .slide-out-leave-active {
    transition: opacity 0.15s;
    transform: none;
  }
}
</style>
