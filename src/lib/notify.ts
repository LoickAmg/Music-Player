// Notification du système (ordinateur et Android), après accord de l'utilisateur. Sans effet
// en mode démo du navigateur ou si l'autorisation est refusée.

export async function notify(title: string, body: string): Promise<boolean> {
  try {
    const { isPermissionGranted, requestPermission, sendNotification } = await import("@tauri-apps/plugin-notification");
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body });
    return granted;
  } catch {
    return false;
  }
}
