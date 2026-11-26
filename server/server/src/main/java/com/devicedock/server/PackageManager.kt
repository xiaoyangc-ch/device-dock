package com.devicedock.server

import android.content.pm.PackageInfo
import android.os.IInterface
import android.util.Log
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Method

class PackageManager(private val manager: IInterface) {
    companion object {
        private const val TAG = "DeviceDock.PackageManager"
    }

    private data class GetPackageInfoMethod(
        val method: Method,
        val longFlags: Boolean,
        val argumentCount: Int
    )

    /**
     * Android 13 的 IPackageManager 使用 long flags，老版本和部分 Huawei 定制
     * 接口仍使用 int flags。不能只按 SDK 版本猜，必须按实际方法签名传参。
     */
    private val getPackageInfoMethods: List<GetPackageInfoMethod> by lazy {
        val owners = listOfNotNull(
            manager.javaClass,
            runCatching {
                Class.forName("android.content.pm.IPackageManager")
            }.getOrNull()
        ).distinct()

        owners.asSequence()
            .flatMap { it.methods.asSequence() }
            .filter { it.name == "getPackageInfo" }
            .mapNotNull { method ->
                val types = method.parameterTypes
                if (types.size !in 2..3 || types[0] != String::class.java) {
                    return@mapNotNull null
                }
                val longFlags = types[1] == java.lang.Long.TYPE
                if (!longFlags && types[1] != Integer.TYPE) {
                    return@mapNotNull null
                }
                if (types.size == 3 && types[2] != Integer.TYPE) {
                    return@mapNotNull null
                }
                GetPackageInfoMethod(method, longFlags, types.size)
            }
            // 三项版本可指定用户，优先于二项兼容重载。
            .sortedByDescending { it.argumentCount }
            .distinctBy { it.method.toString() }
            .toList()
    }

    fun getPackageInfo(packageName: String, flags: Int): PackageInfo {
        Log.i(TAG, "Get package info: $packageName")

        var lastError: Throwable? = null
        for (entry in getPackageInfoMethods) {
            // 少数定制 ROM 对签名 flags 报错，但无 flags 仍能返回基础包信息。
            for (requestedFlags in intArrayOf(flags, 0)) {
                try {
                    val flagValue = if (entry.longFlags) {
                        requestedFlags.toLong()
                    } else {
                        requestedFlags
                    }
                    val result = if (entry.argumentCount == 3) {
                        entry.method.invoke(manager, packageName, flagValue, 0)
                    } else {
                        entry.method.invoke(manager, packageName, flagValue)
                    }
                    if (result is PackageInfo) return result
                } catch (e: InvocationTargetException) {
                    lastError = e.targetException ?: e
                } catch (e: Throwable) {
                    lastError = e
                }
            }
        }
        throw AssertionError("No compatible getPackageInfo method", lastError)
    }
}
