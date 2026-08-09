package com.nexus.agent

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences.PrefKeyEncryptionScheme
import androidx.security.crypto.EncryptedSharedPreferences.PrefValueEncryptionScheme
import androidx.security.crypto.MasterKey

class Prefs(context: Context) {

    private val appContext = context.applicationContext
    private val regular: SharedPreferences =
        appContext.getSharedPreferences("nexus_agent", Context.MODE_PRIVATE)

    private val secure: SharedPreferences by lazy {
        val masterKey = MasterKey.Builder(appContext)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            appContext,
            "nexus_agent_secure",
            masterKey,
            PrefKeyEncryptionScheme.AES256_SIV,
            PrefValueEncryptionScheme.AES256_GCM
        )
    }

    @Volatile
    private var cachedToken: String? = null

    fun getServerUrl(): String = regular.getString(KEY_SERVER_URL, null) ?: DEFAULT_SERVER_URL

    fun setServerUrl(url: String) {
        regular.edit().putString(KEY_SERVER_URL, url).apply()
    }

    fun getNodeName(): String? = regular.getString(KEY_NODE_NAME, null)

    fun setNodeName(name: String) {
        regular.edit().putString(KEY_NODE_NAME, name).apply()
    }

    fun getNodeId(): String? = regular.getString(KEY_NODE_ID, null)

    fun setNodeId(id: String) {
        regular.edit().putString(KEY_NODE_ID, id).apply()
    }

    fun getToken(): String? {
        cachedToken?.let { return it }
        val t = try {
            secure.getString(KEY_TOKEN, null)
        } catch (e: Exception) {
            null
        }
        cachedToken = t
        return t
    }

    fun setToken(token: String) {
        cachedToken = token
        try {
            secure.edit().putString(KEY_TOKEN, token).apply()
        } catch (e: Exception) {
            LogBuffer.log("could not persist token: ${e.message}")
        }
    }

    fun saveRegistration(url: String, name: String, nodeId: String, token: String) {
        setServerUrl(url)
        setNodeName(name)
        setNodeId(nodeId)
        setToken(token)
    }

    fun getLastScore(): Double? {
        if (!regular.contains(KEY_SCORE)) return null
        return regular.getFloat(KEY_SCORE, 0f).toDouble()
    }

    fun setLastScore(score: Double) {
        regular.edit().putFloat(KEY_SCORE, score.toFloat()).apply()
    }

    fun getLastHeartbeat(): Long = regular.getLong(KEY_HEARTBEAT, 0L)

    fun setLastHeartbeat(ms: Long) {
        regular.edit().putLong(KEY_HEARTBEAT, ms).apply()
    }

    fun getDownloadProgress(jobId: String): Int = regular.getInt("dl_$jobId", 0)

    fun setDownloadProgress(jobId: String, chunksFetched: Int) {
        regular.edit().putInt("dl_$jobId", chunksFetched).apply()
    }

    fun clearJobProgress(jobId: String) {
        regular.edit().remove("dl_$jobId").apply()
    }

    private companion object {
        const val KEY_SERVER_URL = "server_url"
        const val KEY_NODE_NAME = "node_name"
        const val KEY_NODE_ID = "node_id"
        const val KEY_TOKEN = "node_token"
        const val KEY_SCORE = "last_score"
        const val KEY_HEARTBEAT = "last_heartbeat"
        const val DEFAULT_SERVER_URL = "http://192.168.1.100:8080"
    }
}
