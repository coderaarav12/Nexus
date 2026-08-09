package com.nexus.backup

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.CopyOnWriteArrayList

object LogBuffer {

    private const val MAX_LINES = 400
    private const val PERSIST_KEY = "log_lines"

    private val lines = CopyOnWriteArrayList<String>()

    @Synchronized
    fun restore(context: android.content.Context) {
        if (lines.isNotEmpty()) return
        val raw = context.getSharedPreferences("nexus_log", android.content.Context.MODE_PRIVATE)
            .getString(PERSIST_KEY, null) ?: return
        lines.addAll(raw.split("\n"))
    }

    @Synchronized
    fun add(context: android.content.Context, msg: String) {
        val stamp = SimpleDateFormat("MM-dd HH:mm:ss", Locale.US).format(Date())
        lines.add("[$stamp] $msg")
        while (lines.size > MAX_LINES) lines.removeAt(0)
        persist(context)
    }

    private fun persist(context: android.content.Context) {
        val all = lines.joinToString("\n")
        context.getSharedPreferences("nexus_log", android.content.Context.MODE_PRIVATE)
            .edit().putString(PERSIST_KEY, all).apply()
    }

    fun dump(): String = lines.joinToString("\n")
}
