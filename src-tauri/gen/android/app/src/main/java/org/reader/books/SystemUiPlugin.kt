package org.reader.books

import android.app.Activity
import android.view.KeyEvent
import android.view.WindowManager
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class ImmersiveArgs {
  var on: Boolean = false
}

@InvokeArg
class AwakeArgs {
  var on: Boolean = false
}

@InvokeArg
class VolumeKeysArgs {
  var on: Boolean = false
  var keys: Channel? = null
}

/**
 * The phone around the book: hides the system bars while reading (an edge swipe shows them
 * briefly), keeps the screen on, and lets the volume buttons turn pages.
 */
@TauriPlugin
class SystemUiPlugin(private val activity: Activity) : Plugin(activity) {
  companion object {
    /** Where volume presses go while a book is open with page turning on; null otherwise. */
    @Volatile private var pageKeys: Channel? = null

    /**
     * Called by the activity for every key. Volume up and down turn pages while a book wants
     * them, and then don't change the volume; otherwise they're left to the system.
     */
    fun onKey(event: KeyEvent): Boolean {
      val keys = pageKeys ?: return false
      val direction = when (event.keyCode) {
        KeyEvent.KEYCODE_VOLUME_UP -> "previous"
        KeyEvent.KEYCODE_VOLUME_DOWN -> "next"
        else -> return false
      }
      // Holding a button keeps turning; the release is swallowed too, so no volume slider shows.
      if (event.action == KeyEvent.ACTION_DOWN) keys.send(JSObject().put("turn", direction))
      return true
    }
  }

  @Command
  fun setImmersive(invoke: Invoke) {
    val args = invoke.parseArgs(ImmersiveArgs::class.java)
    activity.runOnUiThread {
      val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
      if (args.on) {
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller.hide(WindowInsetsCompat.Type.systemBars())
      } else {
        controller.show(WindowInsetsCompat.Type.systemBars())
      }
      invoke.resolve()
    }
  }

  @Command
  fun keepAwake(invoke: Invoke) {
    val args = invoke.parseArgs(AwakeArgs::class.java)
    activity.runOnUiThread {
      if (args.on) activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      invoke.resolve()
    }
  }

  @Command
  fun volumeKeys(invoke: Invoke) {
    val args = invoke.parseArgs(VolumeKeysArgs::class.java)
    pageKeys = if (args.on) args.keys else null
    invoke.resolve()
  }
}
