import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import TrackTable from "@/components/TrackTable.vue";
import type { Track } from "@/lib/types";

function track(overrides: Partial<Track>): Track {
  return {
    id: "t1",
    path: "/musique/t1.mp3",
    title: "Titre",
    artist: "Artiste",
    album: "Album",
    track_no: 1,
    duration_secs: 125,
    has_cover: false,
    ...overrides,
  };
}

describe("TrackTable", () => {
  it("affiche un état vide quand il n'y a aucune piste", () => {
    const wrapper = mount(TrackTable, { props: { tracks: [], currentTrackId: null } });
    expect(wrapper.text()).toContain("Aucune piste");
    expect(wrapper.find("table").exists()).toBe(false);
  });

  it("affiche une ligne par piste avec la durée formatée", () => {
    const wrapper = mount(TrackTable, {
      props: {
        tracks: [track({ id: "a", title: "Chanson A", duration_secs: 65 })],
        currentTrackId: null,
      },
    });
    expect(wrapper.text()).toContain("Chanson A");
    expect(wrapper.text()).toContain("1:05");
  });

  it("émet 'play' au double-clic sur une ligne", async () => {
    const wrapper = mount(TrackTable, {
      props: { tracks: [track({ id: "a" })], currentTrackId: null },
    });
    await wrapper.find("tbody tr").trigger("dblclick");
    expect(wrapper.emitted("play")?.[0]).toEqual(["a"]);
  });

  it("marque la piste en cours et affiche ▶ à la place du numéro", () => {
    const wrapper = mount(TrackTable, {
      props: { tracks: [track({ id: "a" }), track({ id: "b" })], currentTrackId: "b" },
    });
    const rows = wrapper.findAll("tbody tr");
    expect(rows[1].classes()).toContain("current");
    expect(rows[1].text()).toContain("▶");
  });

  it("n'affiche le bouton d'action secondaire que si secondaryActionLabel est fourni", async () => {
    const withoutAction = mount(TrackTable, { props: { tracks: [track({ id: "a" })], currentTrackId: null } });
    expect(withoutAction.find(".col-action").exists()).toBe(false);

    const withAction = mount(TrackTable, {
      props: { tracks: [track({ id: "a" })], currentTrackId: null, secondaryActionLabel: "Retirer" },
    });
    const button = withAction.find(".col-action button");
    expect(button.text()).toBe("Retirer");
    await button.trigger("click");
    expect(withAction.emitted("secondary-action")?.[0]).toEqual(["a"]);
  });
});
