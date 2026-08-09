package com.nexus.agent

import android.content.Context
import org.json.JSONObject

class Heartbeat(
    private val context: Context,
    private val api: ServerApi,
    private val prefs: Prefs,
    private val jobRunner: JobRunner,
    private val traffic: TrafficCounter,
    private val log: LogBuffer
) {

    suspend fun tick(): ServerApi.Heartbeat? {
        val token = prefs.getToken() ?: return null
        val appContext = context.applicationContext
        val (tx, rx) = traffic.deltas()
        val body = JSONObject()
            .put("cpu", Metrics.cpuPercent())
            .put("ramTotal", Metrics.ramTotalBytes(appContext))
            .put("ramAvailable", Metrics.ramAvailableBytes(appContext))
            .put("battery", Metrics.batteryPercent(appContext))
            .put("charging", Metrics.charging(appContext))
            .put("temp", Metrics.temperature(appContext))
            .put("storageFree", Metrics.storageFree(appContext))
            .put("activeTransfers", jobRunner.activeCount())
            .put("lanIp", Metrics.lanIp() ?: "")
            .put("lanPort", RelayServer.RELAY_PORT)
            .put("bytesSentSinceLast", tx)
            .put("bytesRecvSinceLast", rx)
            .put("sentAt", System.currentTimeMillis())
        return try {
            val hb = api.heartbeat(token, body)
            prefs.setLastScore(hb.score)
            prefs.setLastHeartbeat(hb.now)
            if (hb.jobs.isNotEmpty()) jobRunner.enqueue(hb.jobs)
            hb
        } catch (e: Exception) {
            log.log("heartbeat failed: ${e.message}")
            null
        }
    }
}
