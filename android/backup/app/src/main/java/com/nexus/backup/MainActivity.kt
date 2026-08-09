package com.nexus.backup

import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Bundle
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.work.WorkInfo
import androidx.work.WorkManager
import com.nexus.backup.databinding.ActivityMainBinding
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var prefs: Prefs
    private var updatingToggles = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        prefs = Prefs(this)

        binding.buttonBackupNow.setOnClickListener {
            BackupScheduler.runNow(this)
            binding.textWorkState.text = "Queued"
        }

        setupToggles()
        observeWork()

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.RESUMED) {
                while (true) {
                    refresh()
                    delay(2000)
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        if (!AuthStore(this).isLoggedIn()) {
            startActivity(Intent(this, OnboardingActivity::class.java))
            return
        }
        refresh()
    }

    private fun setupToggles() {
        binding.switchPhotos.setOnCheckedChangeListener { _, checked ->
            if (updatingToggles) return@setOnCheckedChangeListener
            prefs.photosEnabled = checked
        }
        binding.switchVideos.setOnCheckedChangeListener { _, checked ->
            if (updatingToggles) return@setOnCheckedChangeListener
            prefs.videosEnabled = checked
        }
        binding.switchWifiOnly.setOnCheckedChangeListener { _, checked ->
            if (updatingToggles) return@setOnCheckedChangeListener
            prefs.wifiOnly = checked
            BackupScheduler.schedulePeriodic(this)
        }
        binding.switchChargingOnly.setOnCheckedChangeListener { _, checked ->
            if (updatingToggles) return@setOnCheckedChangeListener
            prefs.chargingOnly = checked
            BackupScheduler.schedulePeriodic(this)
        }
        binding.switchAutoDaily.setOnCheckedChangeListener { _, checked ->
            if (updatingToggles) return@setOnCheckedChangeListener
            prefs.autoBackupDaily = checked
            if (checked) BackupScheduler.schedulePeriodic(this) else BackupScheduler.cancelPeriodic(this)
        }
    }

    private fun observeWork() {
        WorkManager.getInstance(this)
            .getWorkInfosForUniqueWorkLiveData(BackupScheduler.NOW_WORK)
            .observe(this) { infos ->
                val state = infos.firstOrNull()?.state
                binding.textWorkState.text = when (state) {
                    WorkInfo.State.ENQUEUED -> "Queued (waiting for network/charging)"
                    WorkInfo.State.RUNNING -> "Backing up..."
                    WorkInfo.State.SUCCEEDED -> "Finished"
                    WorkInfo.State.FAILED -> "Failed"
                    WorkInfo.State.BLOCKED -> "Waiting for conditions"
                    WorkInfo.State.CANCELLED -> "Cancelled"
                    else -> ""
                }
            }
    }

    private fun refresh() {
        val auth = AuthStore(this)
        binding.textAccount.text = auth.username()
        binding.textServer.text = auth.serverUrl()

        val lastBackup = prefs.lastBackupAt
        binding.textLastBackup.text = getString(
            R.string.last_backup,
            if (lastBackup > 0) {
                SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US).format(Date(lastBackup))
            } else {
                getString(R.string.status_unknown)
            }
        )
        binding.textUploadedCount.text = getString(R.string.uploaded_count, prefs.uploadedThisRun)
        binding.textLastError.text = prefs.lastError.ifEmpty { "" }
        binding.textLastError.visibility = if (prefs.lastError.isEmpty()) View.GONE else View.VISIBLE
        binding.textConditions.text = conditionsLine()
        binding.textLog.text = LogBuffer.dump()

        updatingToggles = true
        binding.switchPhotos.isChecked = prefs.photosEnabled
        binding.switchVideos.isChecked = prefs.videosEnabled
        binding.switchWifiOnly.isChecked = prefs.wifiOnly
        binding.switchChargingOnly.isChecked = prefs.chargingOnly
        binding.switchAutoDaily.isChecked = prefs.autoBackupDaily
        updatingToggles = false
    }

    private fun conditionsLine(): String {
        val cm = getSystemService(ConnectivityManager::class.java)
        val caps = cm.getNetworkCapabilities(cm.activeNetwork)
        val onWifi = caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true ||
            caps?.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) == true

        val bm = getSystemService(BatteryManager::class.java)
        val status = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_STATUS)
        val charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
            status == BatteryManager.BATTERY_STATUS_FULL
        val level = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)

        return "Wi-Fi: ${if (onWifi) "on" else "off"}  |  Battery: $level% ${if (charging) "(charging)" else ""}"
    }
}
