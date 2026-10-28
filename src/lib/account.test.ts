// @vitest-environment node
import { describe, expect, it } from "vitest";
import { decrypt, deriveKeys, encrypt } from "./account";

describe("compte", () => {
  it("chiffre et déchiffre une sauvegarde avec le mot de passe", async () => {
    const keys = await deriveKeys("K7QM-2D9X", "mon mot de passe");
    expect(keys.cle).toMatch(/^[0-9a-f]{64}$/);
    const again = await deriveKeys("K7QM-2D9X", "mon mot de passe");
    expect(again).toEqual(keys);
    const sealed = await encrypt(keys.key, '{"format":"music-player-sauvegarde"}');
    expect(sealed).not.toContain("music-player");
    expect(await decrypt(keys.key, sealed)).toBe('{"format":"music-player-sauvegarde"}');
  });

  it("un autre mot de passe ne déchiffre rien", async () => {
    const keys = await deriveKeys("K7QM-2D9X", "bon");
    const other = await deriveKeys("K7QM-2D9X", "mauvais");
    expect(other.cle).not.toBe(keys.cle);
    await expect(decrypt(other.key, await encrypt(keys.key, "secret"))).rejects.toThrow();
  });
});
