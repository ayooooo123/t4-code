package com.lycaonsolutions.t4code

import android.os.SystemClock
import android.util.Base64
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.hyperdht.HyperDHT
import com.hyperdht.Stream
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import java.util.UUID

@CapacitorPlugin(name = "T4PeerConnection")
class T4PeerConnectionPlugin : Plugin() {
    private data class Session(
        val stream: Stream,
        val receiveJob: Job,
    )

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val sessions = mutableMapOf<String, Session>()
    private var opening = false
    private var openingAttemptId: String? = null
    private var openingJob: Job? = null
    private var pausedAtElapsedMs: Long? = null
    private var resetDhtBeforeNextOpen = false
    private var suspendedDht: HyperDHT? = null

    @PluginMethod
    fun open(call: PluginCall) {
        val key = decode(call.getString("publicKey"))
        val attemptId = call.getString("attemptId")
        if (key == null || key.size != 32) {
            call.reject("Invalid desktop peer key.")
            return
        }
        if (attemptId == null || attemptId.isEmpty() || attemptId.length > 128) {
            call.reject("Invalid private connection attempt.")
            return
        }
        try {
            T4PeerConnectionService.start(context)
        } catch (_: RuntimeException) {
            call.reject("Could not start the private connection service.")
            return
        }
        synchronized(sessions) {
            if (opening || sessions.isNotEmpty()) {
                call.reject("Only one private mobile connection can be active.")
                return
            }
            opening = true
            openingAttemptId = attemptId
        }
        val job = scope.launch {
            var dht: HyperDHT? = null
            var phase = "starting DHT"
            try {
                val retiredDht = synchronized(sessions) {
                    if (!resetDhtBeforeNextOpen) null else {
                        resetDhtBeforeNextOpen = false
                        T4PeerConnectionService.retireDht()
                    }
                }
                if (retiredDht != null) {
                    Log.i(TAG, "Recreating private DHT after an extended background interval.")
                }
                try { retiredDht?.close() } catch (_: Exception) {}
                // A rapid background/foreground cycle can leave the shared node
                // suspended: pause fires while the service is still inactive and
                // the resume-side wake races the service start. A suspended node
                // cannot bootstrap or hole-punch, so every open clears that first.
                resumeSuspendedDht(exclude = retiredDht)
                val activeDht = dht()
                dht = activeDht
                withTimeout(NATIVE_OPEN_TIMEOUT_MS) {
                    phase = "bootstrapping"
                    activeDht.awaitBootstrapped()
                    phase = "discovering peer"
                    val stream = activeDht.connect(key)
                    phase = "opening stream"
                    stream.awaitOpen()
                    val id = UUID.randomUUID().toString()
                    val receiveJob = scope.launch {
                        try {
                            stream.data.collect { bytes ->
                                notifyListeners("peerData", JSObject().apply {
                                    put("sessionId", id)
                                    put("data", Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING))
                                })
                            }
                        } finally {
                            closeSession(id, false)
                            notifyListeners("peerClosed", JSObject().apply { put("sessionId", id) })
                        }
                    }
                    synchronized(sessions) {
                        sessions[id] = Session(stream, receiveJob)
                        opening = false
                        openingAttemptId = null
                        openingJob = null
                    }
                    call.resolve(JSObject().apply { put("sessionId", id) })
                }
            } catch (error: Exception) {
                val network = dht?.let {
                    "online=${it.isOnline} bootstrapped=${it.isBootstrapped} degraded=${it.isDegraded} " +
                        "punch=${it.punchStats} relay=${it.relayStats}"
                } ?: "DHT unavailable"
                Log.w(TAG, "Private connection failed during $phase: $network", error)
                synchronized(sessions) {
                    if (openingAttemptId == attemptId) {
                        opening = false
                        openingAttemptId = null
                        openingJob = null
                    }
                }
                val message = if (error is TimeoutCancellationException) {
                    "Private mobile connection timed out. Generate a fresh key and try again."
                } else {
                    "Could not establish the private mobile connection."
                }
                call.reject(message)
            }
        }
        synchronized(sessions) { if (openingAttemptId == attemptId) openingJob = job }
    }

    @PluginMethod
    fun cancelOpen(call: PluginCall) {
        val attemptId = call.getString("attemptId")
        if (attemptId == null) {
            call.reject("Missing private connection attempt.")
            return
        }
        val pending = synchronized(sessions) {
            if (openingAttemptId != attemptId) null else {
                val current = openingJob
                opening = false
                openingAttemptId = null
                openingJob = null
                current
            }
        }
        pending?.cancel()
        call.resolve()
    }

    @PluginMethod
    fun write(call: PluginCall) {
        val id = call.getString("sessionId")
        val data = decode(call.getString("data"))
        if (id == null || data == null || data.size > MAX_MESSAGE_BYTES) {
            call.reject("Invalid private connection message.")
            return
        }
        val session = synchronized(sessions) { sessions[id] }
        if (session == null) {
            call.reject("Private mobile connection is closed.")
            return
        }
        scope.launch {
            try {
                session.stream.write(data)
                call.resolve()
            } catch (_: Exception) {
                call.reject("Could not write to the private mobile connection.")
            }
        }
    }

    @PluginMethod
    fun close(call: PluginCall) {
        val id = call.getString("sessionId")
        if (id == null) {
            call.reject("Missing private connection identifier.")
            return
        }
        scope.launch {
            closeSession(id, true)
            call.resolve()
        }
    }

    override fun handleOnPause() {
        val toSuspend = synchronized(sessions) {
            pausedAtElapsedMs = SystemClock.elapsedRealtime()
            val idle = !opening && sessions.isEmpty() && !T4PeerConnectionService.isActive()
            if (!idle || suspendedDht != null) null
            else T4PeerConnectionService.currentDht()?.also { suspendedDht = it }
        }
        toSuspend?.suspend()
        super.handleOnPause()
    }

    override fun handleOnResume() {
        super.handleOnResume()
        val now = SystemClock.elapsedRealtime()
        synchronized(sessions) {
            val pausedAt = pausedAtElapsedMs
            pausedAtElapsedMs = null
            if (!T4PeerConnectionService.isActive() && pausedAt != null && now - pausedAt >= LONG_BACKGROUND_RESET_MS) {
                resetDhtBeforeNextOpen = true
            }
        }
        // Resume regardless of the service flag: the service may have started
        // between pause and resume, which previously stranded the node suspended.
        resumeSuspendedDht(exclude = null)
    }

    override fun handleOnDestroy() {
        val ids = synchronized(sessions) { sessions.keys.toList() }
        for (id in ids) closeSession(id, true)
        scope.cancel()
        super.handleOnDestroy()
    }

    private fun closeSession(id: String, cancelReceiver: Boolean) {
        val session = synchronized(sessions) { sessions.remove(id) } ?: return
        if (cancelReceiver) session.receiveJob.cancel()
        try { session.stream.close() } catch (_: Exception) {}
    }

    /**
     * Resume whatever this plugin suspended, even if the foreground service
     * started in the meantime. suspend()/resume() are serialized on the DHT
     * loop executor, so resuming the tracked instance is ordered after a
     * still-queued suspend from a rapid pause/resume cycle. The isSuspended
     * fallback covers a recreated plugin instance that inherited a suspended
     * node it never tracked.
     */
    private fun resumeSuspendedDht(exclude: HyperDHT?) {
        val tracked = synchronized(sessions) {
            val dht = suspendedDht
            suspendedDht = null
            dht
        }
        val target = tracked?.takeIf { it !== exclude }
            ?: T4PeerConnectionService.currentDht()?.takeIf { it !== exclude && it.isSuspended }
            ?: return
        try { target.resume() } catch (error: RuntimeException) {
            Log.w(TAG, "Could not resume the private DHT node.", error)
        }
    }

    /** The foreground service owns one DHT node across Activity and OMP stream lifecycles. */
    private fun dht(): HyperDHT = T4PeerConnectionService.dht()

    private fun decode(value: String?): ByteArray? {
        if (value == null || value.isEmpty() || value.length > MAX_ENCODED_BYTES) return null
        return try { Base64.decode(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING) } catch (_: IllegalArgumentException) { null }
    }

    private companion object {
        const val TAG = "T4PeerConnection"
        const val NATIVE_OPEN_TIMEOUT_MS = 45_000L
        const val LONG_BACKGROUND_RESET_MS = 60_000L
        const val MAX_MESSAGE_BYTES = 4 * 1024 * 1024
        const val MAX_ENCODED_BYTES = (MAX_MESSAGE_BYTES * 4 / 3) + 8
    }
}
