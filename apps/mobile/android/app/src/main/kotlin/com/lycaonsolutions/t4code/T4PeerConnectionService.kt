package com.lycaonsolutions.t4code

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import com.hyperdht.DhtOptions
import com.hyperdht.HyperDHT

class T4PeerConnectionService : Service() {
    override fun onCreate() {
        super.onCreate()
        active = true
        val notifications = getSystemService(NotificationManager::class.java)
        notifications.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                getString(R.string.t4_peer_service_channel),
                NotificationManager.IMPORTANCE_LOW,
            ),
        )
        val launch = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this,
            1,
            Intent(this, T4PeerConnectionService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(getString(R.string.t4_peer_service_title))
            .setContentText(getString(R.string.t4_peer_service_text))
            .setContentIntent(launch)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setOngoing(true)
            .addAction(
                android.R.drawable.ic_menu_close_clear_cancel,
                getString(R.string.t4_peer_service_stop),
                stop,
            )
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        dht()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        return START_STICKY
    }

    override fun onDestroy() {
        active = false
        try { retireDht()?.close() } catch (_: Exception) {}
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val ACTION_STOP = "com.lycaonsolutions.t4code.STOP_PRIVATE_CONNECTION"
        private const val CHANNEL_ID = "t4-private-connections"
        private const val NOTIFICATION_ID = 41_004
        private val dhtLock = Any()

        @Volatile
        private var active = false
        private var activeDht: HyperDHT? = null

        fun start(context: Context) {
            if (active) return
            active = true
            try {
                context.startForegroundService(Intent(context, T4PeerConnectionService::class.java))
            } catch (error: RuntimeException) {
                active = false
                throw error
            }
        }

        fun isActive(): Boolean = active

        fun currentDht(): HyperDHT? = synchronized(dhtLock) { activeDht }

        fun dht(): HyperDHT = synchronized(dhtLock) {
            activeDht ?: HyperDHT(DhtOptions(usePublicBootstrap = true)).also {
                it.start()
                activeDht = it
            }
        }

        fun retireDht(): HyperDHT? = synchronized(dhtLock) {
            val current = activeDht
            activeDht = null
            current
        }
    }
}
