package org.reader.books

import android.app.Activity
import androidx.activity.result.ActivityResult
import androidx.activity.result.IntentSenderRequest
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.ClearTokenRequest
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Scope

@InvokeArg
class AuthorizeArgs {
  var interactive: Boolean = false
}

@InvokeArg
class ClearTokenArgs {
  var token: String = ""
}

/** Google Play services owns the grant. Rust receives only short-lived access tokens. */
@TauriPlugin
class GoogleAuthPlugin(private val activity: Activity) : Plugin(activity) {
  private val client get() = Identity.getAuthorizationClient(activity)

  private fun request() = AuthorizationRequest.builder()
    .setRequestedScopes(listOf(Scope("https://www.googleapis.com/auth/drive.file")))
    .build()

  private fun explain(error: Exception): String = when ((error as? ApiException)?.statusCode) {
    CommonStatusCodes.DEVELOPER_ERROR ->
      "Google sign-in isn't set up for this Android build. Register its package and signing certificate (see docs/google-setup.md)."
    CommonStatusCodes.NETWORK_ERROR ->
      "Google Play services couldn't reach Google. Check this phone's connection (or VPN) and try again."
    CommonStatusCodes.CANCELED -> "Google connection cancelled"
    else -> "Google connection could not complete (${(error as? ApiException)?.statusCode ?: error.javaClass.simpleName}). Try again."
  }

  private fun resolve(invoke: Invoke, result: AuthorizationResult) {
    val token = result.accessToken
    if (token == null) invoke.reject("Google did not grant Drive access")
    else invoke.resolve(JSObject().put("token", token))
  }

  @Command
  fun authorize(invoke: Invoke) {
    val args = invoke.parseArgs(AuthorizeArgs::class.java)
    client.authorize(request())
      .addOnSuccessListener { result ->
        val pending = result.pendingIntent
        if (!result.hasResolution() || pending == null) resolve(invoke, result)
        else if (!args.interactive) invoke.reject("Reconnect Google Drive to sync")
        else startIntentSenderForResult(invoke, IntentSenderRequest.Builder(pending.intentSender).build(), "authorized")
      }
      .addOnFailureListener { invoke.reject(explain(it)) }
  }

  @ActivityCallback
  private fun authorized(invoke: Invoke, result: ActivityResult) {
    // A failed sheet still carries its status in the intent; only a bare dismissal has none.
    val data = result.data
    if (data == null) {
      invoke.reject("Google connection cancelled")
      return
    }
    try {
      resolve(invoke, client.getAuthorizationResultFromIntent(data))
    } catch (error: Exception) {
      invoke.reject(explain(error))
    }
  }

  @Command
  fun clearToken(invoke: Invoke) {
    val args = invoke.parseArgs(ClearTokenArgs::class.java)
    client.clearToken(ClearTokenRequest.builder().setToken(args.token).build())
      .addOnCompleteListener { invoke.resolve() }
  }
}
