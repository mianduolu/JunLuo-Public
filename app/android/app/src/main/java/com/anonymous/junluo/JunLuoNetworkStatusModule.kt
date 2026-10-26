package com.anonymous.junluo

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class JunLuoNetworkStatusModule(
    reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
    override fun getName(): String = "JunLuoNetworkStatus"

    @ReactMethod
    fun getNetworkClass(promise: Promise) {
        try {
            val manager = reactApplicationContext.getSystemService(
                Context.CONNECTIVITY_SERVICE,
            ) as ConnectivityManager
            val network = manager.activeNetwork
            val capabilities = network?.let {
                manager.getNetworkCapabilities(it)
            }
            val connected = capabilities?.hasCapability(
                NetworkCapabilities.NET_CAPABILITY_INTERNET,
            ) == true && capabilities.hasCapability(
                NetworkCapabilities.NET_CAPABILITY_VALIDATED,
            )
            if (!connected) {
                promise.resolve("offline")
                return
            }
            val vpn = capabilities.hasTransport(
                NetworkCapabilities.TRANSPORT_VPN,
            )
            val unmetered = capabilities.hasCapability(
                NetworkCapabilities.NET_CAPABILITY_NOT_METERED,
            )
            val localBroadband = capabilities.hasTransport(
                NetworkCapabilities.TRANSPORT_WIFI,
            ) || capabilities.hasTransport(
                NetworkCapabilities.TRANSPORT_ETHERNET,
            )
            promise.resolve(
                if (!vpn && unmetered && localBroadband) "wifi"
                else "cellular",
            )
        } catch (error: Throwable) {
            promise.reject(
                "JUNLUO_NETWORK_STATUS_FAILED",
                "无法读取当前网络类型。",
                error,
            )
        }
    }
}
