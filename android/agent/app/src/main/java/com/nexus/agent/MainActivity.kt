package com.nexus.agent

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : AppCompatActivity() {

    private val uiScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var prefs: Prefs

    private lateinit var serverUrl: EditText
    private lateinit var nodeName: EditText
    private lateinit var serverInput: View
    private lateinit var nameInput: View
    private lateinit var btnRegister: Button
    private lateinit var btnStart: Button
    private lateinit var btnStop: Button
    private lateinit var btnBattery: Button
    private lateinit var statusCard: LinearLayout
    private lateinit var statusNodeId: TextView
    private lateinit var statusScore: TextView
    private lateinit var statusHeartbeat: TextView
    private lateinit var statusBattery: TextView
    private lateinit var logView: TextView
    private var lastLogText: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        prefs = Prefs(this)

        serverUrl = findViewById(R.id.serverUrl)
        nodeName = findViewById(R.id.nodeName)
        serverInput = findViewById(R.id.serverInput)
        nameInput = findViewById(R.id.nameInput)
        btnRegister = findViewById(R.id.btnRegister)
        btnStart = findViewById(R.id.btnStart)
        btnStop = findViewById(R.id.btnStop)
        btnBattery = findViewById(R.id.btnBattery)
        statusCard = findViewById(R.id.statusCard)
        statusNodeId = findViewById(R.id.statusNodeId)
        statusScore = findViewById(R.id.statusScore)
        statusHeartbeat = findViewById(R.id.statusHeartbeat)
        statusBattery = findViewById(R.id.statusBattery)
        logView = findViewById(R.id.logView)

        serverUrl.setText(prefs.getServerUrl())
        nodeName.setText(prefs.getNodeName() ?: Build.MODEL)

        requestNotificationPermission()
        bindActions()
        refreshState()

        uiScope.launch {
            while (isActive) {
                refreshState()
                updateLog()
                delay(1000)
            }
        }
    }

    override fun onDestroy() {
        uiScope.cancel()
        super.onDestroy()
    }

    private fun bindActions() {
        btnRegister.setOnClickListener { register() }
        btnStart.setOnClickListener {
            AgentService.start(this)
            LogBuffer.log("start service requested")
        }
        btnStop.setOnClickListener {
            AgentService.stop(this)
            LogBuffer.log("stop service requested")
        }
        btnBattery.setOnClickListener { openBatterySettings() }
    }

    private fun register() {
        val url = serverUrl.text.toString().trim().trimEnd('/')
        val name = nodeName.text.toString().trim()
        if (url.isEmpty()) {
            toast("Server URL required")
            return
        }
        if (name.isEmpty()) {
            toast("Node name required")
            return
        }
        btnRegister.isEnabled = false
        uiScope.launch {
            try {
                val api = ServerApi(url)
                val (nodeId, token) = api.register(
                    name,
                    Build.MODEL,
                    "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})"
                )
                prefs.saveRegistration(url, name, nodeId, token)
                LogBuffer.log("registered node $nodeId")
                refreshState()
                toast("Registered")
            } catch (e: Exception) {
                LogBuffer.log("register failed: ${e.message}")
                toast("Register failed: ${e.message}")
            } finally {
                btnRegister.isEnabled = true
            }
        }
    }

    private fun openBatterySettings() {
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        if (!pm.isIgnoringBatteryOptimizations(packageName)) {
            try {
                startActivity(
                    Intent(
                        Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                        Uri.parse("package:$packageName")
                    )
                )
            } catch (e: Exception) {
                startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            }
        } else {
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFICATIONS)
        }
    }

    private fun refreshState() {
        val registered = prefs.getNodeId() != null
        serverInput.visibility = if (registered) View.GONE else View.VISIBLE
        nameInput.visibility = if (registered) View.GONE else View.VISIBLE
        btnRegister.visibility = if (registered) View.GONE else View.VISIBLE
        statusCard.visibility = if (registered) View.VISIBLE else View.GONE

        if (registered) {
            statusNodeId.text = "${getString(R.string.node_id_label)}: ${prefs.getNodeId()}"
            val score = prefs.getLastScore()
            statusScore.text = getString(R.string.score_label) + ": " +
                (if (score != null) String.format(Locale.US, "%.2f", score) else "-")
            val hb = prefs.getLastHeartbeat()
            statusHeartbeat.text = getString(R.string.last_heartbeat_label) + ": " +
                (if (hb > 0) SimpleDateFormat("MM-dd HH:mm:ss", Locale.US).format(Date(hb)) else "never")
        }

        val battery = Metrics.batteryPercent(this)
        val charging = Metrics.charging(this)
        val batteryText = if (battery < 0) "?" else "$battery%" + if (charging) " (charging)" else ""
        statusBattery.text = "${getString(R.string.battery_label)}: $batteryText"
    }

    private fun updateLog() {
        val text = LogBuffer.text()
        if (text != lastLogText) {
            lastLogText = text
            logView.text = text
        }
    }

    private fun toast(msg: String) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
    }

    private companion object {
        const val REQ_NOTIFICATIONS = 100
    }
}
