//! Mise à jour automatique (ordinateur) : l'application consulte le fichier `latest.json`
//! de la dernière version GitHub, vérifie la signature de l'installateur avec la clé
//! publique de `tauri.conf.json`, l'installe puis redémarre.
//! Sur Android : la liste des versions GitHub donne la plus récente qui contient un APK ;
//! l'interface le fait télécharger et installer par l'activité Android (même signature,
//! donc installation par-dessus).

use serde::Serialize;
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub current: String,
    pub notes: Option<String>,
    /// Android : adresse de l'APK à télécharger.
    pub url: Option<String>,
}

/// « 0.4.10 » → (0, 4, 10), pour comparer les versions.
fn version_key(v: &str) -> Vec<u64> {
    v.trim_start_matches(['v', 'V'])
        .split(['.', '-'])
        .map_while(|p| p.parse().ok())
        .collect()
}

/// Version la plus récente publiée sur GitHub avec un APK, si elle est plus récente que
/// `current`. Les versions sont triées par numéro (et non par date de publication).
pub fn newest_apk(releases: &serde_json::Value, current: &str) -> Option<UpdateInfo> {
    let mut best: Option<(Vec<u64>, UpdateInfo)> = None;
    for release in releases.as_array()? {
        if release["draft"].as_bool() == Some(true) || release["prerelease"].as_bool() == Some(true)
        {
            continue;
        }
        let tag = release["tag_name"].as_str().unwrap_or("");
        let version = tag
            .trim_start_matches("app-v")
            .trim_start_matches('v')
            .to_string();
        let Some(url) = release["assets"].as_array().and_then(|assets| {
            assets
                .iter()
                .find(|a| a["name"].as_str().is_some_and(|n| n.ends_with(".apk")))
                .and_then(|a| a["browser_download_url"].as_str())
        }) else {
            continue;
        };
        let key = version_key(&version);
        if key <= version_key(current) || best.as_ref().is_some_and(|(k, _)| *k >= key) {
            continue;
        }
        best = Some((
            key,
            UpdateInfo {
                version,
                current: current.to_string(),
                notes: release["body"].as_str().map(str::to_string),
                url: Some(url.to_string()),
            },
        ));
    }
    best.map(|(_, info)| info)
}

// Compilé partout (vérifié à chaque build), utilisé seulement sur téléphone.
#[cfg_attr(desktop, allow(dead_code))]
fn android_update(current: &str) -> Result<Option<UpdateInfo>, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(10)))
        .build()
        .into();
    let releases: serde_json::Value = agent
        .get("https://api.github.com/repos/LoickAmg/Music-Player/releases?per_page=15")
        .header("User-Agent", "MusicPlayer")
        .header("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| format!("Vérification impossible : {e}"))?
        .body_mut()
        .read_json()
        .map_err(|e| format!("Vérification impossible : {e}"))?;
    Ok(newest_apk(&releases, current))
}

#[cfg(desktop)]
async fn find(app: &AppHandle) -> Result<Option<tauri_plugin_updater::Update>, String> {
    use tauri_plugin_updater::UpdaterExt;
    app.updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| format!("Vérification impossible : {e}"))
}

/// Version plus récente disponible, ou `None` si l'application est à jour.
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    #[cfg(desktop)]
    {
        Ok(find(&app).await?.map(|u| UpdateInfo {
            version: u.version.clone(),
            current: u.current_version.clone(),
            notes: u.body.clone(),
            url: None,
        }))
    }
    #[cfg(mobile)]
    {
        let current = app.package_info().version.to_string();
        tauri::async_runtime::spawn_blocking(move || android_update(&current))
            .await
            .map_err(|e| e.to_string())?
    }
}

/// Télécharge et installe la mise à jour (progression : événement « update-progress »,
/// octets reçus et taille totale), puis relance l'application.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use tauri::{Emitter, Manager};
        let update = find(&app).await?.ok_or("L'application est déjà à jour.")?;
        // L'installateur ferme l'application : on garde d'abord piste, position et réglages.
        {
            let state = app.state::<crate::state::AppState>();
            let _ = crate::commands::persist_session(&state);
        }
        let handle = app.clone();
        let mut received = 0u64;
        update
            .download_and_install(
                move |chunk, total| {
                    received += chunk as u64;
                    let _ = handle.emit("update-progress", (received, total));
                },
                || {},
            )
            .await
            .map_err(|e| format!("Mise à jour impossible : {e}"))?;
        app.restart();
    }
    #[cfg(mobile)]
    {
        let _ = app;
        Err("Mise à jour automatique indisponible sur téléphone.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_newest_release_with_an_apk() {
        let releases = serde_json::json!([
            { "tag_name": "app-v0.4.3", "assets": [{ "name": "Music.Player_0.4.3_amd64.deb", "browser_download_url": "x" }] },
            { "tag_name": "app-v0.4.3", "body": "notes", "assets": [{ "name": "Music-Player-android.apk", "browser_download_url": "https://a/0.4.3.apk" }] },
            { "tag_name": "app-v0.4.10", "draft": true, "assets": [{ "name": "a.apk", "browser_download_url": "draft" }] },
            { "tag_name": "app-v0.4.2", "assets": [{ "name": "Music-Player-android.apk", "browser_download_url": "https://a/0.4.2.apk" }] }
        ]);
        let found = newest_apk(&releases, "0.4.2").unwrap();
        assert_eq!(found.version, "0.4.3");
        assert_eq!(found.url.as_deref(), Some("https://a/0.4.3.apk"));
        assert!(newest_apk(&releases, "0.4.3").is_none());
        assert!(version_key("0.4.10") > version_key("0.4.9"));
    }

    /// Interroge vraiment GitHub : `cargo test -- --ignored github`.
    #[test]
    #[ignore]
    fn github_has_an_apk_newer_than_0_4_2() {
        let found = android_update("0.4.2").unwrap().unwrap();
        println!("{} {:?}", found.version, found.url);
        assert!(found.url.unwrap().ends_with(".apk"));
    }
}
