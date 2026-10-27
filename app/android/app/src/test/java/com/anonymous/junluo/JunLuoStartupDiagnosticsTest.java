package com.anonymous.junluo;

import org.junit.Test;
import org.json.JSONObject;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import static org.junit.Assert.*;

public class JunLuoStartupDiagnosticsTest {
  @Test public void onlyExactCheckProcessSkipsNormalInitialization() {
    String app = "com.anonymous.junluo.trial";
    assertTrue(JunLuoStartupDiagnostics.isCheckProcessName(app + ":junluo_startup_check", app));
    assertFalse(JunLuoStartupDiagnostics.isCheckProcessName(app, app));
    assertFalse(JunLuoStartupDiagnostics.isCheckProcessName(null, app));
    assertFalse(JunLuoStartupDiagnostics.isCheckProcessName("other:junluo_startup_check", app));
    assertFalse(JunLuoStartupDiagnostics.isCheckProcessName("com.anonymous.junluo:junluo_startup_check", app));
  }

  @Test public void exceptionMessagesAndCauseMessagesAreNeverCollected() {
    RuntimeException error = new RuntimeException("SECRET_CHAT", new IllegalStateException("SECRET_KEY"));
    String text = JunLuoStartupDiagnostics.exceptionFrames(error);
    assertTrue(text.contains("java.lang.RuntimeException"));
    assertTrue(text.contains("java.lang.IllegalStateException"));
    assertTrue(text.contains("JunLuoStartupDiagnosticsTest"));
    assertFalse(text.contains("SECRET_CHAT"));
    assertFalse(text.contains("SECRET_KEY"));
  }

  @Test public void pathologicalFramesAndCauseCyclesRemainBounded() {
    RuntimeException error = new RuntimeException();
    RuntimeException cause = new RuntimeException();
    error.initCause(cause);
    cause.initCause(error);
    StackTraceElement[] frames = new StackTraceElement[100];
    String huge = new String(new char[10000]).replace('\0', 'x');
    java.util.Arrays.fill(frames, new StackTraceElement(huge, huge, huge, 99));
    error.setStackTrace(frames);
    cause.setStackTrace(frames);
    assertTrue(JunLuoStartupDiagnostics.exceptionFrames(error).length() < 5000);
  }

  @Test public void staleOrReusedPidCannotClaimAnOlderExit() {
    assertTrue(JunLuoStartupDiagnostics.matchesRun(123, 1000L, 123, 1001L));
    assertFalse(JunLuoStartupDiagnostics.matchesRun(123, 1000L, 456, 1001L));
    assertFalse(JunLuoStartupDiagnostics.matchesRun(123, 1000L, 123, 999L));
    assertFalse(JunLuoStartupDiagnostics.matchesRun(0, 0L, 0, 1001L));
  }

  @Test public void crossProcessRefreshReadsCurrentFileInsteadOfCachedPreferences() throws Exception {
    File file = File.createTempFile("junluo-startup", ".json");
    try {
      Files.write(file.toPath(), record("rn_load_begin").toString().getBytes(StandardCharsets.UTF_8));
      assertEquals("rn_load_begin", JunLuoStartupDiagnostics.readRecord(file).getString("stage"));
      Files.write(file.toPath(), record("expo_lifecycle_end").toString().getBytes(StandardCharsets.UTF_8));
      assertEquals("expo_lifecycle_end", JunLuoStartupDiagnostics.readRecord(file).getString("stage"));
    } finally { Files.deleteIfExists(file.toPath()); }
  }

  @Test public void oversizedRecordsAreRejectedBeforeParsing() throws Exception {
    File file = File.createTempFile("junluo-startup", ".json");
    try {
      Files.write(file.toPath(), new byte[JunLuoStartupDiagnostics.MAX_BYTES + 1]);
      try { JunLuoStartupDiagnostics.readRecord(file); fail("must reject oversized input"); }
      catch (IllegalStateException expected) { }
    } finally { Files.deleteIfExists(file.toPath()); }
  }

  @Test public void incompleteOrWronglyTypedRecordsAreNotPresentedAsNormal() throws Exception {
    File file = File.createTempFile("junluo-startup", ".json");
    try {
      JSONObject[] invalid = {new JSONObject(), record("x").put("pid", "123"),
          record("x").put("stage", new JSONObject()), record("x").put("startedAt", 0),
          record("x").put("exception", new JSONObject())};
      for (JSONObject value : invalid) {
        Files.write(file.toPath(), value.toString().getBytes(StandardCharsets.UTF_8));
        try { JunLuoStartupDiagnostics.readRecord(file); fail("must reject invalid shape"); }
        catch (IllegalStateException expected) { }
      }
    } finally { Files.deleteIfExists(file.toPath()); }
  }

  private static JSONObject record(String stage) throws Exception {
    return new JSONObject().put("pid", 123).put("startedAt", 1000)
        .put("updatedAt", 1001).put("stage", stage);
  }

  @Test public void rnJsFatalRetainsPositionsButNoErrorTextOrFunctionNames() {
    com.facebook.react.common.JavascriptException error = new com.facebook.react.common.JavascriptException(
        "SECRET_CHAT TypeError, stack:\nSECRET_FUNCTION@1:123456\n");
    String text = JunLuoStartupDiagnostics.exceptionFrames(error);
    assertTrue(text.contains("JS 1:123456"));
    assertFalse(text.contains("SECRET_CHAT"));
    assertFalse(text.contains("SECRET_FUNCTION"));
    assertFalse(text.contains("TypeError"));
  }

  @Test public void numericRamAndSegmentCoordinatesKeepZeroBasedColumns() {
    assertEquals("  JS 1:123456\n  JS seg-1_2.js:1:42\n  JS 17.js:10:0\n",
        JunLuoStartupDiagnostics.jsPositions("secret, stack:\na@1:123456\nb@seg-1_2.js:1:42\nc@17.js:10:0\n"));
  }

  @Test public void lastRnBoundaryExcludesBodyImitatingFrames() {
    assertEquals("  JS 1:42\n", JunLuoStartupDiagnostics.jsPositions(
        "secret fake@1:999\n, stack:\na@1:42\n"));
    assertEquals("", JunLuoStartupDiagnostics.jsPositions("secret, stack:\nfake@1:999\n, stack:\n"));
  }

  @Test public void invalidPrivateOrMissingCoordinatesAreNotRetained() {
    assertEquals("", JunLuoStartupDiagnostics.jsPositions("secret, stack:\n"
        + "a@https://private.example/key:1:42\nb@-1\nc@1\nd@1:2147483648\n"
        + "e@0:123\nf@2147483648:1\ng@1:2SECRET_KEY\n"));
    assertEquals("", JunLuoStartupDiagnostics.jsPositions("secret a@1:2\n"));
    assertEquals("", JunLuoStartupDiagnostics.jsPositions(null));
    assertEquals("", JunLuoStartupDiagnostics.jsPositions("secret, stack:\na@1:2"));
  }

  @Test public void boundedJsExtractionRejectsOversizedSuffixAndLimitsFrames() {
    StringBuilder many = new StringBuilder("secret, stack:\n");
    for (int i = 0; i < 100; i++) many.append("a@1:42\n");
    String text = JunLuoStartupDiagnostics.jsPositions(many.toString());
    assertEquals(8, text.split("JS ", -1).length - 1);
    String huge = new String(new char[33000]).replace('\0', 'x');
    assertEquals("", JunLuoStartupDiagnostics.jsPositions("secret, stack:\n" + huge + "@1:2\n"));
    assertEquals("  JS 1:2\n", JunLuoStartupDiagnostics.jsPositions(huge + ", stack:\na@1:2\n"));
  }

  @Test public void genericExceptionCannotOptIntoJsExtractionByMessage() {
    String text = JunLuoStartupDiagnostics.exceptionFrames(new RuntimeException("secret, stack:\na@1:42\n"));
    assertFalse(text.contains("JS 1:42"));
    assertFalse(text.contains("secret"));
  }
}
