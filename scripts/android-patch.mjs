// Complète le projet Android généré par `tauri android init` (src-tauri/gen/android) :
// - permissions (musique du téléphone, service de lecture, notification) ;
// - activité principale : demande des permissions, bouton retour qui revient à la page
//   précédente (et, à la racine, met l'appli en arrière-plan sans couper la musique),
//   pont JavaScript vers la notification de lecture ;
// - service de lecture : notification et écran verrouillé avec précédent / lecture-pause /
//   suivant (session média Android, aussi pilotable par un casque Bluetooth) ;
// - icône adaptative propre (image entière dans la zone visible) et icône de notification ;
// - écran gardé allumé pendant la lecture des paroles ;
// - dimensions réelles des barres système, de l'encoche et de la charnière (pliables)
//   transmises à la page (--sa-top…), orientation : portrait sur les téléphones et les
//   écrans extérieurs des pliables, libre sur tablettes et pliables ouverts ;
// - mise à jour depuis l'appli : téléchargement de l'APK de la dernière version GitHub puis
//   ouverture de l'installateur d'Android (installation par-dessus, même signature).
// Lancé par la CI après `tauri android init` et `tauri icon`, avant `tauri android build`.

import fs from "node:fs";
import path from "node:path";

const root = path.resolve("src-tauri/gen/android/app/src/main");
if (!fs.existsSync(root)) {
  console.error("Projet Android introuvable : lance d'abord `npx tauri android init`.");
  process.exit(1);
}

function find(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = find(full, name);
      if (hit) return hit;
    } else if (entry.name === name) return full;
  }
  return null;
}

const activityPath = find(path.join(root, "java"), "MainActivity.kt");
if (!activityPath) {
  console.error("MainActivity.kt introuvable.");
  process.exit(1);
}
const generated = fs.readFileSync(activityPath, "utf8");
const pkg = generated.match(/^package\s+([\w.]+)/m)[1];
const edgeToEdge = generated.includes("enableEdgeToEdge");
const kotlinDir = path.dirname(activityPath);

// 1. Manifeste
const manifestPath = path.join(root, "AndroidManifest.xml");
let manifest = fs.readFileSync(manifestPath, "utf8");
const permissions = [
  '<uses-permission android:name="android.permission.READ_MEDIA_AUDIO" />',
  '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />',
  '<uses-permission android:name="android.permission.WAKE_LOCK" />',
  '<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />',
  '<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />',
  '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />',
  '<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />',
];
for (const p of permissions) {
  const name = p.match(/android:name="([^"]+)"/)[1];
  if (!manifest.includes(`"${name}"`)) manifest = manifest.replace(/<application/, `${p}\n    <application`);
}
// Android 10 (Huawei Y8p) : accès classique aux fichiers par leur chemin.
if (!manifest.includes("requestLegacyExternalStorage")) {
  manifest = manifest.replace(/<application/, '<application android:requestLegacyExternalStorage="true"');
}
if (!manifest.includes(".MediaService")) {
  manifest = manifest.replace(
    /<\/application>/,
    `    <service android:name="${pkg}.MediaService" android:exported="false" android:foregroundServiceType="mediaPlayback" />\n    </application>`,
  );
}
if (!manifest.includes(".UpdateFileProvider")) {
  // Fournisseur propre (classe dérivée, nom unique) : aucun conflit possible avec un autre
  // FileProvider déclaré par Tauri ou un greffon.
  manifest = manifest.replace(
    /<\/application>/,
    `    <provider android:name="${pkg}.UpdateFileProvider" android:authorities="\${applicationId}.updates" android:exported="false" android:grantUriPermissions="true">
            <meta-data android:name="android.support.FILE_PROVIDER_PATHS" android:resource="@xml/update_paths" />
        </provider>
    </application>`,
  );
}
fs.writeFileSync(manifestPath, manifest);

// 2. Activité principale
fs.writeFileSync(
  activityPath,
  `package ${pkg}

import android.Manifest
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject
${edgeToEdge ? "import androidx.activity.enableEdgeToEdge\n" : ""}import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : TauriActivity() {
  private var updates: UpdateBridge? = null

  override fun onCreate(savedInstanceState: Bundle?) {
${edgeToEdge ? "    enableEdgeToEdge()\n" : ""}    super.onCreate(savedInstanceState)
    applyOrientation()
    // Lecture de la musique du téléphone et notification de lecture (demandées une fois).
    val wanted = mutableListOf(
      if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_AUDIO
      else Manifest.permission.READ_EXTERNAL_STORAGE,
    )
    if (Build.VERSION.SDK_INT >= 33) wanted.add(Manifest.permission.POST_NOTIFICATIONS)
    val missing = wanted.filter {
      ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
    }
    if (missing.isNotEmpty()) ActivityCompat.requestPermissions(this, missing.toTypedArray(), 1)
  }

  /**
   * Téléphones (et écrans extérieurs des pliables : Z Flip, Z Fold fermé…) : portrait,
   * comme les lecteurs de musique courants. Tablettes et pliables ouverts (plus petit côté
   * d'au moins 600 dp) : rotation libre. Réévalué à chaque pliage ou dépliage.
   */
  private fun applyOrientation() {
    requestedOrientation =
      if (resources.configuration.smallestScreenWidthDp < 600) ActivityInfo.SCREEN_ORIENTATION_USER_PORTRAIT
      else ActivityInfo.SCREEN_ORIENTATION_FULL_USER
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    applyOrientation()
  }

  override fun onWebViewCreate(webView: WebView) {
    MediaCommands.webView = webView
    // Barres système, encoche et charnière : dimensions en px CSS transmises à la page,
    // sans consommer les marges (la page dessine sous les barres, edge-to-edge).
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
      )
      val density = resources.displayMetrics.density
      MediaCommands.insets = JSONObject()
        .put("top", (bars.top / density).toDouble())
        .put("bottom", (bars.bottom / density).toDouble())
        .put("left", (bars.left / density).toDouble())
        .put("right", (bars.right / density).toDouble())
        .toString()
      view.post {
        webView.evaluateJavascript("window.__mpInsets && window.__mpInsets(" + MediaCommands.insets + ")", null)
      }
      insets
    }
    webView.addJavascriptInterface(MediaBridge(applicationContext), "AndroidMedia")
    updates = UpdateBridge(this).also { webView.addJavascriptInterface(it, "AndroidUpdate") }
    // Retour : page précédente de l'interface ; à la racine, l'appli passe en arrière-plan
    // (comme la touche d'accueil) au lieu de se fermer et de couper la musique.
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        if (webView.canGoBack()) webView.goBack() else moveTaskToBack(true)
      }
    })
  }

  override fun onResume() {
    super.onResume()
    // Retour des réglages « installer des applis inconnues » : l'installation reprend.
    updates?.resumePending()
  }

  override fun onDestroy() {
    if (isFinishing) MediaCommands.webView = null
    super.onDestroy()
  }
}
`,
);

// 3. Pont JavaScript et service de lecture
fs.writeFileSync(
  path.join(kotlinDir, "MediaBridge.kt"),
  `package ${pkg}

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject

/** Commandes de la notification, de l'écran verrouillé ou d'un casque vers l'interface. */
object MediaCommands {
  @Volatile var webView: WebView? = null
  /** Dernières marges système connues (JSON, px CSS), relues par la page au démarrage. */
  @Volatile var insets: String = "{}"

  fun send(command: String, arg: Long = 0) {
    val view = webView ?: return
    view.post {
      view.evaluateJavascript("window.__mpMedia && window.__mpMedia('$command', $arg)", null)
    }
  }
}

/** Appelé par la page (window.AndroidMedia) à chaque changement de morceau ou d'état. */
class MediaBridge(private val context: Context) {
  private var coverPath: String? = null
  private var cover: Bitmap? = null

  @JavascriptInterface
  fun update(json: String) {
    val o = JSONObject(json)
    val path = o.optString("cover", "")
    if (path != coverPath) {
      coverPath = path
      cover = if (path.isEmpty()) null else decode(path)
    }
    MediaService.show(
      context,
      NowPlayingInfo(
        title = o.optString("title"),
        artist = o.optString("artist"),
        album = o.optString("album"),
        durationMs = o.optLong("durationMs"),
        positionMs = o.optLong("positionMs"),
        playing = o.optBoolean("playing"),
        cover = cover,
      ),
    )
  }

  @JavascriptInterface
  fun clear() = MediaService.hide()

  /** Marges des barres système, de l'encoche et de la charnière (JSON, px CSS). */
  @JavascriptInterface
  fun insets(): String = MediaCommands.insets

  /** Garde l'écran allumé tant que les paroles défilent (vrai), ou rend la veille (faux). */
  @JavascriptInterface
  fun keepScreenOn(on: Boolean) {
    val view = MediaCommands.webView ?: return
    view.post { view.keepScreenOn = on }
  }

  /** Pochette réduite (~512 px) pour la notification et l'écran verrouillé. */
  private fun decode(path: String): Bitmap? =
    try {
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeFile(path, bounds)
      var sample = 1
      while (bounds.outWidth / (sample * 2) >= 512 && bounds.outHeight / (sample * 2) >= 512) sample *= 2
      BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sample })
    } catch (e: Exception) {
      null
    }
}
`,
);

fs.writeFileSync(
  path.join(kotlinDir, "MediaService.kt"),
  `package ${pkg}

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.drawable.Icon
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log

data class NowPlayingInfo(
  val title: String,
  val artist: String,
  val album: String,
  val durationMs: Long,
  val positionMs: Long,
  val playing: Boolean,
  val cover: Bitmap?,
)

/**
 * Service de lecture au premier plan : garde l'appli en vie écran éteint et affiche la
 * notification média (écran verrouillé, volet de notifications, montre, casque).
 */
class MediaService : Service() {
  companion object {
    private const val TAG = "MusicPlayerMedia"
    private const val CHANNEL = "playback"
    private const val NOTIFICATION_ID = 7
    private const val ACTION_PREVIOUS = "musicplayer.PREVIOUS"
    private const val ACTION_TOGGLE = "musicplayer.TOGGLE"
    private const val ACTION_NEXT = "musicplayer.NEXT"

    private val main = Handler(Looper.getMainLooper())
    private var instance: MediaService? = null
    private var info: NowPlayingInfo? = null

    fun show(context: Context, next: NowPlayingInfo) {
      main.post {
        info = next
        val service = instance
        if (service != null) {
          service.render()
        } else {
          try {
            context.startForegroundService(Intent(context, MediaService::class.java))
          } catch (e: Exception) {
            Log.w(TAG, "Service de lecture non démarré", e)
          }
        }
      }
    }

    fun hide() {
      main.post {
        info = null
        instance?.shutdown()
      }
    }
  }

  private lateinit var session: MediaSession
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    instance = this
    val channel = NotificationChannel(CHANNEL, "Lecture en cours", NotificationManager.IMPORTANCE_LOW)
    channel.setShowBadge(false)
    channel.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
    getSystemService(NotificationManager::class.java).createNotificationChannel(channel)

    session = MediaSession(this, "MusicPlayer")
    session.setCallback(object : MediaSession.Callback() {
      override fun onPlay() = MediaCommands.send("play")
      override fun onPause() = MediaCommands.send("pause")
      override fun onStop() = MediaCommands.send("pause")
      override fun onSkipToNext() = MediaCommands.send("next")
      override fun onSkipToPrevious() = MediaCommands.send("previous")
      override fun onSeekTo(pos: Long) = MediaCommands.send("seek", pos)
    })
    packageManager.getLaunchIntentForPackage(packageName)?.let {
      session.setSessionActivity(
        PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT),
      )
    }
    session.isActive = true
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_PREVIOUS -> MediaCommands.send("previous")
      ACTION_TOGGLE -> MediaCommands.send("toggle")
      ACTION_NEXT -> MediaCommands.send("next")
    }
    render()
    return START_NOT_STICKY
  }

  fun render() {
    val current = info ?: run {
      shutdown()
      return
    }
    session.setPlaybackState(
      PlaybackState.Builder()
        .setActions(
          PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or
            PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS or
            PlaybackState.ACTION_SEEK_TO or PlaybackState.ACTION_STOP,
        )
        .setState(
          if (current.playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
          current.positionMs,
          if (current.playing) 1f else 0f,
          SystemClock.elapsedRealtime(),
        )
        .build(),
    )
    val meta = MediaMetadata.Builder()
      .putString(MediaMetadata.METADATA_KEY_TITLE, current.title)
      .putString(MediaMetadata.METADATA_KEY_ARTIST, current.artist)
      .putString(MediaMetadata.METADATA_KEY_ALBUM, current.album)
      .putLong(MediaMetadata.METADATA_KEY_DURATION, current.durationMs)
    current.cover?.let { meta.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, it) }
    session.setMetadata(meta.build())

    val smallIcon = resources.getIdentifier("ic_stat_music", "drawable", packageName)
      .takeIf { it != 0 } ?: android.R.drawable.ic_media_play
    val notification = Notification.Builder(this, CHANNEL)
      .setSmallIcon(smallIcon)
      .setContentTitle(current.title)
      .setContentText(current.artist)
      .setLargeIcon(current.cover)
      .setContentIntent(session.controller.sessionActivity)
      .setVisibility(Notification.VISIBILITY_PUBLIC)
      .setOngoing(current.playing)
      .setShowWhen(false)
      .setOnlyAlertOnce(true)
      .addAction(action(android.R.drawable.ic_media_previous, "Précédent", ACTION_PREVIOUS, 1))
      .addAction(
        if (current.playing) action(android.R.drawable.ic_media_pause, "Pause", ACTION_TOGGLE, 2)
        else action(android.R.drawable.ic_media_play, "Lecture", ACTION_TOGGLE, 2),
      )
      .addAction(action(android.R.drawable.ic_media_next, "Suivant", ACTION_NEXT, 3))
      .setStyle(Notification.MediaStyle().setMediaSession(session.sessionToken).setShowActionsInCompactView(0, 1, 2))
      .build()
    try {
      if (Build.VERSION.SDK_INT >= 29) {
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
    } catch (e: Exception) {
      Log.w(TAG, "Premier plan refusé, simple notification", e)
      getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification)
    }
    holdWakeLock(current.playing)
  }

  private fun action(icon: Int, title: String, name: String, code: Int): Notification.Action {
    val intent = Intent(this, MediaService::class.java).setAction(name)
    val pending = PendingIntent.getService(this, code, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    return Notification.Action.Builder(Icon.createWithResource(this, icon), title, pending).build()
  }

  /** Garde le processeur éveillé pendant la lecture (enchaînement des morceaux écran éteint). */
  private fun holdWakeLock(on: Boolean) {
    val lock = wakeLock
      ?: (getSystemService(Context.POWER_SERVICE) as PowerManager)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MusicPlayer:lecture")
        .also {
          it.setReferenceCounted(false)
          wakeLock = it
        }
    if (on) lock.acquire(6 * 60 * 60 * 1000L) else if (lock.isHeld) lock.release()
  }

  fun shutdown() {
    holdWakeLock(false)
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    // Appli balayée depuis les applications récentes : on ferme tout, musique comprise.
    shutdown()
    super.onTaskRemoved(rootIntent)
    android.os.Process.killProcess(android.os.Process.myPid())
  }

  override fun onDestroy() {
    holdWakeLock(false)
    session.release()
    if (instance === this) instance = null
    super.onDestroy()
  }
}
`,
);

fs.writeFileSync(
  path.join(kotlinDir, "UpdateBridge.kt"),
  `package ${pkg}

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import android.webkit.JavascriptInterface
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

class UpdateFileProvider : FileProvider()

/**
 * Mise à jour depuis l'appli (window.AndroidUpdate) : télécharge l'APK de la dernière
 * version, puis ouvre l'installateur d'Android. Avancement renvoyé à la page par
 * window.__mpUpdate(étape, valeur) : « progress » (0 à 1, ou -1 si taille inconnue),
 * « permission » (autorisation d'installer demandée), « ready », « error ».
 */
class UpdateBridge(private val activity: Activity) {
  @Volatile private var pending: File? = null

  @JavascriptInterface
  fun install(url: String) {
    Thread {
      try {
        val dir = File(activity.cacheDir, "updates").apply { mkdirs() }
        val apk = File(dir, "Music-Player.apk")
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.instanceFollowRedirects = true
        connection.connectTimeout = 15000
        connection.readTimeout = 30000
        connection.setRequestProperty("User-Agent", "MusicPlayer")
        val total = connection.contentLengthLong
        connection.inputStream.use { input ->
          apk.outputStream().use { output ->
            val buffer = ByteArray(64 * 1024)
            var received = 0L
            var last = 0L
            while (true) {
              val n = input.read(buffer)
              if (n < 0) break
              output.write(buffer, 0, n)
              received += n
              val now = SystemClock.uptimeMillis()
              if (now - last > 200) {
                last = now
                report("progress", if (total > 0) (received.toDouble() / total).toString() else "-1")
              }
            }
          }
        }
        report("progress", "1")
        activity.runOnUiThread { launchInstaller(apk) }
      } catch (e: Exception) {
        report("error", JSONObject.quote(e.message ?: e.toString()))
      }
    }.start()
  }

  /** Après le passage par les réglages d'Android : relance l'installation si autorisée. */
  fun resumePending() {
    val apk = pending ?: return
    if (Build.VERSION.SDK_INT < 26 || activity.packageManager.canRequestPackageInstalls()) {
      pending = null
      launchInstaller(apk)
    }
  }

  private fun launchInstaller(apk: File) {
    if (Build.VERSION.SDK_INT >= 26 && !activity.packageManager.canRequestPackageInstalls()) {
      pending = apk
      report("permission", "0")
      activity.startActivity(
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.packageName)),
      )
      return
    }
    try {
      val uri = FileProvider.getUriForFile(activity, activity.packageName + ".updates", apk)
      val intent = Intent(Intent.ACTION_VIEW)
        .setDataAndType(uri, "application/vnd.android.package-archive")
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      activity.startActivity(intent)
      report("ready", "1")
    } catch (e: Exception) {
      report("error", JSONObject.quote(e.message ?: e.toString()))
    }
  }

  private fun report(stage: String, value: String) {
    val view = MediaCommands.webView ?: return
    view.post {
      view.evaluateJavascript("window.__mpUpdate && window.__mpUpdate('" + stage + "', " + value + ")", null)
    }
  }
}
`,
);

// 4. Icônes : icône adaptative dont le premier plan contient l'image entière dans la zone
// visible (sinon le lanceur la rogne et elle paraît grossie), fond = même image floutée.
const res = path.join(root, "res");
const iconSrc = path.resolve("src-tauri/icons/android");
for (const dir of fs.readdirSync(iconSrc)) {
  const out = path.join(res, dir);
  fs.mkdirSync(out, { recursive: true });
  for (const file of fs.readdirSync(path.join(iconSrc, dir))) {
    fs.copyFileSync(path.join(iconSrc, dir, file), path.join(out, file));
  }
}
const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_bg" />
    <foreground android:drawable="@mipmap/ic_launcher_fg" />
</adaptive-icon>
`;
const anydpiDirs = fs.readdirSync(res).filter((d) => d.startsWith("mipmap-anydpi"));
if (!anydpiDirs.includes("mipmap-anydpi-v26")) anydpiDirs.push("mipmap-anydpi-v26");
for (const dir of anydpiDirs) {
  fs.mkdirSync(path.join(res, dir), { recursive: true });
  for (const name of ["ic_launcher.xml", "ic_launcher_round.xml"]) {
    fs.writeFileSync(path.join(res, dir, name), adaptive);
  }
}
fs.mkdirSync(path.join(res, "xml"), { recursive: true });
fs.writeFileSync(
  path.join(res, "xml", "update_paths.xml"),
  `<?xml version="1.0" encoding="utf-8"?>
<paths>
    <cache-path name="updates" path="updates/" />
</paths>
`,
);
fs.mkdirSync(path.join(res, "drawable"), { recursive: true });
fs.writeFileSync(
  path.join(res, "drawable", "ic_stat_music.xml"),
  `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp"
    android:viewportWidth="24" android:viewportHeight="24">
    <path android:fillColor="#FFFFFFFF"
        android:pathData="M12,3v10.55c-0.59,-0.34 -1.27,-0.55 -2,-0.55 -2.21,0 -4,1.79 -4,4s1.79,4 4,4 4,-1.79 4,-4V7h4V3h-6z" />
</vector>
`,
);

console.log(
  `Android : manifeste, activité, service de lecture et icônes complétés (paquet ${pkg}, ${anydpiDirs.join(", ")})`,
);
