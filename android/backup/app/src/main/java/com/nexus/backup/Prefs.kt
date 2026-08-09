package com.nexus.backup

import android.content.Context
import android.content.SharedPreferences

class Prefs(context: Context) {

    private val sp: SharedPreferences =
        context.applicationContext.getSharedPreferences("nexus_prefs", Context.MODE_PRIVATE)

    var photosEnabled: Boolean
        get() = sp.getBoolean("photos_enabled", true)
        set(v) = sp.edit().putBoolean("photos_enabled", v).apply()

    var videosEnabled: Boolean
        get() = sp.getBoolean("videos_enabled", true)
        set(v) = sp.edit().putBoolean("videos_enabled", v).apply()

    var wifiOnly: Boolean
        get() = sp.getBoolean("wifi_only", true)
        set(v) = sp.edit().putBoolean("wifi_only", v).apply()

    var chargingOnly: Boolean
        get() = sp.getBoolean("charging_only", false)
        set(v) = sp.edit().putBoolean("charging_only", v).apply()

    var autoBackupDaily: Boolean
        get() = sp.getBoolean("auto_backup_daily", true)
        set(v) = sp.edit().putBoolean("auto_backup_daily", v).apply()

    var lastBackupAt: Long
        get() = sp.getLong("last_backup_at", 0L)
        set(v) = sp.edit().putLong("last_backup_at", v).apply()

    var lastError: String
        get() = sp.getString("last_error", null) ?: ""
        set(v) = sp.edit().putString("last_error", v).apply()

    var lastUploadedDate: Long
        get() = sp.getLong("last_uploaded_date", 0L)
        set(v) = sp.edit().putLong("last_uploaded_date", v).apply()

    var uploadedThisRun: Int
        get() = sp.getInt("uploaded_this_run", 0)
        set(v) = sp.edit().putInt("uploaded_this_run", v).apply()

    fun startRun() {
        sp.edit().putInt("uploaded_this_run", 0).apply()
    }

    fun kindEnabled(kind: MediaItem.Kind): Boolean =
        if (kind == MediaItem.Kind.PHOTO) photosEnabled else videosEnabled
}
