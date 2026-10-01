package org.reader.books

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.WebView
import androidx.core.content.IntentCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.UUID
import java.util.concurrent.Executors

@InvokeArg
class WatchOpenedArgs {
  var channel: Channel? = null
}

/**
 * Books other apps hand to Reader: a tap on a PDF or EPUB in a file manager or Downloads
 * (VIEW), or "Share" (SEND, SEND_MULTIPLE). Each is copied into the app's cache while the
 * sender's permission lasts; Rust then reads the copy once and deletes it.
 */
@TauriPlugin
class OpenedFilesPlugin(private val activity: Activity) : Plugin(activity) {
  private val worker = Executors.newSingleThreadExecutor()
  private val ready = mutableListOf<JSObject>()
  @Volatile private var watcher: Channel? = null
  private val folder: File get() = File(activity.cacheDir, "opened").apply { mkdirs() }

  override fun load(webView: WebView) {
    super.load(webView)
    // Copies left from a previous run were either read or abandoned.
    folder.listFiles()?.forEach { it.delete() }
    // The app may have been started by opening a book.
    receive(activity.intent)
  }

  override fun onNewIntent(intent: Intent) {
    receive(intent)
  }

  private fun receive(intent: Intent?) {
    // A share sheet puts the files in the clip data too, which is what carries the permission to
    // read them; the stream extra is the fallback.
    val clipped = intent?.clipData?.let { clip -> (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri } }.orEmpty()
    val uris: List<Uri> = when (intent?.action) {
      Intent.ACTION_VIEW -> listOfNotNull(intent.data)
      Intent.ACTION_SEND ->
        clipped.ifEmpty { listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)) }
      Intent.ACTION_SEND_MULTIPLE ->
        clipped.ifEmpty { IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java) ?: emptyList() }
      else -> emptyList()
    }
    if (uris.isEmpty()) return
    worker.execute {
      for (uri in uris) copy(uri)?.let { synchronized(ready) { ready.add(it) } }
      watcher?.send(JSObject())
    }
  }

  private fun displayName(uri: Uri): String? =
    try {
      activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) cursor.getString(0) else null
      }
    } catch (e: Exception) {
      null
    }

  private fun copy(uri: Uri): JSObject? {
    val name = (displayName(uri) ?: uri.lastPathSegment ?: "Book").substringAfterLast('/')
    val target = File(folder, "${UUID.randomUUID()}-${name.replace(Regex("[^\\p{L}\\p{N}._ -]"), "_")}")
    return try {
      val input = activity.contentResolver.openInputStream(uri) ?: return null
      input.use {
        FileOutputStream(target).use { output ->
          val buffer = ByteArray(64 * 1024)
          var total = 0L
          while (true) {
            val count = it.read(buffer)
            if (count < 0) break
            total += count
            if (total > MAX_BYTES) throw IOException("Too big for a book")
            output.write(buffer, 0, count)
          }
        }
      }
      JSObject().put("path", target.absolutePath).put("name", name)
    } catch (e: Exception) {
      target.delete()
      null
    }
  }

  @Command
  fun takeOpened(invoke: Invoke) {
    val files = JSArray()
    synchronized(ready) {
      ready.forEach { files.put(it) }
      ready.clear()
    }
    invoke.resolve(JSObject().put("files", files))
  }

  @Command
  fun watchOpened(invoke: Invoke) {
    watcher = invoke.parseArgs(WatchOpenedArgs::class.java).channel
    invoke.resolve()
  }

  private companion object {
    /** Reader's limit for a book. */
    const val MAX_BYTES = 512L * 1024 * 1024
  }
}
