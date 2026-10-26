package com.anonymous.junluo

import android.companion.AssociationInfo
import android.companion.CompanionDeviceService

class BodySignalCompanionPresenceService : CompanionDeviceService() {
    override fun onDeviceAppeared(associationInfo: AssociationInfo) {
        super.onDeviceAppeared(associationInfo)
        BodySignalCompanionPresenceLedger.record(applicationContext, associationInfo.id, "appeared")
        BodySignalGuardianController.onPresence(applicationContext, associationInfo.id, true)
    }

    override fun onDeviceDisappeared(associationInfo: AssociationInfo) {
        super.onDeviceDisappeared(associationInfo)
        BodySignalCompanionPresenceLedger.record(applicationContext, associationInfo.id, "disappeared")
        BodySignalGuardianController.onPresence(applicationContext, associationInfo.id, false)
    }
}
