package com.lycaonsolutions.t4code;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String APP_RESUME_EVENT = "t4:native-resume";
    private boolean hasEnteredBackground = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(T4SecureStoragePlugin.class);
        registerPlugin(T4PeerConnectionPlugin.class);
        registerPlugin(T4UpdatePlugin.class);
        registerPlugin(T4QrScannerPlugin.class);
        registerPlugin(T4SpeechPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onPause() {
        hasEnteredBackground = true;
        super.onPause();
    }

    @Override
    public void onResume() {
        super.onResume();
        if (hasEnteredBackground && getBridge() != null) {
            hasEnteredBackground = false;
            getBridge().triggerWindowJSEvent(APP_RESUME_EVENT);
        }
    }
}
