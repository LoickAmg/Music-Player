// Relais de partage de Music Player (Cloudflare Workers + Durable Objects).
//
// Met en relation deux appareils qui ont le même code de partage (une « salle »), puis passe
// les messages de l'un à l'autre. Il ne voit que des données chiffrées de bout en bout : la
// clé est tirée des mots du code, que le relais ne reçoit jamais (seul le numéro de salle lui
// est donné). Rien n'est enregistré ; une salle se ferme au bout de 15 minutes.

const ROOM = /^[0-9]{4,8}$/;
const ROLES = new Set(["envoi", "reception"]);
const LIFETIME_MS = 15 * 60 * 1000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return new Response("Relais de partage Music Player\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    const match = url.pathname.match(/^\/v1\/salle\/([^/]+)$/);
    if (!match || !ROOM.test(match[1])) return new Response("Salle inconnue", { status: 404 });
    if (request.headers.get("Upgrade") !== "websocket") return new Response("WebSocket attendu", { status: 426 });
    if (!ROLES.has(url.searchParams.get("role"))) return new Response("Rôle inconnu", { status: 400 });
    return env.SALLES.get(env.SALLES.idFromName(match[1])).fetch(request);
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
