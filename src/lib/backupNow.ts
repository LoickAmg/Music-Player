// Sauvegarde de cet appareil, telle qu'au moment de l'appel (partagée par l'enregistrement
// dans un fichier, la synchronisation et la sauvegarde en ligne du compte).

import { api } from "./api";
import { buildBackup } from "./backup";
import { useAppearanceStore } from "@/stores/appearance";
import { useFavoritesStore } from "@/stores/favorites";
import { useLibraryStore } from "@/stores/library";
import { usePlaylistsStore } from "@/stores/playlists";
import { useShareStore } from "@/stores/share";

export function deviceName(): string {
  return useShareStore().deviceName || (/Android/i.test(navigator.userAgent) ? "Téléphone" : "Ordinateur");
}

export async function currentBackupJson(): Promise<string> {
  const library = useLibraryStore();
  const data = buildBackup({
    device: deviceName(),
    playlists: usePlaylistsStore().items,
    favoriteIds: [...useFavoritesStore().ids],
    byId: (id) => library.byId(id),
    listens: await api.getListens(),
    appearance: JSON.parse(JSON.stringify(useAppearanceStore().settings)),
  });
  return JSON.stringify(data);
}
