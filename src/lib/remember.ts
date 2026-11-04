import { ref, watch, type Ref } from "vue";

/** Choix d'affichage (tri, onglet…) gardé d'une visite et d'un lancement à l'autre. */
export function remembered<T extends string>(key: string, fallback: T, allowed?: readonly T[]): Ref<T> {
  let start = fallback;
  try {
    const saved = localStorage.getItem(key) as T | null;
    if (saved !== null && (!allowed || allowed.includes(saved))) start = saved;
  } catch {
    // stockage indisponible : choix valable pour la session
  }
  const value = ref(start) as Ref<T>;
  watch(value, (v) => {
    try {
      localStorage.setItem(key, v);
    } catch {
      // stockage indisponible
    }
  });
  return value;
}
