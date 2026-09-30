package org.reader.books

import android.app.Activity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class ImmersiveArgs {
  var on: Boolean = false
}

/** Hides the status and navigation bars while reading; an edge swipe shows them briefly. */
@TauriPlugin
class SystemUiPlugin(private val activity: Activity) : Plugin(activity) {
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
}
