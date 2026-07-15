package com.lycaonsolutions.t4code;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(T4SecureStoragePlugin.class);
        registerPlugin(T4PeerConnectionPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
