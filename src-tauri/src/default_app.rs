//! Music Player comme lecteur par défaut sur ordinateur : fichier audio (ou archive de
//! partage) reçu au lancement ou transmis à l'instance déjà ouverte, et inscription auprès
//! de Windows (Paramètres → Applications par défaut), où la personne choisit l'appli.

use std::path::Path;
use std::sync::Mutex;

/// Formats proposés à Windows (les plus courants ; les autres restent lisibles par « Ouvrir »).
#[cfg_attr(not(windows), allow(dead_code))]
const ASSOCIATED: &[&str] = &[
    "mp3", "flac", "m4a", "aac", "ogg", "oga", "opus", "wav", "wma", "aif", "aiff", "alac", "mka",
];

/// Fichier à ouvrir parmi les arguments du lancement (le premier est l'exécutable).
pub fn file_from_args<S: AsRef<str>>(args: &[S]) -> Option<String> {
    args.iter().skip(1).map(|a| a.as_ref()).find_map(|arg| {
        let path = Path::new(arg);
        let wanted = crate::ffmpeg::is_native(path)
            || crate::ffmpeg::needs_ffmpeg(path)
            || crate::ffmpeg::extension_of(path) == crate::sharing::EXTENSION;
        (wanted && path.is_file()).then(|| arg.to_string())
    })
}

/// Fichier reçu au lancement, en attente que l'interface soit prête à le lire.
static PENDING: Mutex<Option<String>> = Mutex::new(None);

pub fn set_pending(path: Option<String>) {
    *PENDING.lock().unwrap() = path;
}

pub fn take_pending() -> Option<String> {
    PENDING.lock().unwrap().take()
}

/// Inscrit l'appli auprès de Windows (compte courant, sans droits administrateur) puis ouvre
/// sa page dans « Applications par défaut ».
#[cfg(windows)]
pub fn register_and_open_settings() -> Result<(), String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    const PROG_ID: &str = "MusicPlayer.Audio";
    const APP: &str = "Music Player";
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = exe.to_string_lossy();
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let err = |e: std::io::Error| format!("Inscription auprès de Windows impossible : {e}");

    let (prog, _) = hkcu.create_subkey(format!(r"Software\Classes\{PROG_ID}")).map_err(err)?;
    prog.set_value("", &"Fichier audio").map_err(err)?;
    prog.create_subkey("DefaultIcon").map_err(err)?.0.set_value("", &format!("\"{exe}\",0")).map_err(err)?;
    prog.create_subkey(r"shell\open\command")
        .map_err(err)?
        .0
        .set_value("", &format!("\"{exe}\" \"%1\""))
        .map_err(err)?;

    let caps_path = format!(r"Software\Clients\Media\{APP}\Capabilities");
    let (caps, _) = hkcu.create_subkey(&caps_path).map_err(err)?;
    caps.set_value("ApplicationName", &APP).map_err(err)?;
    caps.set_value("ApplicationDescription", &"Lecteur de musique local avec paroles synchronisées").map_err(err)?;
    let (assoc, _) = caps.create_subkey("FileAssociations").map_err(err)?;
    for ext in ASSOCIATED {
        assoc.set_value(format!(".{ext}"), &PROG_ID).map_err(err)?;
        // « Ouvrir avec » propose l'appli pour ce format.
        hkcu.create_subkey(format!(r"Software\Classes\.{ext}\OpenWithProgids"))
            .map_err(err)?
            .0
            .set_value(PROG_ID, &"")
            .map_err(err)?;
    }
    hkcu.create_subkey(r"Software\RegisteredApplications")
        .map_err(err)?
        .0
        .set_value(APP, &caps_path)
        .map_err(err)?;

    // L'Explorateur relit les associations.
    unsafe {
        use windows_sys::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
        SHChangeNotify(SHCNE_ASSOCCHANGED as i32, SHCNF_IDLIST, std::ptr::null(), std::ptr::null());
    }
    let settings = format!("ms-settings:defaultapps?registeredAppUser={}", APP.replace(' ', "%20"));
    std::process::Command::new("explorer")
        .arg(settings)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(not(windows))]
pub fn register_and_open_settings() -> Result<(), String> {
    Err("Réglage disponible sur Windows et Android.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_audio_file_among_launch_arguments() {
        let dir = tempfile::tempdir().unwrap();
        let song = dir.path().join("Chanson.flac");
        std::fs::write(&song, b"x").unwrap();
        let song = song.to_string_lossy().to_string();
        assert_eq!(file_from_args(&["app.exe", "--flag", &song]), Some(song.clone()));
        assert_eq!(file_from_args(&["app.exe"]), None);
        assert_eq!(file_from_args(&["app.exe", "C:/nulle/part.mp3"]), None);
        let text = dir.path().join("notes.txt");
        std::fs::write(&text, b"x").unwrap();
        assert_eq!(file_from_args(&["app.exe", &text.to_string_lossy()]), None);
    }
}
