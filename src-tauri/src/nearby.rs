//! Partage à proximité : les appareils qui ont Music Player ouvert sur le même réseau Wi-Fi se
//! trouvent tout seuls (mDNS, comme les imprimantes ou les enceintes), puis s'envoient
//! l'archive directement, sans passer par Internet. Rien n'est reçu sans l'accord de la
//! personne qui reçoit (90 secondes pour répondre).

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;
use crate::transfer::{self, Offer, Progress, MAX_SIZE};

const SERVICE: &str = "_mpshare._tcp.local.";
/// Temps laissé à la personne qui reçoit pour accepter ou refuser.
const DECISION: Duration = Duration::from_secs(90);

/// Appareil trouvé sur le réseau.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Peer {
    pub id: String,
    pub name: String,
    /// « adresse:port », IPv4 d'abord.
    pub addresses: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct Hello {
    v: u32,
    offre: Offer,
}

#[derive(Serialize, Deserialize)]
struct Answer {
    reponse: String,
}

#[derive(Serialize, Deserialize)]
struct Done {
    fin: String,
}

fn write_line(out: &mut impl Write, value: &impl Serialize) -> Result<(), String> {
    let mut line = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    line.push(b'\n');
    out.write_all(&line).and_then(|_| out.flush()).map_err(|e| format!("Liaison coupée : {e}"))
}

fn read_line<T: for<'de> Deserialize<'de>>(reader: &mut impl BufRead, limit: u64) -> Result<T, String> {
    let mut line = Vec::new();
    let n = reader.by_ref().take(limit).read_until(b'\n', &mut line).map_err(|e| {
        if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) {
            "Le correspondant ne répond pas.".to_string()
        } else {
            format!("Liaison coupée : {e}")
        }
    })?;
    if n == 0 {
        return Err("Le correspondant s'est déconnecté.".into());
    }
    if !line.ends_with(b"\n") {
        return Err("Message trop long.".into());
    }
    serde_json::from_slice(&line).map_err(|_| "Message illisible.".to_string())
}

/// Envoie l'archive `path` au premier appareil joignable parmi `addresses`.
/// `progress(étape, fait, total)` : « attente » (de l'accord), puis « envoi ».
pub fn send_to(
    addresses: &[String],
    path: &Path,
    offer: &Offer,
    cancel: &AtomicBool,
    mut progress: impl FnMut(&'static str, u64, u64),
) -> Result<(), String> {
    let stream = addresses
        .iter()
        .filter_map(|a| a.parse::<SocketAddr>().ok())
        .find_map(|addr| TcpStream::connect_timeout(&addr, Duration::from_secs(4)).ok())
        .ok_or("Appareil injoignable : il a peut-être quitté le réseau ou fermé Music Player.")?;
    stream.set_write_timeout(Some(Duration::from_secs(60))).map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(DECISION + Duration::from_secs(10))).map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
    let mut writer = stream;
    write_line(&mut writer, &Hello { v: 1, offre: offer.clone() })?;
    progress("attente", 0, offer.size);
    let answer: Answer = read_line(&mut reader, 4096)
        .map_err(|e| if e.contains("répond") { "Pas de réponse : la personne n'a pas accepté à temps.".into() } else { e })?;
    if answer.reponse != "oui" {
        return Err("Le destinataire a refusé.".into());
    }
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    transfer::copy_exact(&mut file, &mut writer, offer.size, cancel, |done| progress("envoi", done, offer.size))?;
    writer.flush().map_err(|e| e.to_string())?;
    let done: Done = read_line(&mut reader, 4096)?;
    if done.fin != "ok" {
        return Err("Le destinataire n'a pas tout reçu.".into());
    }
    Ok(())
}

/// Connexion entrante : offre lue, décision de l'utilisateur (`decide`), archive reçue dans
/// `dest`. `Ok(None)` si l'envoi a été refusé.
pub fn serve(
    stream: TcpStream,
    decide: impl FnOnce(&Offer) -> bool,
    dest: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64, u64),
) -> Result<Option<Offer>, String> {
    stream.set_read_timeout(Some(Duration::from_secs(15))).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(Duration::from_secs(60))).map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
    let mut writer = stream;
    let hello: Hello = read_line(&mut reader, 16 * 1024)?;
    if hello.v != 1 {
        return Err("Version de Music Player trop différente.".into());
    }
    let offer = hello.offre;
    let accepted = offer.size <= MAX_SIZE && decide(&offer);
    write_line(&mut writer, &Answer { reponse: if accepted { "oui" } else { "non" }.into() })?;
    if !accepted {
        return Ok(None);
    }
    writer.set_read_timeout(Some(Duration::from_secs(60))).map_err(|e| e.to_string())?;
    let mut out = File::create(dest).map_err(|e| e.to_string())?;
    transfer::copy_exact(&mut reader, &mut out, offer.size, cancel, |done| progress(done, offer.size))?;
    out.flush().map_err(|e| e.to_string())?;
    write_line(&mut writer, &Done { fin: "ok".into() })?;
    Ok(Some(offer))
}

// ---------------------------------------------------------------------------------------
// Service de l'application : visible sur le réseau, réception des envois
// ---------------------------------------------------------------------------------------

struct Running {
    daemon: ServiceDaemon,
    fullname: String,
    name: String,
    stop: Arc<AtomicBool>,
}

static RUNNING: LazyLock<Mutex<Option<Running>>> = LazyLock::new(Default::default);
static ANSWERS: LazyLock<Mutex<HashMap<String, mpsc::Sender<bool>>>> = LazyLock::new(Default::default);

/// Identifiant de cet appareil (gardé dans le dossier de l'appli) : pour ne pas se voir
/// soi-même dans la liste des appareils.
pub fn device_id(data_dir: &Path) -> String {
    let path = data_dir.join("appareil.json");
    #[derive(Serialize, Deserialize)]
    struct Device {
        id: String,
    }
    if let Some(device) = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice::<Device>(&b).ok()) {
        return device.id;
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    if let Ok(json) = serde_json::to_vec(&Device { id: id.clone() }) {
        let _ = std::fs::write(path, json);
    }
    id
}

/// Offre reçue d'un appareil voisin, montrée à l'utilisateur pour qu'il accepte ou refuse.
#[derive(Clone, Serialize)]
struct IncomingOffer {
    id: String,
    offer: Offer,
}

/// Rend l'appareil visible sous le nom `name` et prêt à recevoir (relancé si le nom change).
pub fn start(app: &AppHandle, name: &str) -> Result<(), String> {
    let mut running = RUNNING.lock().unwrap();
    if running.as_ref().is_some_and(|r| r.name == name) {
        return Ok(());
    }
    if let Some(previous) = running.take() {
        shutdown(previous);
    }
    let listener = TcpListener::bind(("0.0.0.0", 0)).map_err(|e| e.to_string())?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let daemon = ServiceDaemon::new().map_err(|e| format!("Réseau local indisponible : {e}"))?;
    let id = device_id(&app.state::<AppState>().data_dir);
    let host = format!("mp-{}.local.", &id[..8]);
    let properties = [("id", id.as_str()), ("nom", name), ("v", "1")];
    let info = ServiceInfo::new(SERVICE, &format!("mp-{}", &id[..12]), &host, "", port, &properties[..])
        .map_err(|e| e.to_string())?
        .enable_addr_auto();
    let fullname = info.get_fullname().to_string();
    daemon.register(info).map_err(|e| e.to_string())?;
    let stop = Arc::new(AtomicBool::new(false));
    {
        let app = app.clone();
        let stop = stop.clone();
        std::thread::spawn(move || accept_loop(app, listener, stop));
    }
    *running = Some(Running { daemon, fullname, name: name.to_string(), stop });
    Ok(())
}

fn shutdown(running: Running) {
    running.stop.store(true, Ordering::SeqCst);
    let _ = running.daemon.unregister(&running.fullname);
    let _ = running.daemon.shutdown();
}

/// L'appareil n'est plus visible (réglage désactivé, appli en arrière-plan sur Android).
pub fn stop() {
    if let Some(running) = RUNNING.lock().unwrap().take() {
        shutdown(running);
    }
}

fn accept_loop(app: AppHandle, listener: TcpListener, stop: Arc<AtomicBool>) {
    while !stop.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                let _ = stream.set_nonblocking(false);
                let app = app.clone();
                std::thread::spawn(move || handle(app, stream));
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(250));
            }
            Err(_) => std::thread::sleep(Duration::from_millis(500)),
        }
    }
}

fn handle(app: AppHandle, stream: TcpStream) {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let Some(dir) = crate::commands::share_temp_dir(&app) else {
        return;
    };
    let dest = dir.join(format!("{id}.{}", crate::sharing::EXTENSION));
    let cancel = transfer::cancel_flag(&id);
    let result = serve(
        stream,
        |offer| {
            let (tx, rx) = mpsc::channel();
            ANSWERS.lock().unwrap().insert(id.clone(), tx);
            let _ = app.emit("nearby-offer", IncomingOffer { id: id.clone(), offer: offer.clone() });
            let accepted = rx.recv_timeout(DECISION).unwrap_or(false);
            ANSWERS.lock().unwrap().remove(&id);
            accepted
        },
        &dest,
        &cancel,
        |done, total| transfer::emit(&app, Progress::new(&id, "reception", done, total)),
    );
    let end = |stage, message: Option<String>| {
        let mut p = Progress::new(&id, stage, 0, 0);
        p.message = message;
        transfer::emit(&app, p);
    };
    match result {
        Ok(Some(offer)) => match transfer::import_received(&app, &dest) {
            Ok(_) => end("fini", Some(offer.name)),
            Err(e) => end("erreur", Some(e)),
        },
        Ok(None) => end("refuse", None),
        Err(e) => end("erreur", Some(e)),
    }
    transfer::forget(&id);
    let _ = std::fs::remove_file(&dest);
}

/// Réponse de l'utilisateur à une offre reçue.
pub fn answer(id: &str, accept: bool) {
    if let Some(tx) = ANSWERS.lock().unwrap().remove(id) {
        let _ = tx.send(accept);
    }
}

/// Appareils visibles sur le réseau, cherchés pendant `wait`.
pub fn scan(app: &AppHandle, wait: Duration) -> Result<Vec<Peer>, String> {
    let own = device_id(&app.state::<AppState>().data_dir);
    // Le service de l'appli s'il tourne, sinon un service le temps de la recherche.
    let temporary;
    let guard = RUNNING.lock().unwrap();
    let daemon = match guard.as_ref() {
        Some(running) => &running.daemon,
        None => {
            temporary = ServiceDaemon::new().map_err(|e| format!("Réseau local indisponible : {e}"))?;
            &temporary
        }
    };
    let events = daemon.browse(SERVICE).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + wait;
    let mut peers: Vec<Peer> = Vec::new();
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        let Ok(event) = events.recv_timeout(left) else { break };
        let ServiceEvent::ServiceResolved(info) = event else { continue };
        let Some(id) = info.txt_properties.get_property_val_str("id").map(str::to_string) else { continue };
        if id == own {
            continue;
        }
        let name = info.txt_properties.get_property_val_str("nom").unwrap_or("Appareil").to_string();
        let mut ips: Vec<std::net::IpAddr> = info.addresses.iter().map(|a| a.to_ip_addr()).collect();
        ips.sort_by_key(|ip| ip.is_ipv6());
        let addresses: Vec<String> = ips.into_iter().map(|ip| SocketAddr::new(ip, info.port).to_string()).collect();
        match peers.iter_mut().find(|p| p.id == id) {
            Some(peer) => {
                for a in addresses {
                    if !peer.addresses.contains(&a) {
                        peer.addresses.push(a);
                    }
                }
            }
            None => peers.push(Peer { id, name, addresses }),
        }
    }
    let _ = daemon.stop_browse(SERVICE);
    drop(guard);
    peers.sort_by_key(|p| p.name.to_lowercase());
    Ok(peers)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn offer(size: u64) -> Offer {
        Offer { from: "Téléphone de Lou".into(), kind: "track".into(), name: "Essai".into(), tracks: 1, size }
    }

    fn pair() -> (TcpListener, String) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap().to_string();
        (listener, address)
    }

    #[test]
    fn archive_is_sent_once_accepted() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("envoi.mpshare");
        let content: Vec<u8> = (0..600_000u32).map(|i| (i % 253) as u8).collect();
        std::fs::write(&source, &content).unwrap();
        let (listener, address) = pair();
        let dest = dir.path().join("recu.mpshare");
        let receiving = {
            let dest = dest.clone();
            std::thread::spawn(move || {
                let (stream, _) = listener.accept().unwrap();
                serve(stream, |o| o.from == "Téléphone de Lou", &dest, &AtomicBool::new(false), |_, _| {})
            })
        };
        let mut stages = Vec::new();
        send_to(&[address], &source, &offer(content.len() as u64), &AtomicBool::new(false), |s, _, _| {
            if stages.last() != Some(&s) {
                stages.push(s)
            }
        })
        .unwrap();
        assert_eq!(receiving.join().unwrap().unwrap(), Some(offer(content.len() as u64)));
        assert_eq!(stages, vec!["attente", "envoi"]);
        assert_eq!(std::fs::read(dest).unwrap(), content);
    }

    #[test]
    fn a_refusal_is_reported_and_nothing_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("envoi.mpshare");
        std::fs::write(&source, b"contenu").unwrap();
        let (listener, address) = pair();
        let dest = dir.path().join("recu.mpshare");
        let receiving = {
            let dest = dest.clone();
            std::thread::spawn(move || {
                let (stream, _) = listener.accept().unwrap();
                serve(stream, |_| false, &dest, &AtomicBool::new(false), |_, _| {})
            })
        };
        let err = send_to(&[address], &source, &offer(7), &AtomicBool::new(false), |_, _, _| {}).unwrap_err();
        assert!(err.contains("refusé"), "{err}");
        assert_eq!(receiving.join().unwrap().unwrap(), None);
        assert!(!dest.exists());
    }

    #[test]
    fn an_unreachable_device_gives_a_clear_message() {
        let (listener, address) = pair();
        drop(listener);
        let err = send_to(&[address], Path::new("x"), &offer(1), &AtomicBool::new(false), |_, _, _| {}).unwrap_err();
        assert!(err.contains("injoignable"), "{err}");
    }

    #[test]
    fn device_id_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let first = device_id(dir.path());
        assert_eq!(first.len(), 32);
        assert_eq!(device_id(dir.path()), first);
    }
}
