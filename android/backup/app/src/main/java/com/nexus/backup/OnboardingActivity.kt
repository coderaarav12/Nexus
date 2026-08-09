package com.nexus.backup

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.nexus.backup.databinding.ActivityOnboardingBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class OnboardingActivity : AppCompatActivity() {

    private lateinit var binding: ActivityOnboardingBinding
    private var grantToken: String? = null

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
            finish()
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityOnboardingBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.buttonLogin.setOnClickListener { onSubmit() }
    }

    private fun onSubmit() {
        val server = normalizeServer(binding.inputServer.text.toString())
        val username = binding.inputUsername.text.toString().trim()
        val password = binding.inputPassword.text.toString()
        if (server.isEmpty() || username.isEmpty() || password.isEmpty()) {
            toast("Server, username and password are required")
            return
        }

        val pending = grantToken
        if (pending != null) {
            val code = binding.inputMfa.text.toString().trim()
            if (code.isEmpty()) {
                toast("Enter your 6-digit verification code")
                return
            }
            verifyMfa(pending, code)
            return
        }

        login(server, username, password)
    }

    private fun login(server: String, username: String, password: String) {
        setBusy(true)
        lifecycleScope.launch {
            val auth = AuthStore(this@OnboardingActivity)
            auth.saveServer(server, username)
            val api = ServerApi(this@OnboardingActivity, auth)
            val result = withContext(Dispatchers.IO) { api.login(username, password) }
            setBusy(false)
            when (result) {
                is ApiResult.Error -> toast(result.message)
                is ApiResult.Success -> {
                    LogBuffer.add(this@OnboardingActivity, "login ok, mfa=${result.data.mfaRequired}")
                    if (result.data.mfaRequired) {
                        grantToken = result.data.grantToken
                        binding.layoutMfa.visibility = View.VISIBLE
                        binding.buttonLogin.text = getString(R.string.mfa_hint)
                    } else {
                        registerDevice(result.data.grantToken)
                    }
                }
            }
        }
    }

    private fun verifyMfa(grant: String, code: String) {
        setBusy(true)
        lifecycleScope.launch {
            val api = ServerApi(this@OnboardingActivity, AuthStore(this@OnboardingActivity))
            val result = withContext(Dispatchers.IO) { api.mfa(grant, code) }
            setBusy(false)
            when (result) {
                is ApiResult.Error -> toast(result.message)
                is ApiResult.Success -> registerDevice(result.data)
            }
        }
    }

    private fun registerDevice(grant: String) {
        setBusy(true)
        lifecycleScope.launch {
            val api = ServerApi(this@OnboardingActivity, AuthStore(this@OnboardingActivity))
            val result = withContext(Dispatchers.IO) {
                api.registerDevice(grant, "Phone Backup", "android", Build.VERSION.RELEASE)
            }
            setBusy(false)
            when (result) {
                is ApiResult.Error -> toast(result.message)
                is ApiResult.Success -> onRegistered()
            }
        }
    }

    private fun onRegistered() {
        LogBuffer.add(this, "device registered")
        val prefs = Prefs(this)
        if (prefs.autoBackupDaily) BackupScheduler.schedulePeriodic(this)
        requestPermissions()
    }

    private fun requestPermissions() {
        permissionLauncher.launch(Permissions.needed())
    }

    private fun normalizeServer(raw: String): String {
        var s = raw.trim().trimEnd('/')
        if (s.isEmpty()) return s
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://$s"
        return s
    }

    private fun setBusy(busy: Boolean) {
        binding.buttonLogin.isEnabled = !busy
        binding.progress.visibility = if (busy) View.VISIBLE else View.GONE
    }

    private fun toast(msg: String) {
        Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
    }
}
