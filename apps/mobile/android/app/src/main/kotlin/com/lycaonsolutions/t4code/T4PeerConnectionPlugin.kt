package com.lycaonsolutions.t4code

import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.hyperdht.DhtOptions
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
        val dht: HyperDHT,
        val stream: Stream,
        val receiveJob: Job,
    )

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val sessions = mutableMapOf<String, Session>()
    private var opening = false
    private var openingAttemptId: String? = null
    private var openingJob: Job? = null
    private var openingDht: HyperDHT? = null

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
            try {
                val activeDht = HyperDHT(DhtOptions(usePublicBootstrap = true))
                dht = activeDht
                synchronized(sessions) { if (openingAttemptId == attemptId) openingDht = activeDht }
                withTimeout(NATIVE_OPEN_TIMEOUT_MS) {
                    activeDht.start()
                    activeDht.awaitBootstrapped()
                    val stream = activeDht.connect(key)
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
                        sessions[id] = Session(activeDht, stream, receiveJob)
                        opening = false
                        openingAttemptId = null
                        openingJob = null
                        openingDht = null
                    }
                    call.resolve(JSObject().apply { put("sessionId", id) })
                }
            } catch (error: Exception) {
                synchronized(sessions) {
                    if (openingAttemptId == attemptId) {
                        opening = false
                        openingAttemptId = null
                        openingJob = null
                        openingDht = null
                    }
                }
                val message = if (error is TimeoutCancellationException) {
                    "Private mobile connection timed out. Generate a fresh key and try again."
                } else {
                    "Could not establish the private mobile connection."
                }
                call.reject(message)
                try { dht?.close() } catch (_: Exception) {}
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
                val current = Pair(openingJob, openingDht)
                opening = false
                openingAttemptId = null
                openingJob = null
                openingDht = null
                current
            }
        }
        pending?.first?.cancel()
        val dht = pending?.second
        if (dht != null) scope.launch { try { dht.close() } catch (_: Exception) {} }
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
        try { session.dht.close() } catch (_: Exception) {}
    }

    private fun decode(value: String?): ByteArray? {
        if (value == null || value.isEmpty() || value.length > MAX_ENCODED_BYTES) return null
        return try { Base64.decode(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING) } catch (_: IllegalArgumentException) { null }
    }

    private companion object {
        const val NATIVE_OPEN_TIMEOUT_MS = 45_000L
        const val MAX_MESSAGE_BYTES = 4 * 1024 * 1024
        const val MAX_ENCODED_BYTES = (MAX_MESSAGE_BYTES * 4 / 3) + 8
    }
}
