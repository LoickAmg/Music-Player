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
// - « Ouvrir avec Music Player » pour les fichiers audio, et bibliothèque tenue à jour toute
//   seule quand la musique du téléphone change (téléchargement, copie, suppression) ;
// - mises à jour : vérification en arrière-plan (même appli fermée) avec notification
//   « Mettre à jour », téléchargement par le service de téléchargement d'Android ;
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
  '<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />',
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
if (!manifest.includes("audio/*")) {
  // « Ouvrir avec » : fichiers audio venant du gestionnaire de fichiers, des
  // téléchargements, des messageries… (adresse content:// ou file://).
  const filter = `
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:scheme="content" />
                <data android:scheme="file" />
                <data android:mimeType="audio/*" />
                <data android:mimeType="application/ogg" />
                <data android:mimeType="application/x-flac" />
            </intent-filter>
        </activity>`;
  manifest = manifest.replace(/<\/activity>/, filter);
}
// Une seule instance de l'appli : un fichier ouvert depuis une autre appli arrive dans
// celle qui tourne déjà (onNewIntent) au lieu d'en lancer une deuxième.
if (!/android:launchMode=/.test(manifest)) {
  manifest = manifest.replace(/<activity\b/, '<activity android:launchMode="singleTask"');
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
if (!manifest.includes(".UpdateCheckJob")) {
  // Vérification des mises à jour en arrière-plan, bouton « Mettre à jour » des
  // notifications, et fin de téléchargement (même appli fermée).
  manifest = manifest.replace(
    /<\/application>/,
    `    <service android:name="${pkg}.UpdateCheckJob" android:permission="android.permission.BIND_JOB_SERVICE" android:exported="false" />
        <receiver android:name="${pkg}.UpdateNowReceiver" android:exported="false" />
        <receiver android:name="${pkg}.UpdateDownloadedReceiver" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.DOWNLOAD_COMPLETE" />
            </intent-filter>
        </receiver>
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
import android.content.Intent
import android.content.res.Configuration
import android.database.ContentObserver
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject
${edgeToEdge ? "import androidx.activity.enableEdgeToEdge\n" : ""}import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : TauriActivity() {
  private var updates: UpdateBridge? = null
  private val main = Handler(Looper.getMainLooper())

  // Musique du téléphone modifiée (téléchargement, copie, suppression) : la page met la
  // bibliothèque à jour, quelques secondes après la dernière modification.
  private val notifyLibrary = Runnable { MediaCommands.libraryChanged() }
  private val mediaObserver = object : ContentObserver(main) {
    override fun onChange(selfChange: Boolean) {
      main.removeCallbacks(notifyLibrary)
      main.postDelayed(notifyLibrary, 4000)
    }
  }

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
    contentResolver.registerContentObserver(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, true, mediaObserver)
    handleOpenIntent(intent)
    Updates.schedule(this)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    handleOpenIntent(intent)
  }

  /** « Ouvrir avec Music Player » : fichier transmis à la page, qui le lit tout de suite. */
  private fun handleOpenIntent(intent: Intent?) {
    if (intent?.action != Intent.ACTION_VIEW) return
    val uri = intent.data ?: return
    val type = intent.type
    Thread {
      AudioFiles.resolve(this, uri, type)?.let { MediaCommands.openFile(it) }
    }.start()
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
    contentResolver.unregisterContentObserver(mediaObserver)
    main.removeCallbacks(notifyLibrary)
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
  /** Fichier audio à ouvrir, en attente que la page le prenne (takeOpenedFile). */
  @Volatile var openedFile: String? = null

  fun openFile(path: String) {
    openedFile = path
    run("window.__mpOpenFile && window.__mpOpenFile()")
  }

  fun libraryChanged() = run("window.__mpLibraryChanged && window.__mpLibraryChanged()")

  private fun run(script: String) {
    val view = webView ?: return
    view.post { view.evaluateJavascript(script, null) }
  }

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

  /** Fichier audio reçu par « Ouvrir avec » (chemin), ou "" ; n'est remis qu'une fois. */
  @JavascriptInterface
  fun takeOpenedFile(): String {
    val path = MediaCommands.openedFile ?: return ""
    MediaCommands.openedFile = null
    return path
  }

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
import android.app.DownloadManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.PowerManager
import android.provider.Settings
import android.webkit.JavascriptInterface
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

class UpdateFileProvider : FileProvider()

data class Release(val version: String, val url: String, val size: Long)

/**
 * Mises à jour : recherche de la dernière version sur GitHub (APK du processeur du
 * téléphone de préférence), téléchargement confié au service de téléchargement d'Android
 * (connexion lente, coupure, nouvel essai, appli fermée), installation, et notifications
 * « Mise à jour disponible » / « Prête à installer ».
 */
object Updates {
  private const val RELEASES = "https://api.github.com/repos/LoickAmg/Music-Player/releases?per_page=15"
  private const val PREFS = "music-player-updates"
  private const val CHANNEL = "updates"
  private const val NOTIFY_AVAILABLE = 21
  private const val NOTIFY_READY = 22
  private const val JOB_ID = 4242
  private const val APK_NAME = "Music-Player-mise-a-jour.apk"

  /** Vrai pendant que la page suit le téléchargement (pas de notification « prête » en double). */
  @Volatile var watchedByPage = false

  fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  fun abi(): String =
    when (Build.SUPPORTED_ABIS.firstOrNull()) {
      "arm64-v8a" -> "arm64"
      "armeabi-v7a" -> "armv7"
      "x86_64" -> "x86_64"
      else -> "x86"
    }

  private fun versionKey(v: String): List<Int> =
    v.trimStart('v', 'V').split('.', '-').map { it.toIntOrNull() ?: -1 }.takeWhile { it >= 0 }

  private fun newer(a: List<Int>, b: List<Int>): Boolean {
    for (i in 0 until maxOf(a.size, b.size)) {
      val x = a.getOrElse(i) { 0 }
      val y = b.getOrElse(i) { 0 }
      if (x != y) return x > y
    }
    return false
  }

  fun installedVersion(context: Context): String =
    try {
      context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "0"
    } catch (e: Exception) {
      "0"
    }

  /** Version publiée plus récente que celle installée, ou null. */
  fun latest(context: Context): Release? {
    val connection = URL(RELEASES).openConnection() as HttpURLConnection
    connection.connectTimeout = 20000
    connection.readTimeout = 30000
    connection.setRequestProperty("User-Agent", "MusicPlayer")
    connection.setRequestProperty("Accept", "application/vnd.github+json")
    val releases = JSONArray(connection.inputStream.bufferedReader().use { it.readText() })
    var best: Release? = null
    var bestKey = versionKey(installedVersion(context))
    for (i in 0 until releases.length()) {
      val r = releases.getJSONObject(i)
      if (r.optBoolean("draft") || r.optBoolean("prerelease")) continue
      val version = r.optString("tag_name").removePrefix("app-v").removePrefix("v")
      val key = versionKey(version)
      if (!newer(key, bestKey)) continue
      val assets = r.optJSONArray("assets") ?: continue
      var own: JSONObject? = null
      var universal: JSONObject? = null
      var any: JSONObject? = null
      for (j in 0 until assets.length()) {
        val a = assets.getJSONObject(j)
        val name = a.optString("name")
        if (!name.endsWith(".apk")) continue
        if (name == "Music-Player-android-" + abi() + ".apk") own = a
        if (name == "Music-Player-android.apk") universal = a
        if (any == null) any = a
      }
      val chosen = own ?: universal ?: any ?: continue
      best = Release(version, chosen.optString("browser_download_url"), chosen.optLong("size"))
      bestKey = key
    }
    return best
  }

  fun apkFile(context: Context): File =
    File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), APK_NAME)

  /** Lance le téléchargement par Android ; renvoie son identifiant. */
  fun download(context: Context, url: String, version: String): Long {
    val dm = context.getSystemService(DownloadManager::class.java)
    val previous = prefs(context).getLong("download", -1L)
    if (previous >= 0) dm.remove(previous)
    apkFile(context).delete()
    val request = DownloadManager.Request(Uri.parse(url))
      .setTitle("Music Player " + version)
      .setDescription("Téléchargement de la mise à jour")
      .setMimeType("application/vnd.android.package-archive")
      .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
      .setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS, APK_NAME)
      .setAllowedOverMetered(true)
      .setAllowedOverRoaming(true)
    val id = dm.enqueue(request)
    prefs(context).edit().putLong("download", id).putString("download_version", version).apply()
    context.getSystemService(NotificationManager::class.java).cancel(NOTIFY_AVAILABLE)
    return id
  }

  /** État d'un téléchargement : statut, raison, octets reçus, taille totale. */
  fun query(context: Context, id: Long): LongArray? {
    val dm = context.getSystemService(DownloadManager::class.java)
    dm.query(DownloadManager.Query().setFilterById(id))?.use { c ->
      if (!c.moveToFirst()) return null
      return longArrayOf(
        c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS)).toLong(),
        c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON)).toLong(),
        c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)),
        c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)),
      )
    }
    return null
  }

  fun reasonText(status: Int, reason: Int): String =
    when (reason) {
      DownloadManager.PAUSED_WAITING_FOR_NETWORK -> "En attente du réseau…"
      DownloadManager.PAUSED_WAITING_TO_RETRY -> "Connexion lente ou coupée : nouvel essai automatique…"
      DownloadManager.PAUSED_QUEUED_FOR_WIFI -> "En attente du Wi-Fi…"
      DownloadManager.ERROR_INSUFFICIENT_SPACE -> "Espace de stockage insuffisant."
      DownloadManager.ERROR_HTTP_DATA_ERROR, DownloadManager.ERROR_CANNOT_RESUME -> "Connexion interrompue."
      DownloadManager.ERROR_DEVICE_NOT_FOUND -> "Stockage indisponible."
      else -> if (status == DownloadManager.STATUS_FAILED) "Téléchargement interrompu (code " + reason + ")." else "Téléchargement en pause…"
    }

  fun installIntent(context: Context): Intent =
    Intent(Intent.ACTION_VIEW)
      .setDataAndType(
        FileProvider.getUriForFile(context, context.packageName + ".updates", apkFile(context)),
        "application/vnd.android.package-archive",
      )
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)

  private fun ensureChannel(context: Context) {
    val channel = NotificationChannel(CHANNEL, "Mises à jour", NotificationManager.IMPORTANCE_DEFAULT)
    channel.description = "Nouvelle version de Music Player disponible ou prête à installer"
    context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }

  private fun smallIcon(context: Context): Int =
    context.resources.getIdentifier("ic_stat_music", "drawable", context.packageName)
      .takeIf { it != 0 } ?: android.R.drawable.stat_sys_download_done

  /** Notification « Mise à jour disponible », une seule fois par version. */
  fun notifyAvailable(context: Context, release: Release) {
    val prefs = prefs(context)
    if (prefs.getString("notified", null) == release.version) return
    prefs.edit()
      .putString("notified", release.version)
      .putString("pending_url", release.url)
      .putString("pending_version", release.version)
      .apply()
    ensureChannel(context)
    val open = context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
      PendingIntent.getActivity(context, 1, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
    val update = PendingIntent.getBroadcast(
      context,
      2,
      Intent(context, UpdateNowReceiver::class.java),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val megabytes = if (release.size > 0) " (" + (release.size / 1_000_000) + " Mo)" else ""
    val notification = Notification.Builder(context, CHANNEL)
      .setSmallIcon(smallIcon(context))
      .setContentTitle("Mise à jour disponible")
      .setContentText("Music Player " + release.version + " est prête à être installée" + megabytes + ".")
      .setContentIntent(open)
      .setAutoCancel(true)
      .addAction(
        Notification.Action.Builder(
          android.graphics.drawable.Icon.createWithResource(context, android.R.drawable.stat_sys_download),
          "Mettre à jour",
          update,
        ).build(),
      )
      .build()
    context.getSystemService(NotificationManager::class.java).notify(NOTIFY_AVAILABLE, notification)
  }

  /** Notification « Prête à installer » : un appui ouvre l'installation d'Android. */
  fun notifyReady(context: Context, version: String) {
    ensureChannel(context)
    val install = PendingIntent.getActivity(
      context,
      3,
      installIntent(context),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val notification = Notification.Builder(context, CHANNEL)
      .setSmallIcon(smallIcon(context))
      .setContentTitle("Mise à jour prête")
      .setContentText("Touchez pour installer Music Player " + version + ".")
      .setContentIntent(install)
      .setAutoCancel(true)
      .build()
    context.getSystemService(NotificationManager::class.java).notify(NOTIFY_READY, notification)
  }

  /** Vérification périodique (environ 3 fois par jour), même appli fermée ou après un redémarrage. */
  fun schedule(context: Context) {
    val scheduler = context.getSystemService(JobScheduler::class.java)
    if (scheduler.getPendingJob(JOB_ID) != null) return
    val job = JobInfo.Builder(JOB_ID, ComponentName(context, UpdateCheckJob::class.java))
      .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
      .setPeriodic(8 * 60 * 60 * 1000L)
      .setPersisted(true)
      .build()
    try {
      scheduler.schedule(job)
    } catch (e: Exception) {
      // planification refusée par le système : la vérification au lancement suffit
    }
  }
}

/** Vérification en arrière-plan. */
class UpdateCheckJob : JobService() {
  override fun onStartJob(params: JobParameters): Boolean {
    Thread {
      try {
        Updates.latest(this)?.let { Updates.notifyAvailable(this, it) }
      } catch (e: Exception) {
        // hors ligne : prochaine vérification plus tard
      }
      jobFinished(params, false)
    }.start()
    return true
  }

  override fun onStopJob(params: JobParameters): Boolean = true
}

/** Bouton « Mettre à jour » de la notification : téléchargement de la version annoncée. */
class UpdateNowReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val prefs = Updates.prefs(context)
    val url = prefs.getString("pending_url", null) ?: return
    Updates.download(context, url, prefs.getString("pending_version", null) ?: "")
  }
}

/** Téléchargement terminé (appli ouverte ou non) : notification « Prête à installer ». */
class UpdateDownloadedReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L)
    val prefs = Updates.prefs(context)
    if (id < 0 || id != prefs.getLong("download", -1L) || Updates.watchedByPage) return
    val state = Updates.query(context, id) ?: return
    if (state[0].toInt() == DownloadManager.STATUS_SUCCESSFUL) {
      Updates.notifyReady(context, prefs.getString("download_version", null) ?: "")
    }
  }
}

/**
 * Mise à jour depuis l'appli (window.AndroidUpdate) : téléchargement par Android, puis
 * installation. Avancement renvoyé à la page par window.__mpUpdate(étape, valeur) :
 * « progress » (0 à 1, ou -1), « waiting » (message), « permission », « ready », « error ».
 */
class UpdateBridge(private val activity: Activity) {
  @Volatile private var installPending = false

  @JavascriptInterface
  fun download(url: String, version: String) {
    val id = try {
      Updates.download(activity, url, version)
    } catch (e: Exception) {
      report("error", JSONObject.quote(e.message ?: e.toString()))
      return
    }
    Updates.watchedByPage = true
    Thread { watch(id) }.start()
  }

  private fun watch(id: Long) {
    while (true) {
      val state = Updates.query(activity, id)
      if (state == null) {
        Updates.watchedByPage = false
        report("error", JSONObject.quote("Téléchargement annulé."))
        return
      }
      val status = state[0].toInt()
      when (status) {
        DownloadManager.STATUS_SUCCESSFUL -> {
          Updates.watchedByPage = false
          report("progress", "1")
          activity.runOnUiThread { launchInstaller() }
          return
        }
        DownloadManager.STATUS_FAILED -> {
          Updates.watchedByPage = false
          report("error", JSONObject.quote(Updates.reasonText(status, state[1].toInt())))
          return
        }
        DownloadManager.STATUS_PAUSED ->
          report("waiting", JSONObject.quote(Updates.reasonText(status, state[1].toInt())))
        else -> report("progress", if (state[3] > 0) (state[2].toDouble() / state[3]).toString() else "-1")
      }
      Thread.sleep(500)
    }
  }

  /** Après le passage par les réglages d'Android : l'installation reprend si autorisée. */
  fun resumePending() {
    if (!installPending) return
    if (Build.VERSION.SDK_INT < 26 || activity.packageManager.canRequestPackageInstalls()) {
      installPending = false
      launchInstaller()
    }
  }

  private fun launchInstaller() {
    if (Build.VERSION.SDK_INT >= 26 && !activity.packageManager.canRequestPackageInstalls()) {
      installPending = true
      report("permission", "0")
      activity.startActivity(
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.packageName)),
      )
      return
    }
    try {
      activity.startActivity(Updates.installIntent(activity))
      report("ready", "1")
    } catch (e: Exception) {
      report("error", JSONObject.quote(e.message ?: e.toString()))
    }
  }

  /** Secours : la page de téléchargement du projet dans le navigateur (adresses du projet seulement). */
  @JavascriptInterface
  fun openInBrowser(url: String) {
    if (!url.startsWith("https://github.com/LoickAmg/Music-Player/")) return
    activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
  }

  /** Faux si l'économiseur de batterie peut empêcher la vérification en arrière-plan. */
  @JavascriptInterface
  fun backgroundAllowed(): Boolean =
    activity.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(activity.packageName)

  @JavascriptInterface
  fun openBatterySettings() {
    try {
      activity.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
    } catch (e: Exception) {
      activity.startActivity(Intent(Settings.ACTION_SETTINGS))
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

fs.writeFileSync(
  path.join(kotlinDir, "AudioFiles.kt"),
  `package ${pkg}

import android.content.Context
import android.net.Uri
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import java.io.File

/** Chemin lisible d'un fichier audio reçu par « Ouvrir avec ». */
object AudioFiles {
  fun resolve(context: Context, uri: Uri, type: String?): String? {
    if (uri.scheme == "file") return uri.path
    // Chemin réel quand le fournisseur le connaît (musique, téléchargements…).
    try {
      context.contentResolver.query(uri, arrayOf(MediaStore.MediaColumns.DATA), null, null, null)?.use { c ->
        val i = c.getColumnIndex(MediaStore.MediaColumns.DATA)
        if (i >= 0 && c.moveToFirst()) {
          val p = c.getString(i)
          if (p != null && File(p).canRead()) return p
        }
      }
    } catch (e: Exception) {
      // fournisseur sans chemin (messagerie, nuage…) : copie ci-dessous
    }
    // Sinon copie dans l'espace de l'appli (WhatsApp, Drive…).
    return try {
      var name = displayName(context, uri) ?: "morceau"
      name = name.filter { it.isLetterOrDigit() || it in " ._-()[]&,!'" }.ifBlank { "morceau" }
      if (!name.contains('.')) {
        val ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(type ?: context.contentResolver.getType(uri))
        if (ext != null) name = name + "." + ext
      }
      val dir = File(context.filesDir, "ouverts").apply { mkdirs() }
      val out = File(dir, name)
      val input = context.contentResolver.openInputStream(uri) ?: return null
      input.use { src -> out.outputStream().use { src.copyTo(it) } }
      out.absolutePath
    } catch (e: Exception) {
      null
    }
  }

  private fun displayName(context: Context, uri: Uri): String? =
    try {
      context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
        if (c.moveToFirst()) c.getString(0) else null
      }
    } catch (e: Exception) {
      null
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
    <external-files-path name="downloads" path="Download/" />
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
