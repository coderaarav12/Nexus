package com.nexus.agent

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build

class App : Application() {

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel(this)
    }

    companion object {
        const val CHANNEL_ID = "nexus-agent"
        const val NOTIFICATION_ID = 1
        const val ACTION_KICK = "com.nexus.agent.ACTION_KICK"

        fun startService(context: Context) {
            val intent = android.content.Intent(context, AgentService::class.java)
            try {
                context.startForegroundService(intent)
            } catch (e: Exception) {
                LogBuffer.log("start service failed: ${e.message}")
            }
        }

        fun createNotificationChannel(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val channel = NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.channel_name),
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = context.getString(R.string.channel_description)
            }
            (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .createNotificationChannel(channel)
        }
    }
}
