//! Mise à jour automatique (ordinateur) : l'application consulte le fichier `latest.json`
//! de la dernière version GitHub, vérifie la signature de l'installateur avec la clé
//! publique de `tauri.conf.json`, l'installe puis redémarre. Sans objet sur téléphone
//! (l'APK se met à jour par-dessus, avec la même signature).

use serde::Serialize;
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub current: String,
    pub notes: Option<String>,
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
        }))
    }
    #[cfg(mobile)]
    {
        let _ = app;
        Ok(None)
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
