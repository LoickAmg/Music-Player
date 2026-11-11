import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useUiStore } from "./ui";

beforeEach(() => setActivePinia(createPinia()));

describe("recherche", () => {
  it("revient aux résultats depuis une autre section sans retaper (champ gardé)", () => {
    const ui = useUiStore();
    ui.setSearch("the weeknd");
    expect(ui.route).toEqual({ name: "search", query: "the weeknd" });
    ui.go({ name: "artists", artist: "The Weeknd" });
    expect(ui.search).toBe("the weeknd");
    ui.reopenSearch();
    expect(ui.route).toEqual({ name: "search", query: "the weeknd" });
  });

  it("ne fait rien si le champ est vide ou si les résultats sont déjà là", () => {
    const ui = useUiStore();
    ui.go({ name: "albums" });
    ui.reopenSearch();
    expect(ui.route.name).toBe("albums");
    ui.setSearch("damso");
    const depth = ui.history.length;
    ui.reopenSearch();
    expect(ui.history.length).toBe(depth);
  });
});
