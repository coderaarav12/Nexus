package com.nexus.backup

import android.app.Application

class App : Application() {

    override fun onCreate() {
        super.onCreate()
        LogBuffer.restore(this)
        Notifier.createChannel(this)
        val auth = AuthStore(this)
        val prefs = Prefs(this)
        if (auth.isLoggedIn() && prefs.autoBackupDaily) {
            BackupScheduler.schedulePeriodic(this)
        }
    }
}
