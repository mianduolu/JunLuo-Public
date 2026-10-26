package com.anonymous.junluo.camera

import android.content.Intent
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/** Manifest compatibility only; a queued Chapter 12 intent must never revive observation. */
class JunLuoCameraObservationTaskService : HeadlessJsTaskService() {
    override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? = null
}
