package com.nexus.agent

import android.util.Log
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

object LogBuffer {

    private const val MAX_LINES = 80
    private const val TAG = "NexusAgent"
    private val lines = ArrayDeque<String>()

    @Synchronized
    fun log(msg: String) {
        val stamp = SimpleDateFormat("MM-dd HH:mm:ss", Locale.US).format(Date())
        lines.addLast("[$stamp] $msg")
        while (lines.size > MAX_LINES) lines.removeFirst()
        Log.i(TAG, msg)
    }

    @Synchronized
    fun text(): String = lines.joinToString("\n")
}
