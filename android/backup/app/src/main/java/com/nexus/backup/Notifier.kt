package com.nexus.backup

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

object Notifier {

    private const val CHANNEL_ID = "backup"
    private const val NOTIF_ID = 101

    fun createChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(CHANNEL_ID, "Backups", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Nexus backup progress and results"
        }
        manager.createNotificationChannel(channel)
    }

    private fun canNotify(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED

    private fun notify(context: Context, title: String, text: String) {
        if (!canNotify(context)) return
        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setContentTitle(title)
            .setContentText(text)
            .setAutoCancel(true)
        context.getSystemService(NotificationManager::class.java).notify(NOTIF_ID, builder.build())
    }

    fun notifyDone(context: Context, uploaded: Int) {
        notify(context, "Backup complete", if (uploaded > 0) "$uploaded file(s) uploaded" else "Nothing new to upload")
    }

    fun notifyBlocked(context: Context, reason: String) {
        notify(context, "Backup waiting", reason)
    }

    fun notifyError(context: Context, message: String) {
        notify(context, "Backup failed", message)
    }

    fun notifySessionLost(context: Context) {
        notify(context, "Session expired", "Sign in again to continue backups")
    }
}
