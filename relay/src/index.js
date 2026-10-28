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
/** Mots (messagerie entre proches) en attente de lecture, en plus des demandes. */
const MAX_WORDS = 200;
const MAX_FRIENDS = 200;
// Une playlist jointe à un mot (300 morceaux décrits au plus) tient dans cette limite.
const MAX_BODY = 96 * 1024;

// Compte (sauvegarde en ligne) : sauvegarde chiffrée sur l'appareil (le relais ne voit ni le
// mot de passe ni le contenu), découpée en morceaux de 1 Mo au plus, 20 Mo en tout.
const ACCOUNT_KEY = /^[0-9a-f]{64}$/;
const CHUNK_MAX = 1024 * 1024;
const MAX_CHUNKS = 20;
const TRIES_PER_HOUR = 10;

// Avis : types (comme le formulaire de l'appli) et taille d'un envoi (3 captures réduites).
const AVIS_KINDS = ["bug", "suggestion", "idee", "avis", "autre"];
const AVIS_MAX_BODY = 5 * 1024 * 1024;

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

async function readJson(request, max = MAX_BODY) {
  const text = await request.text();
  if (text.length > max) throw new Error("trop long");
  return text ? JSON.parse(text) : {};
}

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function clean(text, max) {
  if (typeof text !== "string") return "";
  // Sans caractères de contrôle (sauts de ligne, tabulations…).
  return [...text].filter((c) => c.charCodeAt(0) >= 0x20).join("").trim().slice(0, max);
}

/** Petite photo de profil (data URL JPEG/PNG/WebP, 24 Ko au plus). */
function cleanAvatar(value) {
  return typeof value === "string" && value.length <= 24 * 1024 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(value)
    ? value
    : null;
}

/** Morceau ou playlist joint à un mot (décrits, jamais de fichier). */
function cleanPiece(p) {
  if (!p || typeof p !== "object") return null;
  const track = (t) => ({ titre: clean(t?.titre, 200), artiste: clean(t?.artiste, 200), album: clean(t?.album, 200) });
  if (p.type === "morceau") {
    const t = track(p);
    return t.titre ? { type: "morceau", ...t } : null;
  }
  if (p.type === "playlist") {
    const morceaux = (Array.isArray(p.morceaux) ? p.morceaux : []).slice(0, 300).map(track).filter((t) => t.titre);
    return morceaux.length ? { type: "playlist", nom: clean(p.nom, 80) || "Playlist", morceaux } : null;
  }
  return null;
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

      // « Un avis ? » : dépôt public, lecture réservée au code administrateur (AVIS_ADMIN).
      const avis = url.pathname.match(/^\/v1\/avis(?:\/([a-z]+))?$/);
      if (avis && request.method === "POST") {
        const stub = env.AVIS.get(env.AVIS.idFromName("avis"));
        if (avis[1]) {
          // Administration : le code est vérifié ici, l'objet ne voit que le résultat.
          const body = await readJson(request);
          // Seule l'empreinte du code est connue du relais (wrangler.toml, AVIS_ADMIN_SHA256).
          const ok = !!env.AVIS_ADMIN_SHA256 && typeof body.admin === "string" && (await sha256(body.admin.trim())) === env.AVIS_ADMIN_SHA256;
          if (!ok) return json({ erreur: "Code administrateur incorrect" }, 403);
          return stub.fetch(new Request(`https://avis/${avis[1]}`, { method: "POST", body: JSON.stringify(body) }));
        }
        const visitor = await sha256(`${request.headers.get("cf-connecting-ip") ?? "?"}|avis`);
        const text = await request.text();
        if (text.length > AVIS_MAX_BODY) return json({ erreur: "Captures trop lourdes" }, 413);
        return stub.fetch(new Request(`https://avis/deposer?v=${visitor}`, { method: "POST", body: text }));
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
    } catch {
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
    const body = await readJson(request, action === "envoyer" ? CHUNK_MAX + 4096 : MAX_BODY);

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
        // Mot d'un proche (texte, morceau ou playlist) : seulement d'un ami autorisé, qui le
        // prouve avec le jeton reçu au moment de l'ajout.
        if (body.type === "mot") {
          const grants = (await storage.get("amis")) ?? {};
          if (!grants[body.de] || !TOKEN.test(body.token ?? "") || grants[body.de] !== (await sha256(body.token))) {
            return json({ erreur: "Réservé à vos proches" }, 403);
          }
          const texte = clean(body.texte, 1000);
          const piece = cleanPiece(body.piece);
          if (!texte && !piece) return json({ erreur: "Message vide" }, 400);
          const entry = { type: "mot", de: body.de, texte, piece, at: Date.now() };
          await this.toInbox(entry, MAX_WORDS);
          await this.toJournal(entry);
          return json({ ok: true });
        }
        if (!["demande", "accord", "retrait"].includes(body.type)) return json({ erreur: "Message inconnu" }, 400);
        if (body.type !== "retrait" && !TOKEN.test(body.token ?? "")) return json({ erreur: "Jeton invalide" }, 400);
        const entry = {
          type: body.type,
          de: body.de,
          nom: clean(body.nom, 40),
          avatar: cleanAvatar(body.avatar),
          token: body.type === "retrait" ? null : body.token,
          at: Date.now(),
        };
        await this.toInbox(entry, MAX_INBOX, (m) => !(m.de === body.de && m.type === body.type));
        await this.toJournal(entry);
        return json({ ok: true });
      }
      // Journal (plusieurs appareils sur un même profil) : messages reçus et ce que font les
      // appareils du propriétaire, lus par chacun à son rythme (rien n'est effacé à la lecture).
      case "journal": {
        if (!(await this.owner(body.secret))) return json({ erreur: "Refusé" }, 403);
        const depuis = Number(body.depuis) || 0;
        const journal = (await storage.get("journal")) ?? [];
        return json({ entrees: journal.filter((e) => e.at >= depuis).slice(0, 500) });
      }
      // Entrée écrite par un appareil du propriétaire : ami ajouté ou oublié, demande envoyée,
      // mot envoyé (les autres appareils s'y mettent à jour).
      case "ecrire": {
        if (!(await this.owner(body.secret))) return json({ erreur: "Refusé" }, 403);
        const e = body.entree ?? {};
        if (!["ami", "oubli", "attente", "envoye"].includes(e.type) || !CODE.test(e.code ?? "")) return json({ erreur: "Entrée invalide" }, 400);
        if (["ami", "attente"].includes(e.type) && !TOKEN.test(e.token ?? "")) return json({ erreur: "Jeton invalide" }, 400);
        await this.toJournal({
          type: e.type,
          moi: true,
          code: e.code,
          nom: clean(e.nom, 40),
          avatar: cleanAvatar(e.avatar),
          token: e.token ?? null,
          texte: clean(e.texte, 1000),
          piece: cleanPiece(e.piece),
          at: Date.now(),
        });
        return json({ ok: true });
      }
      // Messages reçus (lus puis effacés par le propriétaire) : versions 0.5.12 et antérieures.
      case "boite": {
        if (!(await this.owner(body.secret))) return json({ erreur: "Refusé" }, 403);
        const inbox = (await storage.get("boite")) ?? [];
        if (inbox.length) await storage.put("boite", []);
        return json({ messages: inbox });
      }
      // Compte : création ou nouveau mot de passe (par l'appareil propriétaire du profil).
      // `cle` : empreinte tirée du mot de passe sur l'appareil, qui prouve qu'on le connaît.
      case "compte": {
        if (!(await this.owner(body.secret)) || !ACCOUNT_KEY.test(body.cle ?? "")) return json({ erreur: "Refusé" }, 403);
        await storage.put("compte", await sha256(body.cle));
        return json({ ok: true });
      }
      // Envoi d'une sauvegarde chiffrée, morceau par morceau (`n` sur `total`).
      case "envoyer": {
        if (!(await this.accountOk(body.cle, true))) return json({ erreur: "Code ou mot de passe incorrect" }, 403);
        const n = Number(body.n);
        const total = Number(body.total);
        if (!Number.isInteger(total) || total < 1 || total > MAX_CHUNKS || !Number.isInteger(n) || n < 0 || n >= total) {
          return json({ erreur: "Sauvegarde trop volumineuse" }, 400);
        }
        if (typeof body.data !== "string" || body.data.length > CHUNK_MAX || !/^[A-Za-z0-9+/=]*$/.test(body.data)) {
          return json({ erreur: "Morceau invalide" }, 400);
        }
        await storage.put(`envoi:${n}`, body.data);
        // Dernier morceau : la nouvelle sauvegarde remplace l'ancienne d'un coup.
        if (n === total - 1) {
          const parts = [];
          for (let i = 0; i < total; i++) {
            const part = await storage.get(`envoi:${i}`);
            if (typeof part !== "string") return json({ erreur: "Morceau manquant, recommencez l'envoi" }, 400);
            parts.push(part);
          }
          for (let i = 0; i < total; i++) {
            await storage.put(`sauvegarde:${i}`, parts[i]);
            await storage.delete(`envoi:${i}`);
          }
          const previous = (await storage.get("sauvegarde")) ?? { total: 0 };
          for (let i = total; i < previous.total; i++) await storage.delete(`sauvegarde:${i}`);
          await storage.put("sauvegarde", { total, at: Date.now() });
        }
        return json({ ok: true });
      }
      // Récupération (autre appareil) : morceau `n` et description de la sauvegarde.
      case "recuperer": {
        if (!(await this.accountOk(body.cle, true))) return json({ erreur: "Code ou mot de passe incorrect" }, 403);
        const meta = await storage.get("sauvegarde");
        if (!meta) return json({ erreur: "Aucune sauvegarde en ligne pour ce compte" }, 404);
        const n = Number(body.n ?? 0);
        if (!Number.isInteger(n) || n < 0 || n >= meta.total) return json({ erreur: "Morceau inconnu" }, 400);
        return json({ total: meta.total, at: meta.at, data: (await storage.get(`sauvegarde:${n}`)) ?? "" });
      }
      default:
        return json({ erreur: "Introuvable" }, 404);
    }
  }

  /** Ancienne boîte (0.5.12 et avant) : jamais pleine, les plus anciens messages partent. */
  async toInbox(entry, max, keep = () => true) {
    const inbox = ((await this.state.storage.get("boite")) ?? []).filter(keep);
    inbox.push(entry);
    await this.state.storage.put("boite", inbox.slice(-max));
  }

  /** Journal du profil : 60 jours, 2 000 entrées au plus. */
  async toJournal(entry) {
    const now = Date.now();
    const journal = ((await this.state.storage.get("journal")) ?? []).filter((e) => now - e.at < 60 * 24 * 3600_000);
    // Photos laissées à la carte du profil ; 1,5 Mo au plus (une valeur en a 2 chez Cloudflare).
    journal.push({ id: crypto.randomUUID(), ...entry, avatar: null });
    let kept = journal.slice(-2000);
    while (kept.length > 1 && JSON.stringify(kept).length > 1_500_000) kept = kept.slice(1);
    await this.state.storage.put("journal", kept);
  }

  /** Mot de passe du compte prouvé par `cle` ; `counted` : essai décompté (10 ratés par heure). */
  async accountOk(cle, counted = false) {
    const storage = this.state.storage;
    const expected = await storage.get("compte");
    if (!expected) return false;
    const now = Date.now();
    let tries = (await storage.get("essais")) ?? { n: 0, since: now };
    if (now - tries.since > 3600_000) tries = { n: 0, since: now };
    if (counted && tries.n >= TRIES_PER_HOUR) return false;
    const ok = ACCOUNT_KEY.test(cle ?? "") && expected === (await sha256(cle));
    if (!ok && counted) await storage.put("essais", { n: tries.n + 1, since: tries.since });
    return ok;
  }
}

/** Annuaire d'une ville : profils qui ont choisi d'y être visibles (10 minutes par annonce). */
/** Avis des utilisateurs (« Un avis ? ») : gardés ici, lus dans l'appli par l'administrateur. */
export class Avis {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const storage = this.state.storage;
    const index = (await storage.get("index")) ?? [];
    const action = url.pathname.slice(1);

    if (action === "deposer") {
      // Limite d'envois : 10 avis par heure et par adresse (empreinte, jamais l'adresse elle-même).
      const visitor = url.searchParams.get("v") ?? "?";
      const now = Date.now();
      const rate = (await storage.get("envois")) ?? {};
      for (const [k, v] of Object.entries(rate)) if (now - v.since > 3600_000) delete rate[k];
      const mine = rate[visitor] ?? { n: 0, since: now };
      if (mine.n >= 10) return json({ erreur: "Merci pour tous ces retours ! Réessayez dans une heure." }, 429);
      let body;
      try {
        body = JSON.parse(await request.text());
      } catch {
        return json({ erreur: "Requête invalide" }, 400);
      }
      const kind = AVIS_KINDS.includes(body.kind) ? body.kind : null;
      const message = clean(String(body.message ?? "").replace(/\r\n/g, "\n"), 3000);
      if (!kind) return json({ erreur: "Choisissez le type de retour.", field: "kind" }, 400);
      if (message.length < 5) return json({ erreur: "Écrivez au moins quelques mots.", field: "message" }, 400);
      const contact = clean(body.contact, 160).toLowerCase();
      if (contact && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) {
        return json({ erreur: "Adresse e-mail invalide (ou laissez le champ vide).", field: "contact" }, 400);
      }
      const images = Array.isArray(body.images) ? body.images.slice(0, 3) : [];
      for (const img of images) {
        if (!["image/jpeg", "image/png", "image/webp"].includes(img?.type) || typeof img?.data !== "string" || img.data.length > 1_500_000 || !/^[A-Za-z0-9+/=]+$/.test(img.data)) {
          return json({ erreur: "Captures refusées : 3 images PNG, JPEG ou WebP au plus." }, 400);
        }
      }
      const id = crypto.randomUUID();
      for (const [n, img] of images.entries()) await storage.put(`img:${id}:${n}`, `data:${img.type};base64,${img.data}`);
      index.push({
        id,
        kind,
        message,
        name: clean(body.name, 60),
        contact,
        screen: clean(body.screen, 40),
        version: clean(body.version, 20),
        platform: clean(body.platform, 40),
        images: images.length,
        statut: "nouveau",
        at: now,
      });
      // 500 avis au plus : les plus anciens (et leurs captures) partent.
      while (index.length > 500) {
        const old = index.shift();
        for (let n = 0; n < old.images; n++) await storage.delete(`img:${old.id}:${n}`);
      }
      await storage.put("index", index);
      rate[visitor] = { n: mine.n + 1, since: mine.since };
      await storage.put("envois", rate);
      return json({ ok: true, message: "Votre retour est bien arrivé : il sera lu avec attention." });
    }

    const body = JSON.parse(await request.text());
    switch (action) {
      case "liste":
        return json({ avis: [...index].reverse() });
      // Nombre d'avis nouveaux (notifications) et date du plus récent.
      case "nouveaux": {
        const fresh = index.filter((a) => a.statut === "nouveau");
        return json({ nouveaux: fresh.length, dernier: fresh.at(-1) ?? null });
      }
      case "image": {
        const data = await storage.get(`img:${body.id}:${Number(body.n)}`);
        return data ? json({ data }) : json({ erreur: "Capture introuvable" }, 404);
      }
      case "statut": {
        const item = index.find((a) => a.id === body.id);
        if (!item || !["nouveau", "lu", "traite"].includes(body.statut)) return json({ erreur: "Avis introuvable" }, 404);
        item.statut = body.statut;
        await storage.put("index", index);
        return json({ ok: true });
      }
      case "supprimer": {
        const i = index.findIndex((a) => a.id === body.id);
        if (i < 0) return json({ erreur: "Avis introuvable" }, 404);
        const [old] = index.splice(i, 1);
        for (let n = 0; n < old.images; n++) await storage.delete(`img:${old.id}:${n}`);
        await storage.put("index", index);
        return json({ ok: true });
      }
      default:
        return json({ erreur: "Introuvable" }, 404);
    }
  }
}

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
