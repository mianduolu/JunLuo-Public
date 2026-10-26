package __PACKAGE_NAME__.camera

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class JunLuoCameraAutomaticObservationAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        // Old installed alarms are inert: no service start, no capture, no JS task.
        if (intent?.action == ACTION) JunLuoCameraAutomaticObservationScheduler.cancelAlarm(context)
    }

    companion object {
        const val ACTION = "com.anonymous.junluo.camera.action.AUTOMATIC_ALARM"
        const val EXTRA_GENERATION = "automatic_generation"
    }
}
