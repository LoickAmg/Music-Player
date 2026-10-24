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
use crate::transfer::{self, Failure, Offer, Progress, MAX_SIZE};

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
    /// Code d'ami (Proches), quand l'appareil l'a activé : « Ajouter » sans le saisir.
    #[serde(default)]
    pub code: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Hello {
    v: u32,
    offre: Offer,
}

#[derive(Serialize, Deserialize)]
struct Answer {
    reponse: String,
    /// Octets déjà reçus lors d'un essai précédent du même envoi (reprise).
    #[serde(default)]
    depuis: u64,
}

/// Décision sur un envoi reçu : refusé, ou accepté (fichier où écrire, et position de reprise
/// si une partie a déjà été reçue).
pub enum Decision {
    Refuse,
    Accept { dest: std::path::PathBuf, from: u64 },
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

/// Un essai d'envoi : connexion, accord (ou reprise), données depuis la position annoncée.
fn send_once(
    addresses: &[String],
    path: &Path,
    offer: &Offer,
    cancel: &AtomicBool,
    accepted: &mut bool,
    progress: &mut impl FnMut(&'static str, u64, u64),
) -> Result<(), Failure> {
    let lost = |e: String| if *accepted { Failure::Retry(e) } else { Failure::Final(e) };
    let stream = addresses
        .iter()
        .filter_map(|a| a.parse::<SocketAddr>().ok())
        .find_map(|addr| TcpStream::connect_timeout(&addr, Duration::from_secs(4)).ok())
        .ok_or_else(|| lost("Appareil injoignable : il a peut-être quitté le réseau ou fermé Music Player.".into()))?;
    let setup = |s: &TcpStream| -> std::io::Result<()> {
        s.set_write_timeout(Some(Duration::from_secs(60)))?;
        s.set_read_timeout(Some(DECISION + Duration::from_secs(10)))
    };
    setup(&stream).map_err(|e| lost(e.to_string()))?;
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| lost(e.to_string()))?);
    let mut writer = stream;
    write_line(&mut writer, &Hello { v: 1, offre: offer.clone() }).map_err(lost)?;
    if !*accepted {
        progress("attente", 0, offer.size);
    }
    let answer: Answer = read_line(&mut reader, 4096).map_err(|e| {
        if !*accepted && e.contains("répond") {
            Failure::Final("Pas de réponse : la personne n'a pas accepté à temps.".into())
        } else {
            lost(e)
        }
    })?;
    if answer.reponse != "oui" || answer.depuis > offer.size {
        return Err(Failure::Final("Le destinataire a refusé.".into()));
    }
    *accepted = true;
    let from = answer.depuis;
    let mut file = File::open(path).map_err(|e| Failure::Final(e.to_string()))?;
    std::io::Seek::seek(&mut file, std::io::SeekFrom::Start(from)).map_err(|e| Failure::Final(e.to_string()))?;
    progress("envoi", from, offer.size);
    transfer::copy_exact(&mut file, &mut writer, offer.size - from, cancel, |done| progress("envoi", from + done, offer.size))
        .map_err(|e| if e.contains("annulé") { Failure::Final(e) } else { Failure::Retry(e) })?;
    writer.flush().map_err(|e| Failure::Retry(e.to_string()))?;
    let done: Done = read_line(&mut reader, 4096).map_err(Failure::Retry)?;
    if done.fin != "ok" {
        return Err(Failure::Retry("Le destinataire n'a pas tout reçu.".into()));
    }
    Ok(())
}

/// Envoie l'archive `path` au premier appareil joignable parmi `addresses`. Après une coupure
/// (Wi-Fi qui décroche, appli mise en veille), se reconnecte et reprend où le destinataire en
/// était. `progress(étape, fait, total)` : « attente » (de l'accord), « envoi », « reprise »
/// (essai, essais permis).
pub fn send_to(
    addresses: &[String],
    path: &Path,
    offer: &Offer,
    cancel: &AtomicBool,
    mut progress: impl FnMut(&'static str, u64, u64),
) -> Result<(), String> {
    let mut accepted = false;
    let mut attempt = 0;
    loop {
        match send_once(addresses, path, offer, cancel, &mut accepted, &mut progress) {
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

/// Connexion entrante : offre lue, décision (`decide` : accord de l'utilisateur, ou reprise
/// d'un envoi déjà accepté), archive reçue. `Ok(None)` si l'envoi a été refusé ; sinon l'offre
/// et le fichier écrit.
pub fn serve(
    stream: TcpStream,
    decide: impl FnOnce(&Offer) -> Decision,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64, u64),
) -> Result<Option<(Offer, std::path::PathBuf)>, String> {
    stream.set_read_timeout(Some(Duration::from_secs(15))).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(Duration::from_secs(60))).map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
    let mut writer = stream;
    let hello: Hello = read_line(&mut reader, 16 * 1024)?;
    if hello.v != 1 {
        return Err("Version de Music Player trop différente.".into());
    }
    let offer = hello.offre;
    let decision = if offer.size <= MAX_SIZE { decide(&offer) } else { Decision::Refuse };
    let Decision::Accept { dest, from } = decision else {
        write_line(&mut writer, &Answer { reponse: "non".into(), depuis: 0 })?;
        return Ok(None);
    };
    let from = from.min(offer.size);
    let mut out = if from > 0 {
        std::fs::OpenOptions::new().write(true).open(&dest).and_then(|f| {
            f.set_len(from)?;
            Ok(f)
        })
    } else {
        File::create(&dest)
    }
    .map_err(|e| e.to_string())?;
    std::io::Seek::seek(&mut out, std::io::SeekFrom::Start(from)).map_err(|e| e.to_string())?;
    write_line(&mut writer, &Answer { reponse: "oui".into(), depuis: from })?;
    writer.set_read_timeout(Some(Duration::from_secs(60))).map_err(|e| e.to_string())?;
    progress(from, offer.size);
    transfer::copy_exact(&mut reader, &mut out, offer.size - from, cancel, |done| progress(from + done, offer.size))?;
    out.flush().map_err(|e| e.to_string())?;
    write_line(&mut writer, &Done { fin: "ok".into() })?;
    Ok(Some((offer, dest)))
}

// ---------------------------------------------------------------------------------------
// Service de l'application : visible sur le réseau, réception des envois
// ---------------------------------------------------------------------------------------

struct Running {
    daemon: ServiceDaemon,
    fullname: String,
    name: String,
    code: Option<String>,
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

/// Rend l'appareil visible sous le nom `name` (avec son code d'ami s'il en a un) et prêt à
/// recevoir ; relancé si le nom ou le code change.
pub fn start(app: &AppHandle, name: &str, code: Option<&str>) -> Result<(), String> {
    let mut running = RUNNING.lock().unwrap();
    if running.as_ref().is_some_and(|r| r.name == name && r.code.as_deref() == code) {
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
    let mut properties = vec![("id", id.as_str()), ("nom", name), ("v", "1")];
    if let Some(code) = code {
        properties.push(("ami", code));
    }
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
    *running = Some(Running { daemon, fullname, name: name.to_string(), code: code.map(str::to_string), stop });
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

/// Réceptions interrompues, par identifiant d'envoi : identifiant montré à l'interface et
/// fichier partiel. L'expéditeur qui se reconnecte reprend là, sans redemander l'accord.
static PARTIALS: LazyLock<Mutex<HashMap<String, (String, std::path::PathBuf)>>> = LazyLock::new(Default::default);

fn handle(app: AppHandle, stream: TcpStream) {
    let Some(dir) = crate::commands::share_temp_dir(&app) else {
        return;
    };
    // Identifiant du transfert pour l'interface : nouveau, ou celui de l'envoi repris.
    let id = std::cell::RefCell::new(uuid::Uuid::new_v4().simple().to_string());
    let cancel = Arc::new(AtomicBool::new(false));
    let mut resumed_offer: Option<String> = None;
    let result = serve(
        stream,
        |offer| {
            if let Some((known, path)) = PARTIALS.lock().unwrap().get(&offer.id).cloned() {
                *id.borrow_mut() = known;
                transfer::link_cancel(&id.borrow(), cancel.clone());
                resumed_offer = Some(offer.id.clone());
                let from = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                return Decision::Accept { dest: path, from };
            }
            let id = id.borrow().clone();
            let (tx, rx) = mpsc::channel();
            ANSWERS.lock().unwrap().insert(id.clone(), tx);
            let _ = app.emit("nearby-offer", IncomingOffer { id: id.clone(), offer: offer.clone() });
            let accepted = rx.recv_timeout(DECISION).unwrap_or(false);
            ANSWERS.lock().unwrap().remove(&id);
            if !accepted {
                return Decision::Refuse;
            }
            transfer::link_cancel(&id, cancel.clone());
            let dest = dir.join(format!("{id}.{}", crate::sharing::EXTENSION));
            if !offer.id.is_empty() {
                PARTIALS.lock().unwrap().insert(offer.id.clone(), (id, dest.clone()));
                resumed_offer = Some(offer.id.clone());
            }
            Decision::Accept { dest, from: 0 }
        },
        &cancel,
        |done, total| transfer::emit(&app, Progress::new(&id.borrow(), "reception", done, total)),
    );
    let id = id.into_inner();
    let end = |stage, message: Option<String>| {
        let mut p = Progress::new(&id, stage, 0, 0);
        p.message = message;
        transfer::emit(&app, p);
    };
    let forget_partial = || {
        if let Some(offer_id) = &resumed_offer {
            PARTIALS.lock().unwrap().remove(offer_id);
        }
    };
    match result {
        Ok(Some((offer, dest))) => {
            forget_partial();
            match transfer::import_received(&app, &dest) {
                Ok(_) => end("fini", Some(offer.name)),
                Err(e) => end("erreur", Some(e)),
            }
            transfer::forget(&id);
        }
        Ok(None) => {
            end("refuse", None);
            transfer::forget(&id);
        }
        Err(e) if e.contains("annulé") => {
            forget_partial();
            end("erreur", Some(e));
            transfer::forget(&id);
        }
        // Coupure : le fichier partiel est gardé, l'expéditeur va se reconnecter.
        Err(_) if resumed_offer.is_some() => {
            let mut p = Progress::new(&id, "reprise", 0, 0);
            p.message = Some("Connexion perdue : reprise dès que l'expéditeur se reconnecte…".into());
            transfer::emit(&app, p);
        }
        Err(e) => end("erreur", Some(e)),
    }
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
        let code = info.txt_properties.get_property_val_str("ami").map(str::to_string);
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
            None => peers.push(Peer { id, name, addresses, code }),
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
        Offer { id: "envoi-1".into(), from: "Téléphone de Lou".into(), kind: "track".into(), name: "Essai".into(), tracks: 1, size, acks: true }
    }

    #[test]
    fn a_cut_transfer_resumes_without_asking_again() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("envoi.mpshare");
        let content: Vec<u8> = (0..1_200_000u32).map(|i| (i % 239) as u8).collect();
        std::fs::write(&source, &content).unwrap();
        let (listener, address) = pair();
        let dest = dir.path().join("recu.mpshare");
        let receiving = {
            let dest = dest.clone();
            std::thread::spawn(move || {
                // Première liaison coupée après 400 Ko environ.
                let cut = AtomicBool::new(false);
                let (first, _) = listener.accept().unwrap();
                let interrupted = serve(first, |_| Decision::Accept { dest: dest.clone(), from: 0 }, &cut, |done, _| {
                    if done >= 400_000 {
                        cut.store(true, Ordering::SeqCst);
                    }
                });
                assert!(interrupted.is_err());
                let partial = std::fs::metadata(&dest).unwrap().len();
                // Reprise : pas de nouvelle question, on repart de ce qui est déjà là.
                let (second, _) = listener.accept().unwrap();
                let resumed = serve(second, |_| Decision::Accept { dest: dest.clone(), from: partial }, &AtomicBool::new(false), |_, _| {});
                (resumed, partial)
            })
        };
        let mut stages = Vec::new();
        send_to(&[address], &source, &offer(content.len() as u64), &AtomicBool::new(false), |s, _, _| {
            if stages.last() != Some(&s) {
                stages.push(s)
            }
        })
        .unwrap();
        let (resumed, partial) = receiving.join().unwrap();
        assert!(resumed.unwrap().is_some());
        assert!(partial >= 400_000 && partial < content.len() as u64, "{partial}");
        assert!(stages.contains(&"reprise"), "{stages:?}");
        assert_eq!(std::fs::read(dest).unwrap(), content);
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
                serve(
                    stream,
                    |o| if o.from == "Téléphone de Lou" { Decision::Accept { dest, from: 0 } } else { Decision::Refuse },
                    &AtomicBool::new(false),
                    |_, _| {},
                )
            })
        };
        let mut stages = Vec::new();
        send_to(&[address], &source, &offer(content.len() as u64), &AtomicBool::new(false), |s, _, _| {
            if stages.last() != Some(&s) {
                stages.push(s)
            }
        })
        .unwrap();
        assert_eq!(receiving.join().unwrap().unwrap().map(|(o, _)| o), Some(offer(content.len() as u64)));
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
        let receiving = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            serve(stream, |_| Decision::Refuse, &AtomicBool::new(false), |_, _| {})
        });
        let err = send_to(&[address], &source, &offer(7), &AtomicBool::new(false), |_, _, _| {}).unwrap_err();
        assert!(err.contains("refusé"), "{err}");
        assert!(receiving.join().unwrap().unwrap().is_none());
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
