package com.anonymous.junluo;

import com.facebook.react.bridge.ReactMethod;
import org.junit.Test;
import java.io.IOException;
import java.io.InputStream;
import java.lang.reflect.Method;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import static org.junit.Assert.*;

public class BodySignalCompanionApiCompatibilityTest {
  private static final String MODULE = "com.anonymous.junluo.BodySignalCompanionModule";
  private static final String API_33_TYPE = "android.companion.AssociationInfo";

  @Test public void realCompiledBridgeMetadataDoesNotRequireApi33Type() throws Exception {
    ClassLoader parent = getClass().getClassLoader();
    ClassLoader api31LikeLoader = new ClassLoader(parent) {
      @Override protected Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException {
        if (API_33_TYPE.equals(name)) throw new ClassNotFoundException("API 33 type intentionally absent");
        if (!MODULE.equals(name)) return super.loadClass(name, resolve);
        synchronized (this) {
          Class<?> result = findLoadedClass(name);
          if (result == null) {
            try (InputStream input = parent.getResourceAsStream(name.replace('.', '/') + ".class")) {
              if (input == null) throw new ClassNotFoundException(name);
              byte[] bytes = input.readAllBytes();
              result = defineClass(name, bytes, 0, bytes.length);
            } catch (IOException error) { throw new ClassNotFoundException(name, error); }
          }
          if (resolve) resolveClass(result);
          return result;
        }
      }
    };
    // The bridge enumerates every declared method before filtering @ReactMethod.
    // Load the production class without running its constructor or any Android API.
    Class<?> module = Class.forName(MODULE, false, api31LikeLoader);
    assertSame(api31LikeLoader, module.getClassLoader());
    Set<String> exported = new HashSet<>();
    for (Method method : module.getDeclaredMethods()) {
      assertNotEquals(API_33_TYPE, method.getReturnType().getName());
      for (Class<?> parameter : method.getParameterTypes()) assertNotEquals(API_33_TYPE, parameter.getName());
      if (method.getAnnotation(ReactMethod.class) != null) exported.add(method.getName());
    }
    assertEquals(new HashSet<>(Arrays.asList("getCompanionSupport", "beginPrimaryDeviceAssociation",
        "pausePrimaryDeviceObservation", "resumePrimaryDeviceObservation", "repairPrimaryDeviceAssociation",
        "revokePrimaryDeviceAssociation", "drainCompanionPresenceEvents", "addListener", "removeListeners")), exported);
  }
}
