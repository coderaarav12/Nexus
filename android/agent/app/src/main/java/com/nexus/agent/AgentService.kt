package com.nexus.agent

import android.app.AlarmManager
import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class AgentService : Service(), RelayWakelock {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var loopJob: Job? = null
    private lateinit var prefs: Prefs
    private lateinit var api: ServerApi
    private lateinit var relay: RelayServer
    private lateinit var jobRunner: JobRunner
    private lateinit var heartbeat: Heartbeat
    private lateinit var wakeLock: PowerManager.WakeLock
    private var wakelockHeld = false
    private val traffic = TrafficCounter()

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs(this)
        api = ServerApi(prefs.getServerUrl())
        relay = RelayServer(api, prefs, LogBuffer)
        jobRunner = JobRunner(api, prefs, cacheDir, relay, this, LogBuffer)
        heartbeat = Heartbeat(this, api, prefs, jobRunner, traffic, LogBuffer)
        wakeLock = (getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "nexus-agent:relay")
            .apply { setReferenceCounted(false) }
        relay.start()
        updateNotification()
        LogBuffer.log("AgentService started")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
        } else {
            ensureLoop()
        }
        return START_STICKY
    }

    private fun ensureLoop() {
        if (loopJob?.isActive == true) return
        loopJob = scope.launch {
            while (isActive) {
                heartbeat.tick()
                updateNotification()
                scheduleKick(this@AgentService)
                delay(3000)
            }
        }
    }

    override fun onDestroy() {
        loopJob?.cancel()
        scope.cancel()
        relay.stop()
        if (wakelockHeld) {
            try {
                wakeLock.release()
            } catch (e: Exception) {
            }
            wakelockHeld = false
        }
        stopForeground(STOP_FOREGROUND_REMOVE)
        cancelKick(this)
        LogBuffer.log("AgentService stopped")
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun acquire() {
        if (wakelockHeld) return
        try {
            wakeLock.acquire()
        } catch (e: Exception) {
        }
        wakelockHeld = true
    }

    override fun release() {
        if (!wakelockHeld) return
        try {
            wakeLock.release()
        } catch (e: Exception) {
        }
        wakelockHeld = false
    }

    private fun updateNotification() {
        val score = prefs.getLastScore()
        val scoreText = if (score != null) String.format(java.util.Locale.US, "%.2f", score) else "-"
        val pi = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification: Notification = NotificationCompat.Builder(this, App.CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.relay_online))
            .setContentText("score $scoreText | relay 0.0.0.0:${RelayServer.RELAY_PORT}")
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(pi)
            .build()
        startForeground(App.NOTIFICATION_ID, notification)
    }

    companion object {
        const val ACTION_STOP = "com.nexus.agent.STOP"
        private const val KICK_DELAY_MS = 3000L

        fun start(context: Context) {
            val intent = Intent(context, AgentService::class.java)
            try {
                context.startForegroundService(intent)
            } catch (e: Exception) {
                LogBuffer.log("start service failed: ${e.message}")
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, AgentService::class.java))
        }

        fun scheduleKick(context: Context) {
            val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val pi = kickPendingIntent(context)
            try {
                am.setExactAndAllowWhileIdle(
                    AlarmManager.RTC_WAKEUP,
                    System.currentTimeMillis() + KICK_DELAY_MS,
                    pi
                )
            } catch (e: SecurityException) {
                am.set(AlarmManager.RTC_WAKEUP, System.currentTimeMillis() + KICK_DELAY_MS, pi)
            }
        }

        fun cancelKick(context: Context) {
            val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            am.cancel(kickPendingIntent(context))
        }

        private fun kickPendingIntent(context: Context): PendingIntent =
            PendingIntent.getBroadcast(
                context,
                0,
                Intent(context, BootReceiver::class.java).setAction(App.ACTION_KICK),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
    }
}
