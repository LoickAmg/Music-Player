// Virtualisation : seules les lignes visibles (plus une marge) sont rendues, en se repérant
// sur le conteneur défilant principal de l'application (fourni par App.vue).

import { inject, onBeforeUnmount, onMounted, ref, type InjectionKey, type Ref } from "vue";

export const SCROLLER: InjectionKey<Ref<HTMLElement | null>> = Symbol("scroller");

export function useViewport(host: Ref<HTMLElement | null>) {
  const scroller = inject(SCROLLER, ref(null));
  const top = ref(0);
  const height = ref(800);
  const width = ref(800);

  function measure() {
    const el = host.value;
    const sc = scroller.value;
    if (!el) return;
    width.value = el.clientWidth;
    if (sc) {
      const offset = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
      top.value = sc.scrollTop - offset;
      height.value = sc.clientHeight;
    } else {
      top.value = 0;
      height.value = window.innerHeight;
    }
  }

  let resize: ResizeObserver | null = null;
  let frame = 0;
  const onScroll = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(measure);
  };

  onMounted(() => {
    measure();
    scroller.value?.addEventListener("scroll", onScroll, { passive: true });
    resize = new ResizeObserver(measure);
    if (host.value) resize.observe(host.value);
    if (scroller.value) resize.observe(scroller.value);
  });
  onBeforeUnmount(() => {
    scroller.value?.removeEventListener("scroll", onScroll);
    resize?.disconnect();
    cancelAnimationFrame(frame);
  });

  return { top, height, width, measure };
}
