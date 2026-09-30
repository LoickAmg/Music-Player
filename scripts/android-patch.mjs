// Complète le projet Android généré par `tauri android init` (src-tauri/gen/android) :
// permissions de lecture de la musique du téléphone et demande de permission au lancement.
// Lancé par la CI juste avant `tauri android build`.

import fs from "node:fs";
import path from "node:path";

const root = path.resolve("src-tauri/gen/android/app/src/main");
if (!fs.existsSync(root)) {
  console.error("Projet Android introuvable : lance d'abord `npx tauri android init`.");
  process.exit(1);
}

// 1. Manifeste : lecture des fichiers audio (Android 13+) et du stockage (Android 12 et moins).
const manifestPath = path.join(root, "AndroidManifest.xml");
let manifest = fs.readFileSync(manifestPath, "utf8");
const permissions = [
  '<uses-permission android:name="android.permission.READ_MEDIA_AUDIO" />',
  '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />',
  '<uses-permission android:name="android.permission.WAKE_LOCK" />',
];
for (const p of permissions) {
  const name = p.match(/android:name="([^"]+)"/)[1];
  if (!manifest.includes(name)) manifest = manifest.replace(/<application/, `${p}\n    <application`);
}
// Android 10 (Huawei Y8p) : accès classique aux fichiers par leur chemin.
if (!manifest.includes("requestLegacyExternalStorage")) {
  manifest = manifest.replace(/<application/, '<application android:requestLegacyExternalStorage="true"');
}
fs.writeFileSync(manifestPath, manifest);

// 2. Activité principale : demande la permission dès le premier lancement.
function find(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = find(full);
      if (hit) return hit;
    } else if (entry.name === "MainActivity.kt") return full;
  }
  return null;
}
const activityPath = find(path.join(root, "java"));
if (!activityPath) {
  console.error("MainActivity.kt introuvable.");
  process.exit(1);
}
const source = fs.readFileSync(activityPath, "utf8");
const pkg = source.match(/^package\s+([\w.]+)/m)[1];
fs.writeFileSync(
  activityPath,
  `package ${pkg}

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // Permission de lire la musique du téléphone (demandée une seule fois).
    val permission =
      if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_AUDIO
      else Manifest.permission.READ_EXTERNAL_STORAGE
    if (ContextCompat.checkSelfPermission(this, permission) != PackageManager.PERMISSION_GRANTED) {
      ActivityCompat.requestPermissions(this, arrayOf(permission), 1)
    }
  }
}
`,
);
console.log(`Android : permissions ajoutées (${path.relative(".", manifestPath)}, ${path.relative(".", activityPath)})`);
