//! Icône de l'application partout sous Windows : pas seulement la fenêtre ouverte, mais aussi
//! les raccourcis du menu Démarrer, du Bureau et de la barre des tâches (épinglés).
//!
//! Ces raccourcis pointent par défaut sur l'icône du `.exe`. On fabrique un vrai fichier
//! `.ico` (plusieurs tailles, pour rester net partout) à partir de l'icône choisie, on fait
//! pointer les raccourcis de l'appli dessus, puis on demande à l'Explorateur de redessiner.
//! « origine » remet l'icône du `.exe`.
//!
//! L'installateur recrée les raccourcis à chaque mise à jour : un petit fichier témoin
//! (icône voulue + date du `.exe`) permet de réappliquer le choix au lancement suivant, sans
//! refaire le travail à chaque démarrage.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Tailles d'icône que Windows utilise (listes, menu Démarrer, Bureau, barre des tâches, Alt+Tab).
const SIZES: [u32; 7] = [16, 24, 32, 48, 64, 128, 256];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Marker {
    /// Chemin du `.ico` appliqué, ou « origine ».
    icon: String,
    /// Date de modification du `.exe` (secondes) : change à chaque mise à jour.
    exe_stamp: u64,
}

/// Petite empreinte (FNV-1a) : le nom du fichier change avec l'image, ce qui oblige
/// l'Explorateur à relire l'icône au lieu de garder l'ancienne en cache.
fn fingerprint(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

/// Fabrique un `.ico` multi-tailles à partir d'un PNG (carré ou non : il est centré).
pub fn png_to_ico(png: &[u8]) -> Result<Vec<u8>, String> {
    use image::codecs::ico::{IcoEncoder, IcoFrame};
    use image::{imageops::FilterType, ExtendedColorType, ImageFormat};

    let source = image::load_from_memory_with_format(png, ImageFormat::Png).map_err(|e| format!("Image illisible : {e}"))?;
    let side = source.width().max(source.height());
    let mut square = image::RgbaImage::new(side, side);
    image::imageops::overlay(
        &mut square,
        &source.to_rgba8(),
        ((side - source.width()) / 2) as i64,
        ((side - source.height()) / 2) as i64,
    );
    let frames = SIZES
        .iter()
        .map(|&size| {
            let resized = image::imageops::resize(&square, size, size, FilterType::Lanczos3);
            IcoFrame::as_png(resized.as_raw(), size, size, ExtendedColorType::Rgba8).map_err(|e| e.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut out = Vec::new();
    IcoEncoder::new(&mut out).encode_images(&frames).map_err(|e| e.to_string())?;
    Ok(out)
}

/// Applique l'icône aux raccourcis de l'appli. `png` absent : icône d'origine du `.exe`.
/// Ne fait rien si c'est déjà fait pour ce `.exe` (sauf `force`). Renvoie le nombre de
/// raccourcis concernés (`None` si rien n'était à faire).
pub fn sync(png: Option<&[u8]>, icons_dir: &Path, force: bool) -> Result<Option<usize>, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_stamp = std::fs::metadata(&exe)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs());
    let marker_path = icons_dir.join("raccourcis.json");
    let previous: Option<Marker> = std::fs::read(&marker_path).ok().and_then(|b| serde_json::from_slice(&b).ok());

    let (icon_file, location) = match png {
        Some(png) => {
            std::fs::create_dir_all(icons_dir).map_err(|e| e.to_string())?;
            let path = icons_dir.join(format!("icone-{}.ico", fingerprint(png)));
            if !path.exists() {
                std::fs::write(&path, png_to_ico(png)?).map_err(|e| e.to_string())?;
            }
            let location = format!("{},0", path.display());
            (Some(path), location)
        }
        None => (None, format!("{},0", exe.display())),
    };
    let wanted = Marker {
        icon: icon_file.as_ref().map_or_else(|| "origine".to_string(), |p| p.display().to_string()),
        exe_stamp,
    };
    // Jamais changée et toujours d'origine : rien à rétablir.
    if !force && (previous.as_ref() == Some(&wanted) || (previous.is_none() && icon_file.is_none())) {
        return Ok(None);
    }

    let count = update_shortcuts(&exe, &location)?;
    std::fs::create_dir_all(icons_dir).ok();
    std::fs::write(&marker_path, serde_json::to_vec(&wanted).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    remove_old_icons(icons_dir, icon_file.as_deref());
    Ok(Some(count))
}

fn remove_old_icons(dir: &Path, keep: Option<&Path>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_icon = path.extension().is_some_and(|e| e == "ico") && path.file_name().is_some_and(|n| n.to_string_lossy().starts_with("icone-"));
        if is_icon && Some(path.as_path()) != keep {
            std::fs::remove_file(path).ok();
        }
    }
}

#[cfg(windows)]
fn update_shortcuts(exe: &Path, location: &str) -> Result<usize, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    // Les chemins passent par l'environnement : aucun souci de guillemets ni d'accents.
    // Seuls les raccourcis qui lancent CE programme sont modifiés.
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
$exe = [IO.Path]::GetFullPath($env:MP_EXE)
$icon = $env:MP_ICON
$shell = New-Object -ComObject WScript.Shell
$dirs = @(
  [Environment]::GetFolderPath('Programs'),
  [Environment]::GetFolderPath('Desktop'),
  (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'),
  (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\StartMenu')
)
$count = 0
foreach ($dir in $dirs) {
  if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { continue }
  Get-ChildItem -LiteralPath $dir -Filter *.lnk -Recurse -Depth 2 | ForEach-Object {
    $link = $shell.CreateShortcut($_.FullName)
    if ($link.TargetPath -and ([IO.Path]::GetFullPath($link.TargetPath) -ieq $exe)) {
      if ($link.IconLocation -ne $icon) { $link.IconLocation = $icon; $link.Save() }
      $count++
    }
  }
}
Write-Output $count
"#;
    let output = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT])
        .env("MP_EXE", exe)
        .env("MP_ICON", location)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Impossible de modifier les raccourcis : {e}"))?;
    let count = String::from_utf8_lossy(&output.stdout).trim().parse::<usize>().unwrap_or(0);
    refresh_shell_icons();
    Ok(count)
}

/// Demande à l'Explorateur de redessiner les icônes (sans redémarrer la session).
#[cfg(windows)]
fn refresh_shell_icons() {
    use windows_sys::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
    unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED as i32, SHCNF_IDLIST, std::ptr::null(), std::ptr::null()) };
}

#[cfg(not(windows))]
fn update_shortcuts(_exe: &Path, _location: &str) -> Result<usize, String> {
    Ok(0)
}

pub fn icons_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("icone-appli")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_png() -> Vec<u8> {
        let img = image::RgbaImage::from_pixel(64, 40, image::Rgba([200, 50, 120, 255]));
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(img).write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
        png
    }

    #[test]
    fn builds_a_multi_size_ico_from_a_png() {
        let ico = png_to_ico(&sample_png()).unwrap();
        // En-tête ICO : réservé 0, type 1, nombre d'images.
        assert_eq!(&ico[0..4], &[0, 0, 1, 0]);
        assert_eq!(u16::from_le_bytes([ico[4], ico[5]]) as usize, SIZES.len());
    }

    #[test]
    fn same_image_same_file_name() {
        assert_eq!(fingerprint(b"abc"), fingerprint(b"abc"));
        assert_ne!(fingerprint(b"abc"), fingerprint(b"abd"));
    }

    #[test]
    fn untouched_original_icon_does_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(sync(None, dir.path(), false).unwrap(), None);
        assert!(!dir.path().join("raccourcis.json").exists());
    }
}
