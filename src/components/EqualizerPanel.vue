<script setup lang="ts">
import { useEqStore, BAND_LABELS } from "@/stores/eq";

const eq = useEqStore();

function onInput(index: 0 | 1 | 2, event: Event) {
  const value = Number((event.target as HTMLInputElement).value);
  void eq.setGain(index, value);
}
</script>

<template>
  <section class="panel">
    <header class="panel-header">
      <h1>Égaliseur</h1>
      <button class="secondary" @click="eq.reset()">Réinitialiser</button>
    </header>

    <p class="hint">
      3 bandes (basses / médiums / aigus), de -12 dB à +12 dB. Le réglage s'applique en direct, même en cours de
      lecture.
    </p>

    <div class="bands">
      <div v-for="(label, i) in BAND_LABELS" :key="label" class="band">
        <div class="band-value">{{ eq.gains[i] > 0 ? "+" : "" }}{{ eq.gains[i].toFixed(1) }} dB</div>
        <input
          type="range"
          min="-12"
          max="12"
          step="0.5"
          orient="vertical"
          :value="eq.gains[i]"
          @input="onInput(i as 0 | 1 | 2, $event)"
        />
        <div class="band-label">{{ label }}</div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.panel {
  padding: 1.5em 1.75em;
  overflow-y: auto;
  height: 100%;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.5em;
}

h1 {
  font-size: 1.15em;
  margin: 0;
}

.hint {
  color: var(--text-dim);
  font-size: 0.85em;
  max-width: 36em;
  margin-bottom: 2em;
}

.bands {
  display: flex;
  gap: 3em;
  padding: 1em 0.5em;
}

.band {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75em;
}

.band-value {
  font-size: 0.8em;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
  width: 4.5em;
  text-align: center;
}

.band input[type="range"] {
  writing-mode: vertical-lr;
  direction: rtl;
  width: 8px;
  height: 12em;
}

.band-label {
  font-size: 0.85em;
  font-weight: 500;
}
</style>
