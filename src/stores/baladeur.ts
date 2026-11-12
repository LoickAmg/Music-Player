// Préférences du mode baladeur (téléphone seulement), gardées d'un lancement à l'autre.

import { defineStore } from "pinia";
import { computed } from "vue";
import { remembered } from "@/lib/remember";
import { SKINS, skinById } from "@/lib/baladeur";

const SKIN_IDS = SKINS.map((skin) => skin.id);

export const useBaladeurStore = defineStore("baladeur", () => {
  const on = remembered<"0" | "1">("baladeur.on", "0", ["0", "1"]);
  const skinId = remembered<string>("baladeur.skin", "craie", SKIN_IDS);
  const clicks = remembered<"0" | "1">("baladeur.clicks", "1", ["0", "1"]);
  const haptics = remembered<"0" | "1">("baladeur.haptics", "1", ["0", "1"]);
  /** Secondes avant que l'écran baisse (« 0 » : toujours allumé). */
  const backlight = remembered<"10" | "30" | "0">("baladeur.backlight", "30", ["10", "30", "0"]);

  const enabled = computed({ get: () => on.value === "1", set: (v: boolean) => (on.value = v ? "1" : "0") });
  const skin = computed(() => skinById(skinId.value));

  function nextSkin() {
    const i = SKIN_IDS.indexOf(skinId.value);
    skinId.value = SKIN_IDS[(i + 1) % SKIN_IDS.length];
  }

  function nextBacklight() {
    backlight.value = backlight.value === "10" ? "30" : backlight.value === "30" ? "0" : "10";
  }

  return { enabled, skinId, skin, clicks, haptics, backlight, nextSkin, nextBacklight };
});
