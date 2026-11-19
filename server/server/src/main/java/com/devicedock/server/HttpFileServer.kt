package com.devicedock.server

import android.util.Log
import fi.iki.elonen.NanoHTTPD
import fi.iki.elonen.NanoHTTPD.Response.Status
import java.io.File
import java.io.FileInputStream
import java.net.ServerSocket
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

data class FileServerStartResult(val port: Int, val token: String)

class HttpFileServer(
    port: Int,
    private val token: String,
    private val isAllowed: (File) -> Boolean
) : NanoHTTPD("127.0.0.1", port) {
    private companion object {
        private const val TAG = "DeviceDock.HttpFileServer"
    }

    private fun cors(response: Response): Response {
        response.addHeader("Access-Control-Allow-Origin", "*")
        response.addHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        response.addHeader("Access-Control-Allow-Headers", "Range")
        response.addHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")
        response.addHeader("Referrer-Policy", "no-referrer")
        response.addHeader("Cache-Control", "private, no-store")
        return response
    }

    override fun serve(session: IHTTPSession): Response {
        val rawPath = session.uri
        val suppliedToken = session.parameters["token"]?.firstOrNull() ?: ""
        if (token.isEmpty() || !MessageDigest.isEqual(
                token.toByteArray(Charsets.UTF_8),
                suppliedToken.toByteArray(Charsets.UTF_8)
            )
        ) {
            return cors(newFixedLengthResponse(Status.FORBIDDEN, "text/plain", "Forbidden"))
        }
        if (session.method == Method.OPTIONS) {
            return cors(newFixedLengthResponse(Status.NO_CONTENT, "text/plain", ""))
        }

        // NanoHTTPD 的 uri 已经是 percent-decoded，不能再解一次。
        val decoded = rawPath
        val target = try {
            File(decoded).canonicalFile
        } catch (e: Exception) {
            return cors(newFixedLengthResponse(Status.BAD_REQUEST, "text/plain", "Bad Request"))
        }

        Log.d(HttpFileServer.TAG, "Request file: $rawPath")

        if (!target.exists() || target.isDirectory || !isAllowed(target)) {
            return cors(newFixedLengthResponse(Status.NOT_FOUND, "text/plain", "Not Found"))
        }

        val total = target.length()
        val mime = when {
            target.name.endsWith(".pdf", ignoreCase = true) -> "application/pdf"
            else -> getMimeTypeForFile(target.name)
        }

        val rangeHeader = session.headers["range"]
        if (rangeHeader != null) {
            val m = Regex("""bytes=(\d*)-(\d*)""").find(rangeHeader)
            if (m != null) {
                val (s, e) = m.destructured
                val suffixLength = if (s.isEmpty()) e.toLongOrNull() else null
                val start = suffixLength?.let {
                    (total - it).coerceAtLeast(0)
                } ?: s.toLongOrNull() ?: 0L
                val end = if (suffixLength != null) {
                    total - 1
                } else {
                    (e.toLongOrNull() ?: (total - 1)).coerceAtMost(total - 1)
                }
                if (start in 0 until total && end >= start) {
                    val length = end - start + 1
                    val fis = FileInputStream(target)
                    var remainingSkip = start
                    while (remainingSkip > 0) {
                        val skipped = fis.skip(remainingSkip)
                        if (skipped <= 0) break
                        remainingSkip -= skipped
                    }
                    if (remainingSkip > 0) {
                        fis.close()
                        return cors(newFixedLengthResponse(
                            Status.INTERNAL_ERROR,
                            "text/plain",
                            "Unable to seek file"
                        ))
                    }

                    val resp = newFixedLengthResponse(Status.PARTIAL_CONTENT, mime, fis, length)
                    resp.addHeader("Accept-Ranges", "bytes")
                    resp.addHeader("Content-Range", "bytes $start-$end/$total")
                    resp.addHeader("Connection", "close")
                    return cors(resp)
                } else {
                    val resp = newFixedLengthResponse(
                        Status.RANGE_NOT_SATISFIABLE,
                        mime,
                        ""
                    )
                    resp.addHeader("Content-Range", "bytes */$total")
                    return cors(resp)
                }
            }
        }

        if (session.method == Method.HEAD) {
            val resp = newFixedLengthResponse(Status.OK, mime, "")
            resp.addHeader("Accept-Ranges", "bytes")
            resp.addHeader("Content-Length", total.toString())
            return cors(resp)
        }

        val fis = FileInputStream(target)
        val resp = newFixedLengthResponse(Status.OK, mime, fis, total)
        resp.addHeader("Accept-Ranges", "bytes")
        resp.addHeader("Connection", "close")
        return cors(resp)
    }
}

object HttpFileServerManager {
    private const val ICON_ALLOW_MS = 30 * 60 * 1000L
    private const val FILE_ALLOW_MS = 10 * 60 * 1000L
    private val iconRoot = File("/data/local/tmp/devicedock/icons").canonicalFile

    @Volatile
    private var server: HttpFileServer? = null
    @Volatile
    private var token = ""
    private val allowedFiles = ConcurrentHashMap<String, Long>()

    @Synchronized
    fun start(): FileServerStartResult {
        stop()
        val nextToken = UUID.randomUUID().toString().replace("-", "")
        var port = 9001
        repeat(100) {
            if (isPortAvailable(port)) {
                val srv = HttpFileServer(port, nextToken) { file ->
                    val path = file.canonicalPath
                    val now = System.currentTimeMillis()
                    val isIcon = path.startsWith(iconRoot.canonicalPath + File.separator)
                    val expiresAt = allowedFiles[path]
                    if (isIcon) {
                        true
                    } else if (expiresAt != null && expiresAt >= now) {
                        allowedFiles[path] = now + FILE_ALLOW_MS
                        true
                    } else {
                        false
                    }
                }
                token = nextToken
                srv.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false)
                server = srv
                return FileServerStartResult(port, token)
            }
            port++
        }
        throw IllegalStateException("No available port found")
    }

    @Synchronized
    fun stop() {
        server?.stop()
        server = null
        token = ""
        allowedFiles.clear()
    }

    @Synchronized
    fun isRunning(): Boolean {
        return server?.isAlive ?: false
    }

    @Synchronized
    fun allowFile(path: String, suppliedToken: String): Boolean {
        if (token.isEmpty() || !MessageDigest.isEqual(
                token.toByteArray(Charsets.UTF_8),
                suppliedToken.toByteArray(Charsets.UTF_8)
            )
        ) {
            return false
        }

        val file = try {
            File(path).canonicalFile
        } catch (e: Exception) {
            return false
        }
        if (!file.exists() || file.isDirectory) return false

        val now = System.currentTimeMillis()
        val iterator = allowedFiles.entries.iterator()
        while (iterator.hasNext()) {
            if (iterator.next().value < now) iterator.remove()
        }
        allowedFiles[file.path] = now + FILE_ALLOW_MS
        if (file.path.startsWith(iconRoot.path + File.separator)) {
            allowedFiles[file.path] = now + ICON_ALLOW_MS
        }
        return true
    }

    private fun isPortAvailable(port: Int): Boolean {
        return try {
            ServerSocket(port).use { true }
        } catch (e: Exception) {
            false
        }
    }
}
