//! Lance un programme externe avec un délai maximal et un arrêt possible (spotDL) : un
//! téléchargement bloqué ne bloque plus tout le lot, et la personne peut tout arrêter.

use std::io::Read;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// Issue d'un lancement borné. Les sorties sont gardées dans tous les cas (diagnostic).
#[derive(Debug)]
pub enum Bounded {
    Finished { status: ExitStatus, stdout: String, stderr: String },
    TimedOut { stdout: String, stderr: String },
    Cancelled { stdout: String, stderr: String },
}

fn drain(mut pipe: impl Read + Send + 'static) -> JoinHandle<String> {
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = pipe.read_to_end(&mut bytes);
        String::from_utf8_lossy(&bytes).into_owned()
    })
}

/// Arrête le programme et tout ce qu'il a lancé (`py` lance Python, qui lance ffmpeg…) : sinon
/// les petits-enfants gardent les sorties ouvertes et l'arrêt attendrait leur fin.
fn stop(child: &mut Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(unix)]
    {
        // Le programme a son propre groupe (voir `run`) : on arrête le groupe entier.
        let _ = Command::new("kill")
            .args(["-KILL", "--", &format!("-{}", child.id())])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Lance `command` ; l'arrête s'il dépasse `limit` ou si `cancel` passe à vrai. Les sorties sont
/// lues pendant l'exécution (un journal bavard ne peut pas bloquer le programme).
pub fn run(command: &mut Command, limit: Duration, cancel: &AtomicBool) -> std::io::Result<Bounded> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let out = drain(child.stdout.take().expect("sortie redirigée"));
    let err = drain(child.stderr.take().expect("erreurs redirigées"));
    let started = Instant::now();
    let outcome = loop {
        if let Some(status) = child.try_wait()? {
            break Ok(status);
        }
        if cancel.load(Ordering::SeqCst) {
            stop(&mut child);
            break Err(true);
        }
        if started.elapsed() >= limit {
            stop(&mut child);
            break Err(false);
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let stdout = out.join().unwrap_or_default();
    let stderr = err.join().unwrap_or_default();
    Ok(match outcome {
        Ok(status) => Bounded::Finished { status, stdout, stderr },
        Err(true) => Bounded::Cancelled { stdout, stderr },
        Err(false) => Bounded::TimedOut { stdout, stderr },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn long_command() -> Command {
        if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.args(["/C", "echo debut && ping -n 30 127.0.0.1 > NUL"]);
            c
        } else {
            let mut c = Command::new("sh");
            c.args(["-c", "echo debut; sleep 30"]);
            c
        }
    }

    #[test]
    fn a_stuck_program_is_stopped_after_the_limit() {
        let start = Instant::now();
        let result = run(&mut long_command(), Duration::from_millis(600), &AtomicBool::new(false)).unwrap();
        assert!(matches!(result, Bounded::TimedOut { ref stdout, .. } if stdout.contains("debut")), "{result:?}");
        assert!(start.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn cancelling_stops_the_program_at_once() {
        let cancel = AtomicBool::new(true);
        let result = run(&mut long_command(), Duration::from_secs(60), &cancel).unwrap();
        assert!(matches!(result, Bounded::Cancelled { .. }));
    }

    #[test]
    fn a_quick_program_finishes_normally() {
        let mut c = if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.args(["/C", "echo bonjour"]);
            c
        } else {
            let mut c = Command::new("sh");
            c.args(["-c", "echo bonjour"]);
            c
        };
        let result = run(&mut c, Duration::from_secs(20), &AtomicBool::new(false)).unwrap();
        assert!(matches!(result, Bounded::Finished { ref status, ref stdout, .. } if status.success() && stdout.contains("bonjour")));
    }
}
