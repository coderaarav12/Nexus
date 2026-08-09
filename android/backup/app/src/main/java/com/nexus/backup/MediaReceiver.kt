package com.nexus.backup

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class MediaReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (AuthStore(context).isLoggedIn()) {
            BackupScheduler.runNow(context)
        }
    }
}
