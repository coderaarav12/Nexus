package com.nexus.agent

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        val registered = Prefs(context).getNodeId() != null
        when (action) {
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED -> {
                if (registered) {
                    AgentService.start(context)
                    AgentService.scheduleKick(context)
                    LogBuffer.log("boot: service restarted")
                }
            }
            App.ACTION_KICK -> {
                if (registered) {
                    AgentService.start(context)
                }
            }
        }
    }
}
