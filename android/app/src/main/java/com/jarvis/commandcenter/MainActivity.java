package com.jarvis.commandcenter;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.jarvis.commandcenter.voice.VoicePlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(VoicePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
