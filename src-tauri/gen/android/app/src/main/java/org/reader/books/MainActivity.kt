package org.reader.books

import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Edge to edge, the keyboard no longer resizes the window, so it would cover the bottom of
    // the page (a panel's text field, say). Shrink the page to end at the keyboard instead. The
    // page already keeps clear of the navigation bar (CSS safe areas), so only the rest is added.
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      val bar = insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom
      view.setPadding(0, 0, 0, maxOf(0, keyboard - bar))
      insets
    }
  }

  // The volume buttons never reach the page, so they're caught here (see SystemUiPlugin).
  override fun dispatchKeyEvent(event: KeyEvent): Boolean =
    SystemUiPlugin.onKey(event) || super.dispatchKeyEvent(event)
}
