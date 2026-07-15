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
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
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

    @PluginMethod
    fun open(call: PluginCall) {
        val key = decode(call.getString("publicKey"))
        if (key == null || key.size != 32) {
            call.reject("Invalid desktop peer key.")
            return
        }
        synchronized(sessions) {
            if (opening || sessions.isNotEmpty()) {
                call.reject("Only one private mobile connection can be active.")
                return
            }
            opening = true
        }
        scope.launch {
            var dht: HyperDHT? = null
            try {
                dht = HyperDHT(DhtOptions(usePublicBootstrap = true))
                dht.start()
                dht.awaitBootstrapped()
                val stream = dht.connect(key)
                stream.awaitOpen()
                val id = UUID.randomUUID().toString()
                val receiveJob = launch {
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
                    sessions[id] = Session(dht, stream, receiveJob)
                    opening = false
                }
                call.resolve(JSObject().apply { put("sessionId", id) })
            } catch (_: Exception) {
                synchronized(sessions) { opening = false }
                try { dht?.close() } catch (_: Exception) {}
                call.reject("Could not establish the private mobile connection.")
            }
        }
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
        const val MAX_MESSAGE_BYTES = 4 * 1024 * 1024
        const val MAX_ENCODED_BYTES = (MAX_MESSAGE_BYTES * 4 / 3) + 8
    }
}
