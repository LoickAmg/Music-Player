//! Personnalisation : réglages d'apparence (thèmes, couleurs, polices…) gardés tels quels
//! dans `appearance.json` (leur forme est décidée par l'interface), et fichiers importés
//! par l'utilisateur (polices, images de jaquettes, photo de profil) rangés dans `custom/`,
//! servis à l'interface par le protocole « asset ».

use std::path::{Path, PathBuf};

use serde_json::Value;

/// Extensions acceptées à l'import, par sorte de fichier.
const FONT_EXTENSIONS: &[&str] = &["ttf", "otf", "woff", "woff2"];
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif"];
/// Taille maximale d'un fichier importé (une police complète ou une photo raisonnable).
const MAX_ASSET_BYTES: usize = 25 * 1024 * 1024;

pub fn appearance_path(data_dir: &Path) -> PathBuf {
    data_dir.join("appearance.json")
}

pub fn custom_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("custom")
}

/// Réglages enregistrés, ou `Value::Null` (apparence par défaut).
pub fn load(data_dir: &Path) -> Value {
    std::fs::read(appearance_path(data_dir))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null)
}

pub fn save(data_dir: &Path, value: &Value) -> std::io::Result<()> {
    std::fs::create_dir_all(data_dir)?;
    let path = appearance_path(data_dir);
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
    std::fs::rename(tmp, path)
}

/// Range un fichier importé sous un nom neuf ; renvoie ce nom (sans dossier).
pub fn import(data_dir: &Path, kind: &str, ext: &str, bytes: &[u8]) -> Result<String, String> {
    let ext = ext.trim_start_matches('.').to_lowercase();
    let allowed = match kind {
        "font" => FONT_EXTENSIONS,
        "image" => IMAGE_EXTENSIONS,
        _ => return Err("Type de fichier inconnu.".into()),
    };
    if !allowed.contains(&ext.as_str()) {
        return Err(format!("Format « .{ext} » non pris en charge."));
    }
    if bytes.is_empty() {
        return Err("Fichier vide.".into());
    }
    if bytes.len() > MAX_ASSET_BYTES {
        return Err("Fichier trop volumineux (25 Mo au plus).".into());
    }
    let dir = custom_dir(data_dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = format!("{kind}-{}.{ext}", uuid::Uuid::new_v4().simple());
    std::fs::write(dir.join(&name), bytes).map_err(|e| e.to_string())?;
    Ok(name)
}

/// Supprime un fichier importé devenu inutile. Le nom doit être un simple nom de fichier
/// du dossier `custom/` (jamais un chemin).
pub fn remove(data_dir: &Path, name: &str) -> Result<(), String> {
    let valid = !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
        && !name.starts_with('.');
    if !valid {
        return Err("Nom de fichier invalide.".into());
    }
    match std::fs::remove_file(custom_dir(data_dir).join(name)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_roundtrip_and_default() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(dir.path()), Value::Null);
        let value = serde_json::json!({ "themeId": "oled", "fonts": { "ui": "inter" } });
        save(dir.path(), &value).unwrap();
        assert_eq!(load(dir.path()), value);
    }

    #[test]
    fn imports_only_known_formats_and_removes_safely() {
        let dir = tempfile::tempdir().unwrap();
        let name = import(dir.path(), "font", ".TTF", b"police").unwrap();
        assert!(name.starts_with("font-") && name.ends_with(".ttf"));
        assert!(custom_dir(dir.path()).join(&name).is_file());
        assert!(import(dir.path(), "font", "exe", b"x").is_err());
        assert!(import(dir.path(), "image", "png", b"").is_err());
        assert!(import(dir.path(), "autre", "png", b"x").is_err());
        assert!(remove(dir.path(), "../appearance.json").is_err());
        assert!(remove(dir.path(), "dossier/x.png").is_err());
        remove(dir.path(), &name).unwrap();
        assert!(!custom_dir(dir.path()).join(&name).exists());
        // Déjà supprimé : pas une erreur.
        remove(dir.path(), &name).unwrap();
    }
}
