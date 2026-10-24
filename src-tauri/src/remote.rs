//! Partage à distance, par code (« 4821-soleil-guitare ») : pour deux personnes qui ne sont
//! pas sur le même réseau. Les deux appareils se retrouvent sur un petit relais (relay/ à la
//! racine du dépôt) grâce au numéro de salle (« 4821 »), puis conviennent d'une clé avec SPAKE2
//! à partir des mots (« soleil-guitare »), que le relais ne reçoit jamais : il ne voit passer
//! que des données chiffrées (ChaCha20-Poly1305) et ne garde rien. Un tiers qui tenterait de
//! deviner les mots n'a droit qu'à un essai par code (1 chance sur 65 536).

use std::fs::File;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Nonce};
use hkdf::Hkdf;
use rand::Rng;
use sha2::Sha256;
use spake2::{Ed25519Group, Identity, Password, Spake2};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

use crate::transfer::{self, Failure, Offer, CHUNK, MAX_SIZE};

/// Relais du projet (relay/, mis en ligne sur Cloudflare).
const PROJECT_RELAY: &str = "https://music-player-relais.loickamg.workers.dev";

/// Relais utilisé sauf réglage contraire sur l'appareil : celui du projet, ou un autre donné à
/// la construction de l'application (variable MP_RELAY_URL ; la CI la passe vide quand la
/// variable du dépôt n'existe pas).
pub fn default_relay() -> Option<&'static str> {
    option_env!("MP_RELAY_URL")
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .or(Some(PROJECT_RELAY))
}

/// Mots des codes : courants, sans accents (faciles à dicter et à taper), tous différents.
const WORDS: [&str; 256] = [
    "abeille", "acier", "agneau", "aigle", "album", "amande", "ananas", "ancre", "angle", "anneau",
    "arbre", "argent", "atlas", "aube", "aurore", "avion", "azur", "badge", "bague", "baleine",
    "balcon", "ballon", "bambou", "banane", "barque", "bateau", "berger", "beurre", "biscuit", "bison",
    "blason", "bocal", "bonbon", "bougie", "boussole", "branche", "brebis", "brioche", "brume", "bulle",
    "cabane", "cactus", "cadeau", "caillou", "calme", "camion", "canard", "canyon", "carafe", "carotte",
    "cascade", "castor", "cerise", "chalet", "chameau", "chapeau", "chaton", "chemin", "cheval", "chouette",
    "cigale", "citron", "citrouille", "clairon", "clocher", "cobalt", "colombe", "coquille", "corail", "cornet",
    "coton", "coussin", "crayon", "cristal", "cygne", "dauphin", "delta", "desert", "diamant", "domino",
    "dragon", "dune", "eclair", "ecorce", "ecureuil", "encre", "etoile", "falaise", "faucon", "feuille",
    "figue", "flamme", "fleuve", "flute", "fougere", "fraise", "framboise", "frelon", "fromage", "fusee",
    "galet", "gazelle", "geyser", "girafe", "glacier", "gland", "glycine", "gorille", "granit", "grenade",
    "grillon", "guitare", "hamac", "hamster", "harpe", "hibou", "hirondelle", "hiver", "horizon", "igloo",
    "ilot", "iris", "jade", "jaguar", "jardin", "jasmin", "jongleur", "jonquille", "kayak", "koala",
    "lagune", "lama", "lampe", "lanterne", "lapin", "laurier", "lavande", "lezard", "licorne", "lilas",
    "limace", "lion", "lotus", "louve", "lune", "lutin", "magnolia", "maison", "mammouth", "mangue",
    "marbre", "marmotte", "menthe", "meteore", "miel", "mimosa", "miroir", "moineau", "montagne", "mosaique",
    "mouette", "mouton", "muguet", "myrtille", "nacre", "navire", "nectar", "neige", "noisette", "nuage",
    "oasis", "ocean", "olive", "ombre", "orage", "orange", "origami", "ours", "palmier", "panda",
    "papillon", "paradis", "pastel", "perle", "phare", "piano", "pigeon", "pinceau", "pirate", "planete",
    "plume", "poivre", "pomme", "poney", "prairie", "prune", "puma", "quartz", "radis", "raisin",
    "rameau", "recif", "renard", "requin", "rivage", "riviere", "robot", "rocher", "rose", "rubis",
    "ruisseau", "sable", "safran", "salade", "sapin", "saphir", "satin", "saumon", "silex", "sirene",
    "soleil", "sorbet", "source", "tambour", "tango", "tapis", "tempete", "tigre", "tomate", "tonnerre",
    "topaze", "tortue", "toucan", "tresor", "trefle", "tulipe", "turquoise", "ukulele", "vague", "vanille",
    "velours", "vent", "verger", "violon", "vitrail", "volcan", "wagon", "yaourt", "zebre", "zephyr",
    "zinc", "ecume", "buisson", "pivoine", "abricot", "goeland",
];

const IDENTITY: &[u8] = b"music-player/partage/v1";
/// Temps laissé au destinataire pour saisir le code (le relais ferme la salle après 15 min).
const WAIT_RECEIVER: Duration = Duration::from_secs(15 * 60);
const WAIT_SENDER: Duration = Duration::from_secs(2 * 60);

const TAKEN: &str = "salle déjà prise";
const WRONG_CODE: &str = "Code incorrect : vérifiez-le auprès de la personne qui partage.";

// Messages chiffrés : premier octet = nature du message.
const OFFER: u8 = 1;
const ANSWER: u8 = 2;
const DATA: u8 = 3;
const END: u8 = 4;
const DONE: u8 = 5;

type Socket = WebSocket<MaybeTlsStream<TcpStream>>;

/// Code de partage : numéro de salle (donné au relais) et mots (clé, gardés secrets).
#[derive(Debug, Clone, PartialEq)]
pub struct Code {
    pub room: String,
    pub words: String,
}

impl Code {
    pub fn text(&self) -> String {
        format!("{}-{}", self.room, self.words)
    }
}

pub fn new_code() -> Code {
    let mut rng = rand::thread_rng();
    Code {
        room: rng.gen_range(1000..10_000).to_string(),
        words: format!("{}-{}", WORDS[rng.gen_range(0..WORDS.len())], WORDS[rng.gen_range(0..WORDS.len())]),
    }
}

/// Code saisi, avec indulgence : espaces au lieu des tirets, majuscules, accents.
pub fn parse_code(input: &str) -> Result<Code, String> {
    let bad = || "Code invalide : il ressemble à « 4821-soleil-guitare ».".to_string();
    let cleaned = crate::lyrics::normalize(input);
    let parts: Vec<&str> = cleaned.split(' ').filter(|p| !p.is_empty()).collect();
    let [room, a, b] = parts.as_slice() else {
        return Err(bad());
    };
    if !(4..=8).contains(&room.len()) || !room.chars().all(|c| c.is_ascii_digit()) {
        return Err(bad());
    }
    if !WORDS.contains(a) || !WORDS.contains(b) {
        return Err(bad());
    }
    Ok(Code { room: room.to_string(), words: format!("{a}-{b}") })
}

fn room_url(relay: &str, room: &str, role: &str) -> Result<String, String> {
    let base = relay.trim().trim_end_matches('/');
    let base = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else if base.starts_with("wss://") || base.starts_with("ws://") {
        base.to_string()
    } else {
        return Err("Adresse du relais invalide (elle commence par https://).".into());
    };
    Ok(format!("{base}/v1/salle/{room}?role={role}"))
}

fn connect(relay: &str, room: &str, role: &str) -> Result<Socket, String> {
    let url = room_url(relay, room, role)?;
    match tungstenite::connect(url.as_str()) {
        Ok((ws, _)) => {
            // Liaison non bloquante, interrogée en boucle : l'attente reste interruptible
            // (annulation, délai dépassé). Pas de délai de lecture du système : sous Windows,
            // une lecture expirée laisse la connexion dans un état indéterminé (données perdues).
            let tcp = match ws.get_ref() {
                MaybeTlsStream::Plain(s) => Some(s),
                MaybeTlsStream::Rustls(s) => Some(s.get_ref()),
                _ => None,
            };
            if let Some(tcp) = tcp {
                tcp.set_nonblocking(true).map_err(|e| e.to_string())?;
            }
            Ok(ws)
        }
        Err(tungstenite::Error::Http(response)) if response.status().as_u16() == 409 => Err(TAKEN.into()),
        Err(e) => Err(format!("Relais de partage injoignable : {e}")),
    }
}

fn would_block(e: &tungstenite::Error) -> bool {
    matches!(e, tungstenite::Error::Io(io) if io.kind() == std::io::ErrorKind::WouldBlock)
}

/// Message suivant du correspondant (ou du relais), en attendant au plus jusqu'à `deadline`.
fn next(ws: &mut Socket, cancel: &AtomicBool, deadline: Instant) -> Result<Message, String> {
    loop {
        transfer::cancelled(cancel)?;
        if Instant::now() > deadline {
            return Err("Le correspondant ne répond pas.".into());
        }
        match ws.read() {
            Ok(Message::Close(frame)) => {
                return Err(frame
                    .map(|f| f.reason.to_string())
                    .filter(|r| !r.is_empty())
                    .unwrap_or_else(|| "Le correspondant s'est déconnecté.".into()))
            }
            Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_)) => continue,
            Ok(message) => return Ok(message),
            Err(e) if would_block(&e) => std::thread::sleep(Duration::from_millis(15)),
            Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                return Err("Le correspondant s'est déconnecté.".into())
            }
            Err(e) => return Err(format!("Liaison coupée : {e}")),
        }
    }
}

/// Envoie un message en entier (la liaison non bloquante peut demander plusieurs passes).
fn send(ws: &mut Socket, message: Message, cancel: &AtomicBool) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut result = ws.send(message);
    loop {
        match result {
            Ok(()) => return Ok(()),
            Err(e) if would_block(&e) => {
                transfer::cancelled(cancel)?;
                if Instant::now() > deadline {
                    return Err("Le correspondant ne reçoit plus rien.".into());
                }
                std::thread::sleep(Duration::from_millis(5));
                // Le message est déjà en file : il reste seulement à le faire partir.
                result = ws.flush();
            }
            Err(e) => return Err(format!("Liaison coupée : {e}")),
        }
    }
}

/// Attend que le relais annonce les deux appareils présents dans la salle.
fn wait_ready(ws: &mut Socket, cancel: &AtomicBool, wait: Duration) -> Result<(), String> {
    let deadline = Instant::now() + wait;
    loop {
        if let Message::Text(text) = next(ws, cancel, deadline)? {
            if text.as_str().contains("\"pret\"") {
                return Ok(());
            }
        }
    }
}

/// Liaison chiffrée de bout en bout, après accord sur la clé.
struct Channel<'a> {
    ws: Socket,
    seal: ChaCha20Poly1305,
    open: ChaCha20Poly1305,
    sent: u64,
    received: u64,
    cancel: &'a AtomicBool,
}

fn nonce(counter: u64) -> [u8; 12] {
    let mut n = [0u8; 12];
    n[4..].copy_from_slice(&counter.to_be_bytes());
    n
}

fn handshake<'a>(mut ws: Socket, words: &str, sender: bool, cancel: &'a AtomicBool) -> Result<Channel<'a>, String> {
    let (state, outbound) = Spake2::<Ed25519Group>::start_symmetric(&Password::new(words.as_bytes()), &Identity::new(IDENTITY));
    send(&mut ws, Message::binary(outbound), cancel)?;
    let deadline = Instant::now() + Duration::from_secs(60);
    let inbound = loop {
        if let Message::Binary(bytes) = next(&mut ws, cancel, deadline)? {
            break bytes;
        }
    };
    // Mauvais mots : SPAKE2 donne simplement une autre clé ; l'erreur se voit au premier
    // message, qui ne se déchiffre pas.
    let key = state.finish(&inbound).map_err(|_| WRONG_CODE.to_string())?;
    let hkdf = Hkdf::<Sha256>::new(None, &key);
    let (mut forward, mut backward) = ([0u8; 32], [0u8; 32]);
    hkdf.expand(b"envoi vers reception", &mut forward).map_err(|e| e.to_string())?;
    hkdf.expand(b"reception vers envoi", &mut backward).map_err(|e| e.to_string())?;
    let (seal, open) = if sender { (forward, backward) } else { (backward, forward) };
    Ok(Channel {
        ws,
        seal: ChaCha20Poly1305::new_from_slice(&seal).map_err(|e| e.to_string())?,
        open: ChaCha20Poly1305::new_from_slice(&open).map_err(|e| e.to_string())?,
        sent: 0,
        received: 0,
        cancel,
    })
}

impl Channel<'_> {
    fn send(&mut self, kind: u8, body: &[u8]) -> Result<(), String> {
        let mut plain = Vec::with_capacity(body.len() + 1);
        plain.push(kind);
        plain.extend_from_slice(body);
        let sealed = self
            .seal
            .encrypt(Nonce::from_slice(&nonce(self.sent)), plain.as_slice())
            .map_err(|_| "Chiffrement impossible.".to_string())?;
        self.sent += 1;
        send(&mut self.ws, Message::binary(sealed), self.cancel)
    }

    fn recv(&mut self, wait: Duration) -> Result<(u8, Vec<u8>), String> {
        let deadline = Instant::now() + wait;
        loop {
            if let Message::Binary(bytes) = next(&mut self.ws, self.cancel, deadline)? {
                let plain = self
                    .open
                    .decrypt(Nonce::from_slice(&nonce(self.received)), bytes.as_ref())
                    .map_err(|_| {
                        if self.received == 0 {
                            WRONG_CODE.to_string()
                        } else {
                            "Données altérées pendant le transfert.".to_string()
                        }
                    })?;
                self.received += 1;
                let (kind, body) = plain.split_first().ok_or("Message vide reçu.")?;
                return Ok((*kind, body.to_vec()));
            }
        }
    }

    /// Fermeture propre : le dernier message part avant la fin de la liaison.
    fn close(mut self) {
        let _ = self.ws.close(None);
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            match self.ws.flush() {
                Err(e) if would_block(&e) => std::thread::sleep(Duration::from_millis(10)),
                _ => break,
            }
        }
    }
}

/// Envoi en attente du destinataire : salle réservée sur le relais, code à lui transmettre.
pub struct PendingSend {
    ws: Socket,
    pub code: Code,
}

/// Réserve une salle sur le relais (autre numéro si celui tiré au sort est déjà pris).
pub fn open_send(relay: &str) -> Result<PendingSend, String> {
    for _ in 0..6 {
        let code = new_code();
        match connect(relay, &code.room, "envoi") {
            Ok(ws) => return Ok(PendingSend { ws, code }),
            Err(e) if e == TAKEN => continue,
            Err(e) => return Err(e),
        }
    }
    Err("Le relais de partage est saturé, réessayez dans un instant.".into())
}

/// Erreur définitive (refus, annulation, mauvais code) ou coupure qu'on peut reprendre.
fn classify(e: String) -> Failure {
    if e == WRONG_CODE || e.contains("annulé") || e.contains("refusé") || e.contains("volumineuse") {
        Failure::Final(e)
    } else {
        Failure::Retry(e)
    }
}

/// Position annoncée par le destinataire (« oui:123456 » : déjà reçu), ou `None` s'il refuse.
fn accepted_from(body: &[u8]) -> Option<u64> {
    let text = std::str::from_utf8(body).ok()?;
    let rest = text.strip_prefix("oui")?;
    Some(rest.strip_prefix(':').and_then(|n| n.parse().ok()).unwrap_or(0))
}

impl PendingSend {
    /// Attend que le destinataire saisisse le code, puis lui envoie l'archive. Après une
    /// coupure, les deux appareils se retrouvent dans la même salle et l'envoi reprend où il
    /// s'était arrêté. `progress(étape, fait, total)` ; « reprise » : (essai, essais permis).
    pub fn finish(
        self,
        relay: &str,
        path: &Path,
        offer: &Offer,
        cancel: &AtomicBool,
        mut progress: impl FnMut(&'static str, u64, u64),
    ) -> Result<(), String> {
        progress("attente", 0, offer.size);
        let code = self.code;
        let mut first = Some(self.ws);
        let mut paired = false;
        let mut attempt = 0;
        loop {
            let result = (|| -> Result<(), Failure> {
                let mut ws = match first.take() {
                    Some(ws) => ws,
                    None => connect(relay, &code.room, "envoi").map_err(Failure::Retry)?,
                };
                let wait = if paired { WAIT_SENDER } else { WAIT_RECEIVER };
                wait_ready(&mut ws, cancel, wait).map_err(|e| {
                    if !paired && e.contains("répond") {
                        Failure::Final("Personne n'a saisi le code à temps.".into())
                    } else {
                        classify(e)
                    }
                })?;
                paired = true;
                let mut channel = handshake(ws, &code.words, true, cancel).map_err(classify)?;
                let offer_json = serde_json::to_vec(offer).map_err(|e| Failure::Final(e.to_string()))?;
                channel.send(OFFER, &offer_json).map_err(classify)?;
                let (kind, body) = channel.recv(Duration::from_secs(120)).map_err(classify)?;
                let from = match (kind, accepted_from(&body)) {
                    (ANSWER, Some(from)) if from <= offer.size => from,
                    _ => return Err(Failure::Final("Le destinataire a refusé.".into())),
                };
                let mut file = File::open(path).map_err(|e| Failure::Final(e.to_string()))?;
                std::io::Seek::seek(&mut file, std::io::SeekFrom::Start(from)).map_err(|e| Failure::Final(e.to_string()))?;
                let mut buffer = vec![0u8; CHUNK];
                let mut sent = from;
                progress("envoi", sent, offer.size);
                loop {
                    transfer::cancelled(cancel).map_err(Failure::Final)?;
                    let n = file.read(&mut buffer).map_err(|e| Failure::Final(e.to_string()))?;
                    if n == 0 {
                        break;
                    }
                    channel.send(DATA, &buffer[..n]).map_err(classify)?;
                    sent += n as u64;
                    progress("envoi", sent, offer.size);
                }
                channel.send(END, &[]).map_err(classify)?;
                let (kind, body) = channel.recv(Duration::from_secs(120)).map_err(classify)?;
                channel.close();
                if kind != DONE || body != b"ok" {
                    return Err(Failure::Retry("Le destinataire n'a pas tout reçu.".into()));
                }
                Ok(())
            })();
            match result {
                Ok(()) => return Ok(()),
                Err(Failure::Final(e)) => return Err(e),
                Err(Failure::Retry(e)) => {
                    attempt += 1;
                    if attempt > transfer::RETRIES {
                        return Err(e);
                    }
                    progress("reprise", u64::from(attempt), u64::from(transfer::RETRIES));
                    transfer::pause(transfer::retry_delay(attempt), cancel)?;
                }
            }
        }
    }
}

/// Reçoit l'archive envoyée avec ce code et l'écrit dans `dest`. Après une coupure, se
/// reconnecte et indique à l'expéditeur où il en était. `progress(étape, fait, total)`.
pub fn receive(
    relay: &str,
    code: &Code,
    dest: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut(&'static str, u64, u64),
) -> Result<Offer, String> {
    progress("attente", 0, 0);
    let mut known: Option<Offer> = None;
    let mut attempt = 0;
    loop {
        let result = (|| -> Result<Offer, Failure> {
            let mut ws = connect(relay, &code.room, "reception").map_err(|e| {
                if e == TAKEN && known.is_none() {
                    Failure::Final("Ce code est déjà en cours d'utilisation.".into())
                } else {
                    Failure::Retry(e)
                }
            })?;
            wait_ready(&mut ws, cancel, WAIT_SENDER).map_err(|e| {
                if known.is_none() && e.contains("répond") {
                    Failure::Final("Personne n'envoie avec ce code pour l'instant.".into())
                } else {
                    classify(e)
                }
            })?;
            let mut channel = handshake(ws, &code.words, false, cancel).map_err(classify)?;
            let (kind, body) = channel.recv(Duration::from_secs(60)).map_err(classify)?;
            if kind != OFFER {
                return Err(Failure::Retry("Échange inattendu avec l'expéditeur.".into()));
            }
            let offer: Offer = serde_json::from_slice(&body).map_err(|_| Failure::Final("Offre illisible.".into()))?;
            if offer.size > MAX_SIZE {
                let _ = channel.send(ANSWER, b"non");
                return Err(Failure::Final("Archive trop volumineuse.".into()));
            }
            // Même envoi qu'avant la coupure : on garde ce qui est déjà reçu.
            let same = known.as_ref().is_some_and(|k| !k.id.is_empty() && k.id == offer.id && k.size == offer.size);
            let mut received = if same { std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0).min(offer.size) } else { 0 };
            let mut out = if received > 0 {
                std::fs::OpenOptions::new().write(true).open(dest).and_then(|f| {
                    f.set_len(received)?;
                    Ok(f)
                })
            } else {
                File::create(dest)
            }
            .map_err(|e| Failure::Final(e.to_string()))?;
            std::io::Seek::seek(&mut out, std::io::SeekFrom::Start(received)).map_err(|e| Failure::Final(e.to_string()))?;
            known = Some(offer.clone());
            channel.send(ANSWER, format!("oui:{received}").as_bytes()).map_err(classify)?;
            progress("reception", received, offer.size);
            loop {
                let (kind, body) = channel.recv(Duration::from_secs(120)).map_err(classify)?;
                match kind {
                    DATA => {
                        received += body.len() as u64;
                        if received > offer.size {
                            return Err(Failure::Final("L'expéditeur envoie plus que prévu.".into()));
                        }
                        out.write_all(&body).map_err(|e| Failure::Final(e.to_string()))?;
                        progress("reception", received, offer.size);
                    }
                    END => break,
                    _ => return Err(Failure::Retry("Échange inattendu avec l'expéditeur.".into())),
                }
            }
            out.flush().map_err(|e| Failure::Final(e.to_string()))?;
            if received != offer.size {
                return Err(Failure::Retry("Archive incomplète.".into()));
            }
            channel.send(DONE, b"ok").map_err(classify)?;
            channel.close();
            Ok(offer)
        })();
        match result {
            Ok(offer) => return Ok(offer),
            Err(Failure::Final(e)) => return Err(e),
            Err(Failure::Retry(e)) => {
                attempt += 1;
                if attempt > transfer::RETRIES {
                    return Err(e);
                }
                progress("reprise", u64::from(attempt), u64::from(transfer::RETRIES));
                transfer::pause(transfer::retry_delay(attempt), cancel)?;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn words_are_unique_and_easy_to_type() {
        let set: std::collections::HashSet<_> = WORDS.iter().collect();
        assert_eq!(set.len(), WORDS.len());
        assert!(WORDS.iter().all(|w| w.chars().all(|c| c.is_ascii_lowercase())));
    }

    #[test]
    fn codes_are_read_leniently() {
        let code = new_code();
        assert_eq!(parse_code(&code.text()).unwrap(), code);
        let typed = parse_code("  4821 Soleil — GUITARE ").unwrap();
        assert_eq!(typed, Code { room: "4821".into(), words: "soleil-guitare".into() });
        assert_eq!(parse_code("4821-éclair-tempête").unwrap().words, "eclair-tempete");
        assert!(parse_code("4821-soleil").is_err());
        assert!(parse_code("48-soleil-guitare").is_err());
        assert!(parse_code("4821-soleil-ordinateur").is_err());
    }

    #[test]
    fn relay_addresses() {
        assert_eq!(
            room_url("https://relais.example.dev/", "4821", "envoi").unwrap(),
            "wss://relais.example.dev/v1/salle/4821?role=envoi"
        );
        assert_eq!(room_url("http://127.0.0.1:8787", "1", "reception").unwrap(), "ws://127.0.0.1:8787/v1/salle/1?role=reception");
        assert!(room_url("relais.example.dev", "1", "envoi").is_err());
    }

    /// Relais minimal pour les essais : comme relay/src/index.js, met en relation deux
    /// appareils, annonce « pret », puis passe les messages ; recommence pour chaque nouvelle
    /// paire. `cut` : coupe net la première liaison après ce nombre de messages (reprise).
    fn local_relay(cut: Option<usize>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let mut cut = cut;
            loop {
                let mut sockets = Vec::new();
                for stream in listener.incoming().take(2) {
                    let stream = stream.unwrap();
                    let ws = tungstenite::accept(stream.try_clone().unwrap()).unwrap();
                    stream.set_nonblocking(true).unwrap();
                    sockets.push(ws);
                }
                let ready = |ws: &mut WebSocket<TcpStream>| {
                    let mut r = ws.send(Message::text("{\"type\":\"pret\"}"));
                    while matches!(&r, Err(e) if would_block(e)) {
                        r = ws.flush();
                    }
                };
                sockets.iter_mut().for_each(ready);
                let (mut a, mut b) = (sockets.remove(0), sockets.remove(0));
                let mut forwarded = 0usize;
                let mut pump = |from: &mut WebSocket<TcpStream>, to: &mut WebSocket<TcpStream>| -> bool {
                    match from.read() {
                        Ok(Message::Close(_)) => false,
                        Ok(m) => {
                            forwarded += 1;
                            if cut.is_some_and(|c| forwarded > c) {
                                return false;
                            }
                            let mut r = to.send(m);
                            while matches!(&r, Err(e) if would_block(e)) {
                                std::thread::sleep(Duration::from_millis(1));
                                r = to.flush();
                            }
                            r.is_ok()
                        }
                        Err(e) if would_block(&e) => {
                            std::thread::sleep(Duration::from_millis(1));
                            true
                        }
                        Err(_) => false,
                    }
                };
                while pump(&mut a, &mut b) && pump(&mut b, &mut a) {}
                cut = None;
            }
        });
        format!("http://127.0.0.1:{port}")
    }

    fn offer(size: u64) -> Offer {
        Offer { id: "envoi-1".into(), from: "Testeur".into(), kind: "playlist".into(), name: "Essai".into(), tracks: 2, size }
    }

    #[test]
    fn a_cut_transfer_resumes_where_it_stopped() {
        // Coupure après la clé, l'offre, la réponse et 2 tranches : reprise à la 3e.
        let relay = local_relay(Some(6));
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("envoi.mpshare");
        let content: Vec<u8> = (0..1_300_000u32).map(|i| (i % 241) as u8).collect();
        std::fs::write(&source, &content).unwrap();
        let pending = open_send(&relay).unwrap();
        let code = pending.code.clone();
        let size = content.len() as u64;
        let sending = {
            let relay = relay.clone();
            std::thread::spawn(move || {
                let mut resumed_from = Vec::new();
                let mut previous = 0;
                let result = pending.finish(&relay, &source, &offer(size), &AtomicBool::new(false), |stage, done, _| {
                    // Premier « envoi » après une reprise : position annoncée par le destinataire.
                    if stage == "envoi" && done > 0 && previous == 0 {
                        resumed_from.push(done);
                    }
                    previous = if stage == "reprise" { 0 } else { done };
                });
                (result, resumed_from)
            })
        };
        let dest = dir.path().join("recu.mpshare");
        let mut retries = 0;
        receive(&relay, &code, &dest, &AtomicBool::new(false), |stage, _, _| {
            if stage == "reprise" {
                retries += 1
            }
        })
        .unwrap();
        let (result, resumed_from) = sending.join().unwrap();
        result.unwrap();
        assert!(retries >= 1, "la coupure doit provoquer une reprise");
        assert!(resumed_from.iter().any(|&from| from >= CHUNK as u64), "reprise sans repartir de zéro : {resumed_from:?}");
        assert_eq!(std::fs::read(&dest).unwrap(), content);
    }

    #[test]
    fn archive_crosses_the_relay_encrypted() {
        let relay = local_relay(None);
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("envoi.mpshare");
        let content: Vec<u8> = (0..700_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&source, &content).unwrap();

        let pending = open_send(&relay).unwrap();
        let code = parse_code(&pending.code.text()).unwrap();
        let sending = {
            let source = source.clone();
            let relay = relay.clone();
            let size = content.len() as u64;
            std::thread::spawn(move || pending.finish(&relay, &source, &offer(size), &AtomicBool::new(false), |_, _, _| {}))
        };
        let dest = dir.path().join("recu.mpshare");
        let mut last = 0;
        let received = receive(&relay, &code, &dest, &AtomicBool::new(false), |_, done, _| last = done).unwrap();
        sending.join().unwrap().unwrap();
        assert_eq!(received, offer(content.len() as u64));
        assert_eq!(last, content.len() as u64);
        assert_eq!(std::fs::read(&dest).unwrap(), content);
    }

    /// Même échange, à travers le relais en ligne (TLS, Cloudflare) : réseau requis.
    #[test]
    #[ignore = "passe par le relais en ligne du projet"]
    fn archive_crosses_the_live_relay() {
        let relay = default_relay().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("envoi.mpshare");
        let content: Vec<u8> = (0..1_500_000u32).map(|i| (i % 249) as u8).collect();
        std::fs::write(&source, &content).unwrap();
        let pending = open_send(relay).unwrap();
        let code = pending.code.clone();
        let size = content.len() as u64;
        let sending = std::thread::spawn(move || pending.finish(relay, &source, &offer(size), &AtomicBool::new(false), |_, _, _| {}));
        let dest = dir.path().join("recu.mpshare");
        receive(relay, &code, &dest, &AtomicBool::new(false), |_, _, _| {}).unwrap();
        sending.join().unwrap().unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), content);
    }

    #[test]
    fn wrong_words_are_refused_on_both_sides() {
        let relay = local_relay(None);
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("envoi.mpshare");
        std::fs::write(&source, b"contenu").unwrap();
        let pending = open_send(&relay).unwrap();
        let mut code = pending.code.clone();
        code.words = if code.words == "soleil-guitare" { "lune-piano".into() } else { "soleil-guitare".into() };
        // L'expéditeur, lui, ne peut pas savoir que le code était faux : il attend le bon
        // destinataire jusqu'à ce qu'on annule.
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        let sending = {
            let relay = relay.clone();
            let cancel = cancel.clone();
            std::thread::spawn(move || pending.finish(&relay, &source, &offer(7), &cancel, |_, _, _| {}))
        };
        let err = receive(&relay, &code, &dir.path().join("x"), &AtomicBool::new(false), |_, _, _| {}).unwrap_err();
        assert!(err.contains("Code incorrect"), "{err}");
        cancel.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(sending.join().unwrap().unwrap_err().contains("annulé"));
    }
}
