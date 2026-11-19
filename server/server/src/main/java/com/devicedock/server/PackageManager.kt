package com.devicedock.server

import android.content.pm.PackageInfo
import android.os.IInterface
import android.util.Log
import java.lang.reflect.Method

class PackageManager(private val manager: IInterface) {
    companion object {
        private const val TAG = "DeviceDock.PackageManager"
    }

    private data class GetPackageInfoMethod(
        val method: Method,
        val longFlags: Boolean
    )

    /**
     * Android 13 的 IPackageManager 使用 long flags，老版本和部分 Huawei 定制
     * 接口仍使用 int flags。不能只按 SDK 版本猜，必须按实际方法签名传参。
     */
    private val getPackageInfoMethods: List<GetPackageInfoMethod> by lazy {
        listOf(
            runCatching {
                manager.javaClass.getMethod(
                    "getPackageInfo",
                    String::class.java, java.lang.Long.TYPE, Integer.TYPE
                )
            }.getOrNull()?.let { GetPackageInfoMethod(it, true) },
            runCatching {
                manager.javaClass.getMethod(
                    "getPackageInfo",
                    String::class.java, Integer.TYPE, Integer.TYPE
                )
            }.getOrNull()?.let { GetPackageInfoMethod(it, false) }
        ).filterNotNull()
    }

    fun getPackageInfo(packageName: String, flags: Int): PackageInfo {
        Log.i(TAG, "Get package info: $packageName")

        var lastError: Exception? = null
        for (entry in getPackageInfoMethods) {
            try {
                val flagValue = if (entry.longFlags) flags.toLong() else flags
                val result = entry.method.invoke(manager, packageName, flagValue, 0)
                if (result is PackageInfo) return result
            } catch (e: Exception) {
                lastError = e
            }
        }
        throw AssertionError("No compatible getPackageInfo method", lastError)
    }
}
