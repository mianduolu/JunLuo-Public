package com.anonymous.junluo.incomingcall;

import com.facebook.react.ReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.uimanager.ViewManager;
import java.util.Collections;
import java.util.List;

public class JunLuoIncomingCallPackage implements ReactPackage {
  @Override public List<NativeModule> createNativeModules(ReactApplicationContext context) {
    return Collections.singletonList(new JunLuoIncomingCallModule(context));
  }
  @Override public List<ViewManager> createViewManagers(ReactApplicationContext context) {
    return Collections.emptyList();
  }
}
