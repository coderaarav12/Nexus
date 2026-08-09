package com.nexus.agent

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.TrafficStats
import android.os.BatteryManager
import android.os.Environment
import android.os.StatFs
import java.io.File
import java.net.Inet4Address
import java.net.NetworkInterface

object Metrics {

    private var cpuInit = false
    private var lastTotal = 0L
    private var lastIdle = 0L

    fun cpuPercent(): Double {
        val (total, idle) = readCpuStats() ?: return 0.0
        if (!cpuInit) {
            cpuInit = true
            lastTotal = total
            lastIdle = idle
            return 0.0
        }
        val dTotal = total - lastTotal
        val dIdle = idle - lastIdle
        lastTotal = total
        lastIdle = idle
        if (dTotal <= 0) return 0.0
        return (dTotal - dIdle).toDouble() / dTotal * 100.0
    }

    private fun readCpuStats(): Pair<Long, Long>? {
        return try {
            val line = File("/proc/stat").readLines().firstOrNull { it.startsWith("cpu ") }
                ?: return null
            val parts = line.trim().split("\\s+".toRegex())
            if (parts.size < 9) return null
            val vals = parts.subList(1, 9).map { it.toLong() }
            val idle = vals[3] + vals[4]
            vals.sum() to idle
        } catch (e: Exception) {
            null
        }
    }

    fun ramTotalBytes(context: Context): Long = memory(context)?.totalMem ?: 0L

    fun ramAvailableBytes(context: Context): Long = memory(context)?.availMem ?: 0L

    private fun memory(context: Context): ActivityManager.MemoryInfo? {
        return try {
            val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            val info = ActivityManager.MemoryInfo()
            am.getMemoryInfo(info)
            info
        } catch (e: Exception) {
            null
        }
    }

    fun batteryPercent(context: Context): Int {
        val i = batteryIntent(context) ?: return -1
        val level = i.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = i.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        if (level < 0 || scale <= 0) return -1
        return level * 100 / scale
    }

    fun charging(context: Context): Boolean {
        val i = batteryIntent(context) ?: return false
        val status = i.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        return status == BatteryManager.BATTERY_STATUS_CHARGING ||
            status == BatteryManager.BATTERY_STATUS_FULL
    }

    fun temperature(context: Context): Double {
        val i = batteryIntent(context) ?: return 0.0
        val tenths = i.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, -1)
        return if (tenths < 0) 0.0 else tenths / 10.0
    }

    private fun batteryIntent(context: Context): Intent? {
        return try {
            context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        } catch (e: Exception) {
            null
        }
    }

    fun storageFree(context: Context): Long {
        return try {
            StatFs(Environment.getDataDirectory().absolutePath).availableBytes
        } catch (e: Exception) {
            0L
        }
    }

    fun lanIp(): String? {
        return try {
            val interfaces = NetworkInterface.getNetworkInterfaces() ?: return null
            val list = interfaces.toList().filter { it.isUp }
            fun ipv4(ni: NetworkInterface): String? {
                val addrs = ni.inetAddresses ?: return null
                return addrs.toList().firstOrNull { !it.isLoopbackAddress && it is Inet4Address }?.hostAddress
            }
            list.firstOrNull { it.name == "wlan0" }?.let { ipv4(it) }
                ?: list.firstOrNull { it.name == "eth0" }?.let { ipv4(it) }
                ?: list.mapNotNull { ipv4(it) }.firstOrNull()
        } catch (e: Exception) {
            null
        }
    }
}

class TrafficCounter {

    private var started = false
    private var lastTx = 0L
    private var lastRx = 0L

    fun deltas(): Pair<Long, Long> {
        var tx = try {
            TrafficStats.getTotalTxBytes()
        } catch (e: Exception) {
            -1L
        }
        var rx = try {
            TrafficStats.getTotalRxBytes()
        } catch (e: Exception) {
            -1L
        }
        if (tx < 0) tx = lastTx
        if (rx < 0) rx = lastRx
        if (!started) {
            started = true
            lastTx = tx
            lastRx = rx
            return 0L to 0L
        }
        val dTx = if (tx >= lastTx) tx - lastTx else tx
        val dRx = if (rx >= lastRx) rx - lastRx else rx
        lastTx = tx
        lastRx = rx
        return dTx to dRx
    }
}
