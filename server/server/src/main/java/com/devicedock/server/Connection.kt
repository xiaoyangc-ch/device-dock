package com.devicedock.server

import android.annotation.TargetApi
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.res.AssetManager
import android.content.res.Configuration
import android.content.res.Resources
import android.net.LocalSocket
import android.os.Build
import android.util.Base64
import android.util.DisplayMetrics
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap

class Connection(private val client: LocalSocket) : Thread() {
    private companion object {
        private const val TAG = "DeviceDock.Connection"
        private val packageCache = ConcurrentHashMap<String, JSONObject>()
        private const val ICON_CACHE_DIR = "/data/local/tmp/devicedock/icons"
        private const val PROTOCOL_VERSION = 2

        init {
            val iconCacheDir = File(ICON_CACHE_DIR)
            if (!iconCacheDir.exists()) {
                iconCacheDir.mkdirs()
            }
        }
    }

    override fun run() {
        while (!isInterrupted && client.isConnected) {
            try {
                val request = Wire.Request.parseDelimitedFrom(client.inputStream)
                val params = request.params.ifEmpty { "{}" }
                handleRequest(request.id, request.method, params)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to handle request", e)
                break
            }
        }

        client.close()
        Log.i(TAG, "Client disconnected")
    }

    private fun handleRequest(id: String, method: String, params: String) {
        Log.i(TAG, "Request method: $method")

        val result = JSONObject()

        when (method) {
            "getVersion" -> {
                result.put("version", getVersion())
                result.put("protocolVersion", PROTOCOL_VERSION)
            }

            "shutdown" -> {
                result.put("ok", true)
            }

            "getPackageInfos" -> {
                result.put("packageInfos", getPackageInfos(JSONObject(params)))
            }

            "startFileServer" -> {
                val started = HttpFileServerManager.start()
                result.put("port", started.port)
                result.put("token", started.token)
            }

            "isFileServerRunning" -> {
                val running = HttpFileServerManager.isRunning()
                result.put("running", running)
            }

            "allowFile" -> {
                val data = JSONObject(params)
                val allowed = HttpFileServerManager.allowFile(
                    data.getString("path"),
                    data.getString("token")
                )
                result.put("allowed", allowed)
            }

            else -> {
                Log.e(TAG, "Unknown method: $method")
            }
        }

        val response = result.toString()
        Log.d(TAG, "Response method=$method size=${response.length}")
        Wire.Response.newBuilder().setId(id).setResult(response).build()
            .writeDelimitedTo(client.outputStream)
        client.outputStream.flush()

        if (method == "shutdown") {
            HttpFileServerManager.stop()
            Runtime.getRuntime().halt(0)
        }
    }

    fun closeQuietly() {
        interrupt()
        try {
            client.close()
        } catch (_: Exception) {
            // already closed
        }
    }

    private fun getVersion(): String {
        return BuildConfig.VERSION_NAME
    }

    private fun getPackageInfos(params: JSONObject): JSONArray {
        val packageNames = Util.jsonArrayToStringArray(params.getJSONArray("packageNames"))
        val result = JSONArray()

        packageNames.forEach {
            try {
                result.put(getPackageInfo(it))
            } catch (e: Exception) {
                Log.e(TAG, "Fail to get package info", e)
            }
        }

        return result
    }

    @TargetApi(Build.VERSION_CODES.P)
    private fun getPackageInfo(packageName: String): JSONObject {
        var flags = PackageManager.GET_ACTIVITIES
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            flags = flags or PackageManager.GET_SIGNING_CERTIFICATES
        } else {
            flags = flags or PackageManager.GET_SIGNATURES
        }
        val packageInfo =
            ServiceManager.packageManager.getPackageInfo(packageName, flags)

        val info = JSONObject()
        info.put("packageName", packageInfo.packageName)
        info.put("versionName", packageInfo.versionName)
        info.put("firstInstallTime", packageInfo.firstInstallTime)
        info.put("lastUpdateTime", packageInfo.lastUpdateTime)
        info.put("signatures", getSignatures(packageInfo))

        val applicationInfo = packageInfo.applicationInfo
            ?: throw IllegalStateException("Missing ApplicationInfo for $packageName")
        var apkSize = 0L
        val apkPaths = listOf(applicationInfo.publicSourceDir, applicationInfo.sourceDir)
            .filter { !it.isNullOrBlank() }
        val apkPath = apkPaths.firstOrNull { File(it).exists() }
            ?: apkPaths.firstOrNull()
            ?: ""
        if (apkPath.isNotEmpty()) {
            apkSize = File(apkPath).length()
        }
        info.put("apkPath", apkPath)
        info.put("apkSize", apkSize)
        info.put("enabled", applicationInfo.enabled)

        var system = false
        if ((applicationInfo.flags and ApplicationInfo.FLAG_SYSTEM) == ApplicationInfo.FLAG_SYSTEM) {
            system = true
        }
        info.put("system", system)

        var label = packageName

        val cacheKey = "$packageName.$apkSize.${packageInfo.lastUpdateTime}"
        var icon = ""

        val cacheInfo = packageCache[cacheKey]
        if (cacheInfo != null) {
            label = cacheInfo.getString("label")
            icon = cacheInfo.getString("icon")
        } else {
            val resources = if (apkPath.isNotEmpty()) {
                try {
                    getResources(apkPath)
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to open resources for $packageName", e)
                    null
                }
            } else {
                null
            }
            val labelRes = applicationInfo.labelRes
            val nonLocalizedLabel = applicationInfo.nonLocalizedLabel?.toString()
            if (!nonLocalizedLabel.isNullOrBlank()) {
                label = nonLocalizedLabel
            } else if (labelRes != 0 && resources != null) {
                try {
                    label = resources.getString(labelRes)
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to get label for $packageName")
                }
            }

            if (applicationInfo.icon != 0 && resources != null) {
                try {
                    icon = "$ICON_CACHE_DIR/$cacheKey.png"
                    val file = File(icon)
                    if (!file.exists()) {
                        val resIcon = resources.getDrawable(applicationInfo.icon)
                        val bitmapIcon = Util.drawableToBitmap(resIcon)
                        val pngIcon = Util.bitMapToPng(bitmapIcon, 20)
                        file.writeBytes(pngIcon)
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to get icon for $packageName")
                }
            }
            val cacheInfo = JSONObject()
            cacheInfo.put("label", label)
            cacheInfo.put("icon", icon)
            packageCache[cacheKey] = cacheInfo
        }
        info.put("label", label)
        info.put("icon", icon)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            info.put("minSdkVersion", applicationInfo.minSdkVersion)
            info.put("targetSdkVersion", applicationInfo.targetSdkVersion)
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            try {
                val stats = ServiceManager.storageStatsManager.queryStatsForPackage(
                    packageName
                )
                info.put("appSize", stats.appBytes)
                info.put("dataSize", stats.dataBytes)
                info.put("cacheSize", stats.cacheBytes)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to get storage stats for $packageName", e)
            }
        }

        return info
    }

    private fun getResources(apkPath: String): Resources {
        // Android 6 上 AssetManager/Resources 的构造器均为隐藏 API。
        // 直接实例化在不同定制 ROM 上会被替换或拒绝，这里逐个反射兼容。
        val constructors = AssetManager::class.java.declaredConstructors.sortedBy {
            it.parameterCount
        }
        val constructor = constructors.firstOrNull()
            ?: throw IllegalStateException("AssetManager constructor missing")
        constructor.isAccessible = true
        val assetManager = if (constructor.parameterCount == 0) {
            constructor.newInstance() as AssetManager
        } else {
            constructor.newInstance(false) as AssetManager
        }
        val addAssetManagerMethod = assetManager.javaClass.methods.firstOrNull {
            it.name == "addAssetPath" &&
                it.parameterCount == 1 &&
                it.parameterTypes[0] == String::class.java
        } ?: throw IllegalStateException("addAssetPath missing")
        addAssetManagerMethod.isAccessible = true
        addAssetManagerMethod.invoke(assetManager, apkPath)

        val displayMetrics = DisplayMetrics()
        displayMetrics.setToDefaults()
        val configuration = Configuration()
        configuration.setToDefaults()

        val resourcesConstructor = Resources::class.java.declaredConstructors
            .firstOrNull {
                it.parameterCount == 3 &&
                    it.parameterTypes[0] == AssetManager::class.java &&
                    it.parameterTypes[1] == DisplayMetrics::class.java &&
                    it.parameterTypes[2] == Configuration::class.java
            } ?: throw IllegalStateException("Resources constructor missing")
        resourcesConstructor.isAccessible = true
        return resourcesConstructor.newInstance(
            assetManager,
            displayMetrics,
            configuration
        ) as Resources
    }

    private fun getSignatures(packageInfo: PackageInfo): JSONArray {
        val signatures = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                packageInfo.signingInfo?.apkContentsSigners ?: emptyArray()
            } else {
                packageInfo.signatures ?: emptyArray()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to get signatures for ${packageInfo.packageName}", e)
            emptyArray()
        }

        val array = JSONArray()
        signatures.forEach {
            array.put(Base64.encodeToString(it.toByteArray(), Base64.NO_WRAP))
        }
        return array
    }
}
