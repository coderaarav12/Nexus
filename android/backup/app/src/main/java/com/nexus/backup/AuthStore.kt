package com.nexus.backup

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

class AuthStore(context: Context) {

    private val appContext = context.applicationContext
    private val sp: SharedPreferences = build(appContext)

    private fun build(ctx: Context): SharedPreferences {
        val masterKey = MasterKey.Builder(ctx)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        return EncryptedSharedPreferences.create(
            ctx,
            "nexus_auth",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    fun serverUrl(): String = sp.getString("server_url", null) ?: ""

    fun username(): String = sp.getString("username", null) ?: ""

    fun accessToken(): String? = sp.getString("access_token", null)

    fun refreshToken(): String? = sp.getString("refresh_token", null)

    fun deviceId(): String = sp.getString("device_id", null) ?: ""

    fun isLoggedIn(): Boolean = accessToken() != null

    fun saveServer(url: String, username: String) {
        sp.edit().putString("server_url", url).putString("username", username).apply()
    }

    fun saveTokens(access: String, refresh: String) {
        sp.edit().putString("access_token", access).putString("refresh_token", refresh).apply()
    }

    fun saveDevice(deviceId: String, access: String, refresh: String) {
        sp.edit()
            .putString("device_id", deviceId)
            .putString("access_token", access)
            .putString("refresh_token", refresh)
            .apply()
    }

    fun clear() {
        sp.edit().clear().apply()
    }
}
