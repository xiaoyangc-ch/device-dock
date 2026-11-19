package com.devicedock.server

import android.net.LocalServerSocket
import android.util.Log
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.Executors
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

class Server {
    companion object {
        private const val TAG = "DeviceDock.Server"

        @JvmStatic
        fun main(args: Array<String>) {
            try {
                Server().start(args)
            } catch (e: Exception) {
                Log.e(TAG, "Fail to start server", e)
            }
        }
    }

    private val executor = ThreadPoolExecutor(
        4,
        4,
        0L,
        TimeUnit.MILLISECONDS,
        ArrayBlockingQueue(16),
        Executors.defaultThreadFactory()
    ) { runnable, _ ->
        (runnable as? Connection)?.closeQuietly()
        Log.w(TAG, "Too many device service connections")
    }
    fun start(args: Array<String>) {
        Log.i(TAG, "Start server")

        val server = LocalServerSocket("devicedock")
        Log.i(TAG, "Server started, listening on ${server.localSocketAddress}")

        while (true) {
            val conn = Connection(server.accept())
            Log.i(TAG, "Client connected")
            executor.submit(conn)
        }
    }
}
