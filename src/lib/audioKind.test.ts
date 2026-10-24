import { describe, expect, it } from "vitest";
import { dateFromName, guessKind, voiceTitle } from "./audioKind";

const unknown = "Artiste inconnu";

describe("guessKind", () => {
  it("range les notes vocales WhatsApp à part", () => {
    expect(
      guessKind({ path: "/storage/emulated/0/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Voice Notes/202642/PTT-20261020-WA0012.opus", artist: unknown }),
    ).toBe("vocal");
    expect(guessKind({ path: "C:\\Users\\moi\\Downloads\\PTT-20260101-WA0001.opus", artist: unknown })).toBe("vocal");
  });

  it("garde un vrai morceau reçu par WhatsApp", () => {
    const dir = "/storage/emulated/0/WhatsApp/Media/WhatsApp Audio/";
    expect(guessKind({ path: `${dir}AUD-20261001-WA0003.mp3`, artist: "Aya Nakamura" })).toBe("musique");
    expect(guessKind({ path: `${dir}AUD-20261001-WA0004.opus`, artist: unknown })).toBe("vocal");
  });

  it("reconnaît les enregistrements du téléphone", () => {
    expect(guessKind({ path: "/storage/emulated/0/Recordings/Call/Appel Maman.m4a", artist: unknown })).toBe("enregistrement");
    expect(guessKind({ path: "/storage/emulated/0/MIUI/sound_recorder/rec 1.mp3", artist: unknown })).toBe("enregistrement");
    expect(guessKind({ path: "/storage/emulated/0/Music/Recording_20261012_101500.m4a", artist: unknown })).toBe("enregistrement");
  });

  it("laisse la musique tranquille", () => {
    expect(guessKind({ path: "/storage/emulated/0/Music/Stromae/Racine carrée/01 Ta fête.mp3", artist: "Stromae" })).toBe("musique");
    expect(guessKind({ path: "D:/Musique/Recording Artist/Track 1.flac", artist: unknown })).toBe("musique");
  });
});

describe("noms des vocaux", () => {
  it("lit la date du nom de fichier", () => {
    const d = dateFromName("/x/PTT-20261020-WA0012.opus");
    expect(d && [d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 9, 20]);
    expect(dateFromName("/x/morceau.mp3")).toBeNull();
    expect(dateFromName("/x/PTT-20261340-WA0012.opus")).toBeNull();
  });

  it("donne un titre lisible", () => {
    expect(voiceTitle({ path: "/x/PTT-20261020-WA0012.opus", title: "PTT-20261020-WA0012" })).toBe("Note vocale WhatsApp");
    expect(voiceTitle({ path: "/x/Rec 1.m4a", title: "Rec 1" })).toBe("Rec 1");
  });
});
