package com.nexus.backup

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import java.util.Calendar
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class BackupWorker(appContext: Context, params: WorkerParameters) :
    CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val ctx = applicationContext
        val auth = AuthStore(ctx)
        val prefs = Prefs(ctx)
        LogBuffer.restore(ctx)
        LogBuffer.add(ctx, "backup run starting")

        if (!auth.isLoggedIn()) {
            LogBuffer.add(ctx, "not logged in, skipping")
            return@withContext Result.failure()
        }
        if (!Permissions.hasMedia(ctx)) {
            prefs.lastError = "media permission missing"
            LogBuffer.add(ctx, "media permission missing")
            return@withContext Result.failure()
        }

        val api = ServerApi(ctx, auth)
        var sessionLost = false
        api.sessionLost = { sessionLost = true }

        try {
            val blocked = blockedReason(ctx, prefs)
            if (blocked != null) {
                prefs.lastError = blocked
                LogBuffer.add(ctx, "blocked: $blocked")
                Notifier.notifyBlocked(ctx, blocked)
                return@withContext Result.retry()
            }

            prefs.startRun()
            val uploader = Uploader(ctx, api)
            val folders = FolderResolver(api)
            val after = prefs.lastUploadedDate
            val items = MediaScanner(ctx.contentResolver).scanAll(after)
            LogBuffer.add(ctx, "found ${items.size} media item(s) since date $after")

            var uploaded = 0
            var maxDate = after
            for (item in items) {
                if (sessionLost) break
                if (!prefs.kindEnabled(item.kind)) continue
                val parentId = folders.resolve(item)
                when (val out = uploader.upload(item, parentId)) {
                    is UploadOutcome.Done -> {
                        uploaded++
                        prefs.uploadedThisRun = uploaded
                        LogBuffer.add(ctx, "uploaded ${item.displayName}")
                    }
                    is UploadOutcome.Skipped -> {
                        LogBuffer.add(ctx, "skipped ${item.displayName}: ${out.reason}")
                    }
                    is UploadOutcome.Failed -> {
                        prefs.lastError = out.message
                        LogBuffer.add(ctx, "failed ${item.displayName}: ${out.message}")
                        Notifier.notifyError(ctx, out.message)
                        return@withContext Result.retry()
                    }
                }
                if (item.dateAdded > maxDate) maxDate = item.dateAdded
            }

            if (sessionLost) {
                prefs.lastError = "session expired"
                LogBuffer.add(ctx, "session expired")
                Notifier.notifySessionLost(ctx)
                return@withContext Result.failure()
            }

            prefs.lastUploadedDate = maxDate
            prefs.lastBackupAt = System.currentTimeMillis()
            prefs.lastError = ""
            LogBuffer.add(ctx, "run complete: $uploaded uploaded")
            Notifier.notifyDone(ctx, uploaded)
            Result.success()
        } catch (e: SessionLost) {
            prefs.lastError = "session expired"
            LogBuffer.add(ctx, "session expired")
            Notifier.notifySessionLost(ctx)
            Result.failure()
        } catch (e: Exception) {
            prefs.lastError = e.message ?: "unknown error"
            LogBuffer.add(ctx, "run failed: ${e.message}")
            Notifier.notifyError(ctx, e.message ?: "unknown error")
            Result.retry()
        }
    }

    private fun blockedReason(ctx: Context, prefs: Prefs): String? {
        if (prefs.wifiOnly && !onWifi(ctx)) return "not on Wi-Fi"
        if (prefs.chargingOnly && !charging(ctx)) return "not charging"
        return null
    }

    private fun onWifi(ctx: Context): Boolean {
        val cm = ctx.getSystemService(ConnectivityManager::class.java)
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
    }

    private fun charging(ctx: Context): Boolean {
        val bm = ctx.getSystemService(BatteryManager::class.java)
        val status = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_STATUS)
        return status == BatteryManager.BATTERY_STATUS_CHARGING ||
            status == BatteryManager.BATTERY_STATUS_FULL
    }

    class FolderResolver(private val api: ServerApi) {

        private val cache = HashMap<String, Long?>()

        fun resolve(item: MediaItem): Long? {
            val cal = Calendar.getInstance().apply { timeInMillis = item.mtime }
            val year = "%04d".format(cal.get(Calendar.YEAR))
            val month = "%02d".format(cal.get(Calendar.MONTH) + 1)
            val key = "$year-$month"
            return cache.getOrPut(key) { resolveTree(year, month) }
        }

        private fun resolveTree(year: String, month: String): Long? {
            val backups = findOrCreate("Backups", null) ?: return null
            val yearFolder = findOrCreate(year, backups) ?: return backups
            return findOrCreate(month, yearFolder) ?: yearFolder
        }

        private fun findOrCreate(name: String, parentId: Long?): Long? {
            when (val list = api.listChildren(parentId)) {
                is ApiResult.Success -> {
                    for (item in list.data) {
                        if (item.kind == "folder" && item.name == name) return item.id
                    }
                }
                is ApiResult.Error -> return null
            }
            return when (val created = api.createFolder(name, parentId)) {
                is ApiResult.Success -> created.data
                is ApiResult.Error -> null
            }
        }
    }
}
