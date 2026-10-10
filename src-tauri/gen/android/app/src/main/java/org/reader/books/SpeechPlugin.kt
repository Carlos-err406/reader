package org.reader.books

import android.app.Activity
import android.content.Intent
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

@InvokeArg
class SpeakArgs {
  var texts: Array<String> = arrayOf()
  var utterance: Int = 0
  var voice: String? = null
  var lang: String? = null
  var rate: Float = 1f
  var events: Channel? = null
}

/**
 * Reads aloud with the phone's text-to-speech engine. Each text is one utterance,
 * `<utterance>:<index>`; its start and end go to the reader, which marks the sentence.
 */
@TauriPlugin
class SpeechPlugin(private val activity: Activity) : Plugin(activity) {
  private var engine: TextToSpeech? = null
  private var ready = false
  /** Work waiting for the engine to start; given null if it couldn't. */
  private val waiting = mutableListOf<(TextToSpeech?) -> Unit>()
  @Volatile private var events: Channel? = null

  private val progress = object : UtteranceProgressListener() {
    override fun onStart(id: String) {
      events?.send(JSObject().put("start", id))
    }

    override fun onDone(id: String) {
      events?.send(JSObject().put("done", id))
    }

    @Deprecated("Deprecated in Java")
    override fun onError(id: String) {
      events?.send(JSObject().put("error", id))
    }

    override fun onError(id: String, code: Int) {
      events?.send(JSObject().put("error", id))
    }
  }

  /** Starts the engine the first time it's needed; it binds to the phone's TTS service. */
  private fun withEngine(work: (TextToSpeech?) -> Unit) {
    // Created on the main thread, so its start callback (also on the main thread) can't run
    // before `created` is set.
    activity.runOnUiThread {
      val current = engine
      if (current != null && ready) return@runOnUiThread work(current)
      waiting.add(work)
      if (current != null) return@runOnUiThread
      lateinit var created: TextToSpeech
      created = TextToSpeech(activity.applicationContext) { status ->
        val ok = status == TextToSpeech.SUCCESS
        ready = ok
        if (ok) created.setOnUtteranceProgressListener(progress)
        else {
          created.shutdown()
          engine = null
        }
        val pending = waiting.toList()
        waiting.clear()
        pending.forEach { it(if (ok) created else null) }
      }
      engine = created
    }
  }

  private fun installed(tts: TextToSpeech): List<Voice> =
    try {
      (tts.voices ?: emptySet()).filter { !it.features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) }
    } catch (_: Exception) {
      emptyList()
    }

  @Command
  fun voices(invoke: Invoke) {
    withEngine { tts ->
      if (tts == null) return@withEngine invoke.reject("This phone has no text-to-speech engine")
      // Engines name voices like "es-us-x-esd-local": show the language, numbered, instead.
      val sorted = installed(tts).sortedWith(
        compareBy<Voice>({ it.locale.toLanguageTag() }, { it.isNetworkConnectionRequired }, { -it.quality }, { it.name }),
      )
      val counts = mutableMapOf<String, Int>()
      val list = JSONArray()
      for (v in sorted) {
        val tag = v.locale.toLanguageTag()
        val n = (counts[tag] ?: 0) + 1
        counts[tag] = n
        val language = v.locale.getDisplayName(v.locale).replaceFirstChar { it.titlecase(v.locale) }
        val online = if (v.isNetworkConnectionRequired) " · online" else ""
        list.put(JSONObject().put("id", v.name).put("name", "$language $n$online").put("lang", tag))
      }
      val reply = JSObject()
      reply.put("voices", list)
      invoke.resolve(reply)
    }
  }

  @Command
  fun speak(invoke: Invoke) {
    val args = invoke.parseArgs(SpeakArgs::class.java)
    withEngine { tts ->
      if (tts == null) return@withEngine invoke.reject("This phone has no text-to-speech engine")
      tts.stop()
      events = args.events
      val voice = args.voice?.let { id -> installed(tts).find { it.name == id } }
      val locale = args.lang?.let { Locale.forLanguageTag(it) }
      when {
        voice != null -> tts.voice = voice
        locale != null && tts.isLanguageAvailable(locale) >= TextToSpeech.LANG_AVAILABLE -> tts.language = locale
        else -> tts.defaultVoice?.let { tts.voice = it }
      }
      tts.setSpeechRate(args.rate)
      args.texts.forEachIndexed { i, text ->
        tts.speak(text, if (i == 0) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD, null, "${args.utterance}:$i")
      }
      invoke.resolve()
    }
  }

  /**
   * Opens the engine's own screen for adding voices (other languages, better quality): the
   * engine Reader speaks with, not a choice between every engine on the phone.
   */
  @Command
  fun installVoices(invoke: Invoke) {
    activity.runOnUiThread {
      try {
        val install = Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA)
        engine?.defaultEngine?.let { install.setPackage(it) }
        activity.startActivity(install)
        invoke.resolve()
      } catch (_: Exception) {
        invoke.reject("Add voices in the phone's text-to-speech settings")
      }
    }
  }

  @Command
  fun stop(invoke: Invoke) {
    events = null
    activity.runOnUiThread {
      engine?.stop()
      invoke.resolve()
    }
  }
}
