package org.reader.books

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

@InvokeArg
class InstallArgs {
  var url: String = ""
  var sha256: String = ""
  var size: Long = 0
  var version: String = ""
  var onProgress: Channel? = null
}

/**
 * Updates Reader in place: downloads the release APK, checks it is exactly the published file,
 * the same app, newer, and signed by the same key as the installed one, then hands it to
 * Android's installer. Rust chooses the release; nothing else can supply a download.
 */
@TauriPlugin
class AppUpdatePlugin(private val activity: Activity) : Plugin(activity) {
  private val worker = Executors.newSingleThreadExecutor()
  private val folder: File get() = File(activity.cacheDir, "updates").apply { mkdirs() }

  init {
    // Once an update is installed its download is no longer needed.
    folder.listFiles()?.forEach { it.delete() }
  }

  @Command
  fun install(invoke: Invoke) {
    val args = invoke.parseArgs(InstallArgs::class.java)
    worker.execute {
      try {
        val apk = File(folder, "Reader-${args.version}.apk")
        if (!apk.exists() || apk.length() != args.size || sha256(apk) != args.sha256) download(args, apk)
        validate(apk, args)
        activity.runOnUiThread { openInstaller(invoke, apk) }
      } catch (error: Exception) {
        invoke.reject(error.message ?: "Couldn't update Reader. Try again.")
      }
    }
  }

  private fun openInstaller(invoke: Invoke, apk: File) {
    try {
      if (Build.VERSION.SDK_INT >= 26 && !activity.packageManager.canRequestPackageInstalls()) {
        // Android asks once whether Reader may install updates; the next tap continues.
        activity.startActivity(
          Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.packageName)),
        )
        invoke.resolve(JSObject().put("state", "permission"))
        return
      }
      val uri = FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", apk)
      activity.startActivity(
        Intent(Intent.ACTION_VIEW)
          .setDataAndType(uri, "application/vnd.android.package-archive")
          .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),
      )
      invoke.resolve(JSObject().put("state", "installing"))
    } catch (error: Exception) {
      invoke.reject("Couldn't open Android's installer. Try again.")
    }
  }

  private fun allowed(url: URL) =
    url.protocol == "https" && (url.port == -1 || url.port == 443) && url.userInfo == null &&
      url.host in setOf("github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com")

  private fun download(args: InstallArgs, apk: File) {
    if (!args.url.startsWith("https://github.com/Carlos-err406/reader/releases/download/")) throw IOException("Not a Reader release")
    val partial = File(folder, "update.part")
    try {
      var url = URL(args.url)
      for (redirect in 0..5) {
        if (!allowed(url)) throw IOException("Unexpected update download location")
        val http = url.openConnection() as HttpURLConnection
        try {
          http.instanceFollowRedirects = false
          http.connectTimeout = 15000
          http.readTimeout = 30000
          http.setRequestProperty("User-Agent", "Reader-Android")
          http.setRequestProperty("Accept", "application/octet-stream")
          val status = http.responseCode
          if (status in listOf(301, 302, 303, 307, 308)) {
            url = URL(url, http.getHeaderField("Location") ?: throw IOException("Missing download redirect"))
            continue
          }
          if (status != 200) throw IOException("Update download failed ($status). Try again.")
          val hash = MessageDigest.getInstance("SHA-256")
          val deadline = System.nanoTime() + TimeUnit.MINUTES.toNanos(10)
          var total = 0L
          var reported = -1
          http.inputStream.use { input ->
            FileOutputStream(partial).use { output ->
              val buffer = ByteArray(64 * 1024)
              while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                total += count
                if (total > args.size) throw IOException("Update download is larger than published")
                if (System.nanoTime() > deadline) throw IOException("Update download timed out")
                hash.update(buffer, 0, count)
                output.write(buffer, 0, count)
                val percent = (total * 100 / args.size).toInt()
                if (percent != reported) {
                  reported = percent
                  args.onProgress?.send(JSObject().put("fraction", total.toDouble() / args.size))
                }
              }
            }
          }
          if (total != args.size || hex(hash.digest()) != args.sha256) throw IOException("The update didn't match its published checksum. Try again.")
          if (!partial.renameTo(apk)) throw IOException("Couldn't save the update")
          return
        } finally {
          http.disconnect()
        }
      }
      throw IOException("Too many update redirects")
    } finally {
      partial.delete()
    }
  }

  @Suppress("DEPRECATION")
  private fun validate(apk: File, args: InstallArgs) {
    val pm = activity.packageManager
    val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
    val next = pm.getPackageArchiveInfo(apk.absolutePath, flags)
    val current = pm.getPackageInfo(activity.packageName, flags)
    if (next == null || next.packageName != activity.packageName || next.versionName != args.version || code(next) <= code(current)) {
      apk.delete()
      throw IOException("This update isn't a newer version of Reader")
    }
    if (signers(next) != signers(current) || signers(current).isEmpty()) {
      apk.delete()
      throw IOException("This update is signed by a different key. Reader was left as it is.")
    }
  }

  @Suppress("DEPRECATION")
  private fun code(info: PackageInfo): Long =
    if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()

  @Suppress("DEPRECATION")
  private fun signers(info: PackageInfo): Set<String> =
    if (Build.VERSION.SDK_INT >= 28) {
      info.signingInfo?.apkContentsSigners?.map { it.toCharsString() }?.toSet() ?: emptySet()
    } else {
      info.signatures?.map { it.toCharsString() }?.toSet() ?: emptySet()
    }

  private fun sha256(file: File): String {
    val hash = MessageDigest.getInstance("SHA-256")
    FileInputStream(file).use { input ->
      val buffer = ByteArray(64 * 1024)
      while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        hash.update(buffer, 0, count)
      }
    }
    return hex(hash.digest())
  }

  private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }
}
