package com.anonymous.junluo

import android.app.IntentService
import android.content.Intent

@Suppress("DEPRECATION")
class BodySignalActivityContextService : IntentService("BodySignalActivityContext") {
    override fun onHandleIntent(intent: Intent?) {
        intent ?: return
        BodySignalActivityContextReceiver().onReceive(this, intent)
    }
}
