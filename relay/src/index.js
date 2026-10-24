// Relais de Music Player (Cloudflare Workers + Durable Objects).
//
// 1. Partage (salles) : met en relation deux appareils qui ont le même code de partage, puis
//    passe les messages de l'un à l'autre. Il ne voit que des données chiffrées de bout en
//    bout : la clé est tirée des mots du code, que le relais ne reçoit jamais (seul le numéro
//    de salle lui est donné). Rien n'est enregistré ; une salle se ferme au bout de 15 minutes.
//
// 2. Proches (profils) : chaque appareil qui l'active a un code d'ami (« K7QM-2D9X »). On
//    s'ajoute par ce code ; l'ajout n'aboutit que si l'autre accepte. Le relais garde pour
//    chaque profil son nom, ce qu'il écoute en ce moment (effacé au bout de 6 heures), les
//    demandes en attente et la liste des amis autorisés à lire ce statut, rien d'autre.
//
// 3. Zone (sur option) : annuaire des profils qui ont choisi d'être visibles des personnes de
//    leur ville, d'après l'adresse IP vue par Cloudflare (jamais de position GPS). Une
//    annonce s'efface au bout de 10 minutes.

const ROOM = /^[0-9]{4,8}$/;
const ROLES = new Set(["envoi", "reception"]);
const LIFETIME_MS = 15 * 60 * 1000;

const CODE = /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;
const SECRET = /^[0-9a-f]{64}$/;
const TOKEN = /^[0-9a-f]{32,64}$/;
const PRESENCE_TTL_MS = 6 * 60 * 60 * 1000;
const ZONE_TTL_MS = 10 * 60 * 1000;
const MAX_INBOX = 50;
const MAX_FRIENDS = 200;
const MAX_BODY = 32 * 1024;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new Error("trop long");
  return text ? JSON.parse(text) : {};
}

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function clean(text, max) {
  return typeof text === "string" ? text.replace(/[\u0000-\u001f]/g, "").trim().slice(0, max) : "";
}

/** Petite photo de profil (data URL JPEG/PNG/WebP, 24 Ko au plus). */
function cleanAvatar(value) {
  return typeof value === "string" && value.length <= 24 * 1024 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(value)
    ? value
    : null;
}

function cleanPresence(p) {
  if (!p || typeof p !== "object") return null;
  return {
    title: clean(p.title, 200),
    artist: clean(p.artist, 200),
    album: clean(p.album, 200),
    playing: !!p.playing,
    duration: Number.isFinite(p.duration) ? Math.max(0, Math.min(p.duration, 86400)) : 0,
    position: Number.isFinite(p.position) ? Math.max(0, Math.min(p.position, 86400)) : 0,
    at: Date.now(),
  };
}

function profile(env, code) {
  return env.PROFILS.get(env.PROFILS.idFromName(code));
}

/** Ville (ou région) vue par Cloudflare : la zone d'un annuaire. */
function zoneOf(request) {
  const cf = request.cf ?? {};
  const place = cf.city || cf.region || cf.colo;
  if (!cf.country || !place) return null;
  return { key: `${cf.country}:${place}`.toLowerCase(), label: place };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/") {
      return new Response("Relais Music Player\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    const salle = url.pathname.match(/^\/v1\/salle\/([^/]+)$/);
    if (salle) {
      if (!ROOM.test(salle[1])) return new Response("Salle inconnue", { status: 404 });
      if (request.headers.get("Upgrade") !== "websocket") return new Response("WebSocket attendu", { status: 426 });
      if (!ROLES.has(url.searchParams.get("role"))) return new Response("Rôle inconnu", { status: 400 });
      return env.SALLES.get(env.SALLES.idFromName(salle[1])).fetch(request);
    }

    try {
      const profil = url.pathname.match(/^\/v1\/profil\/([^/]+)\/([a-z]+)$/);
      if (profil) {
        if (!CODE.test(profil[1])) return json({ erreur: "Code inconnu" }, 404);
        return profile(env, profil[1]).fetch(request);
      }

      // Statut de plusieurs amis d'un coup : { amis: [{ code, token }], lecteur }.
      if (url.pathname === "/v1/amis" && request.method === "POST") {
        const body = await readJson(request);
        const list = Array.isArray(body.amis) ? body.amis.slice(0, MAX_FRIENDS) : [];
        if (!CODE.test(body.lecteur ?? "")) return json({ erreur: "Lecteur inconnu" }, 400);
        const results = await Promise.all(
          list
            .filter((f) => CODE.test(f?.code ?? "") && TOKEN.test(f?.token ?? ""))
            .map(async (f) => {
              const response = await profile(env, f.code).fetch(
                new Request(`https://profil/v1/profil/${f.code}/lire`, {
                  method: "POST",
                  body: JSON.stringify({ lecteur: body.lecteur, token: f.token }),
                }),
              );
              return response.ok ? { code: f.code, ...(await response.json()) } : { code: f.code, refuse: true };
            }),
        );
        return json({ amis: results });
      }

      if (url.pathname === "/v1/zone") {
        const zone = zoneOf(request);
        if (!zone) return json({ zone: null, profils: [] });
        const stub = env.ZONES.get(env.ZONES.idFromName(zone.key));
        if (request.method === "GET") {
          const response = await stub.fetch(new Request("https://zone/liste"));
          return json({ zone: zone.label, profils: (await response.json()).profils });
        }
        if (request.method === "POST") {
          // Annonce (ou retrait) d'un profil : le relais vérifie qu'il appartient bien à
          // l'appareil (secret du profil) avant de l'inscrire.
          const body = await readJson(request);
          if (!CODE.test(body.code ?? "") || !SECRET.test(body.secret ?? "")) return json({ erreur: "Profil inconnu" }, 400);
          const check = await profile(env, body.code).fetch(
            new Request(`https://profil/v1/profil/${body.code}/verifier`, { method: "POST", body: JSON.stringify({ secret: body.secret }) }),
          );
          if (!check.ok) return json({ erreur: "Profil inconnu" }, 403);
          const card = await check.json();
          await stub.fetch(
            new Request("https://zone/annonce", { method: "POST", body: JSON.stringify({ ...card, visible: body.visible !== false }) }),
          );
          return json({ zone: zone.label });
        }
      }
      return json({ erreur: "Introuvable" }, 404);
    } catch (e) {
      return json({ erreur: "Requête invalide" }, 400);
    }
  },
};

export class Salle {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const role = new URL(request.url).searchParams.get("role");
    if (this.state.getWebSockets(role).length > 0) return new Response("Place déjà prise", { status: 409 });
    const [client, server] = Object.values(new WebSocketPair());
    this.state.acceptWebSocket(server, [role]);
    await this.state.storage.setAlarm(Date.now() + LIFETIME_MS);
    if (this.state.getWebSockets("envoi").length && this.state.getWebSockets("reception").length) {
      for (const ws of this.state.getWebSockets()) ws.send(JSON.stringify({ type: "pret" }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    const [role] = this.state.getTags(ws);
    const other = this.state.getWebSockets(role === "envoi" ? "reception" : "envoi")[0];
    if (other) other.send(message);
  }

  webSocketClose(ws) {
    for (const other of this.state.getWebSockets()) {
      if (other !== ws) other.close(1000, "Correspondant parti");
    }
  }

  webSocketError(ws) {
    this.webSocketClose(ws);
  }

  async alarm() {
    for (const ws of this.state.getWebSockets()) ws.close(1000, "Délai dépassé");
  }
}

/** Profil d'un appareil : carte publique (nom, photo), statut d'écoute, demandes, amis. */
export class Profil {
  constructor(state) {
    this.state = state;
  }

  async owner(secret) {
    const hash = await this.state.storage.get("secret");
    return !!hash && SECRET.test(secret ?? "") && hash === (await sha256(secret));
  }

  async card() {
    const card = await this.state.storage.get("carte");
    return card ?? null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const [, code, action] = url.pathname.match(/^\/v1\/profil\/([^/]+)\/([a-z]+)$/) ?? [];
    const storage = this.state.storage;

    // Carte publique : recherche d'un profil par son code.
    if (action === "carte" && request.method === "GET") {
      const card = await this.card();
      return card ? json(card) : json({ erreur: "Aucun profil avec ce code" }, 404);
    }
    if (request.method !== "POST") return json({ erreur: "Introuvable" }, 404);
    const body = await readJson(request);

    switch (action) {
      // Création (premier appareil qui présente ce code) ou mise à jour du nom et de la photo.
      case "profil": {
        const hash = await storage.get("secret");
        if (!SECRET.test(body.secret ?? "")) return json({ erreur: "Secret invalide" }, 400);
        if (hash && hash !== (await sha256(body.secret))) return json({ erreur: "Code déjà pris" }, 409);
        if (!hash) await storage.put("secret", await sha256(body.secret));
        const card = { code, nom: clean(body.nom, 40) || "Music Player", avatar: cleanAvatar(body.avatar) };
        await storage.put("carte", card);
        return json(card);
      }
      case "verifier": {
        if (!(await this.owner(body.secret))) return json({ erreur: "Refusé" }, 403);
        return json(await this.card());
      }
      // Ce que le profil écoute (null : rien, ou partage coupé).
      case "statut": {
        if (!(await this.owner(body.secret))) return json({ erreur: "Refusé" }, 403);
        const presence = cleanPresence(body.statut);
        if (presence) await storage.put("statut", presence);
        else await storage.delete("statut");
        return json({ ok: true });
      }
      // Lecture du statut par un ami autorisé.
      case "lire": {
        const grants = (await storage.get("amis")) ?? {};
        const expected = grants[body.lecteur];
        if (!expected || !TOKEN.test(body.token ?? "") || expected !== (await sha256(body.token))) {
          return json({ erreur: "Refusé" }, 403);
        }
        let statut = (await storage.get("statut")) ?? null;
        if (statut && Date.now() - statut.at > PRESENCE_TTL_MS) statut = null;
        return json({ carte: await this.card(), statut });
      }
      // Autorise (ou retire) un ami à lire le statut, avec le jeton qui lui est donné.
      case "autoriser":
      case "retirer": {
        if (!(await this.owner(body.secret)) || !CODE.test(body.lecteur ?? "")) return json({ erreur: "Refusé" }, 403);
        const grants = (await storage.get("amis")) ?? {};
        if (action === "autoriser") {
          if (!TOKEN.test(body.token ?? "")) return json({ erreur: "Jeton invalide" }, 400);
          if (!grants[body.lecteur] && Object.keys(grants).length >= MAX_FRIENDS) return json({ erreur: "Trop d'amis" }, 400);
          grants[body.lecteur] = await sha256(body.token);
        } else {
          delete grants[body.lecteur];
        }
        await storage.put("amis", grants);
        return json({ ok: true });
      }
      // Message déposé par un autre profil : demande d'ami, accord, ou retrait.
      case "message": {
        if (!(await storage.get("secret"))) return json({ erreur: "Aucun profil avec ce code" }, 404);
        if (!CODE.test(body.de ?? "") || body.de === code) return json({ erreur: "Expéditeur inconnu" }, 400);
        if (!["demande", "accord", "retrait"].includes(body.type)) return json({ erreur: "Message inconnu" }, 400);
        if (body.type !== "retrait" && !TOKEN.test(body.token ?? "")) return json({ erreur: "Jeton invalide" }, 400);
        const inbox = ((await storage.get("boite")) ?? []).filter((m) => !(m.de === body.de && m.type === body.type));
        if (inbox.length >= MAX_INBOX) return json({ erreur: "Boîte pleine" }, 429);
        inbox.push({
          type: body.type,
          de: body.de,
          nom: clean(body.nom, 40),
          avatar: cleanAvatar(body.avatar),
          token: body.type === "retrait" ? null : body.token,
          at: Date.now(),
        });
        await storage.put("boite", inbox);
        return json({ ok: true });
      }
      // Messages reçus (lus puis effacés par le propriétaire).
      case "boite": {
        if (!(await this.owner(body.secret))) return json({ erreur: "Refusé" }, 403);
        const inbox = (await storage.get("boite")) ?? [];
        if (inbox.length) await storage.put("boite", []);
        return json({ messages: inbox });
      }
      default:
        return json({ erreur: "Introuvable" }, 404);
    }
  }
}

/** Annuaire d'une ville : profils qui ont choisi d'y être visibles (10 minutes par annonce). */
export class Zone {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const now = Date.now();
    const entries = ((await this.state.storage.get("profils")) ?? []).filter((p) => now - p.at < ZONE_TTL_MS);
    if (url.pathname === "/liste") {
      return json({ profils: entries.slice(-100).map(({ code, nom, avatar }) => ({ code, nom, avatar })) });
    }
    if (url.pathname === "/annonce") {
      const card = await readJson(request);
      const kept = entries.filter((p) => p.code !== card.code);
      if (card.visible) kept.push({ code: card.code, nom: card.nom, avatar: card.avatar ?? null, at: now });
      await this.state.storage.put("profils", kept.slice(-500));
      return json({ ok: true });
    }
    return json({ erreur: "Introuvable" }, 404);
  }
}
