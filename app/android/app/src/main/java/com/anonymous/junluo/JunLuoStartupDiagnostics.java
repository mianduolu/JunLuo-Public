package com.anonymous.junluo;

import android.app.Activity;
import android.app.ActivityManager;
import android.app.Application;
import android.app.ApplicationExitInfo;
import android.content.Context;
import android.os.Build;
import android.os.Bundle;
import android.os.Process;
import android.util.AtomicFile;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** One bounded technical snapshot. Only the normal app process writes it. */
public final class JunLuoStartupDiagnostics {
  static final String PROCESS_SUFFIX = ":junluo_startup_check";
  static final int MAX_BYTES = 16384;
  private static final String FILE_NAME = "junluo-startup-check.json";
  private static AtomicFile output;
  private static JSONObject current;

  private JunLuoStartupDiagnostics() {}

  static boolean isCheckProcessName(String name, String packageName) {
    return (packageName + PROCESS_SUFFIX).equals(name);
  }

  public static String processName() {
    if (Build.VERSION.SDK_INT >= 28) {
      try {
        String name = Application.getProcessName();
        if (name != null && !name.isEmpty()) return name;
      } catch (Exception | LinkageError ignored) { }
    }
    try (FileInputStream input = new FileInputStream("/proc/self/cmdline")) {
      byte[] bytes = new byte[256];
      int length = input.read(bytes);
      int end = 0;
      while (end < length && bytes[end] != 0) end++;
      if (end > 0) return new String(bytes, 0, end, StandardCharsets.UTF_8);
    } catch (Exception ignored) { }
    return null;
  }

  public static boolean isCheckProcess() {
    // Unknown retains the original initialization; isolation cannot then be guaranteed.
    return isCheckProcessName(processName(), BuildConfig.APPLICATION_ID);
  }

  private static File recordFile(Context context) {
    return new File(context.getNoBackupFilesDir(), FILE_NAME);
  }

  public static void install(Application application) {
    // Unknown keeps normal startup but must never create a second record writer.
    if (!BuildConfig.APPLICATION_ID.equals(processName())) return;
    try {
      synchronized (JunLuoStartupDiagnostics.class) {
        if (current != null) return;
        output = new AtomicFile(recordFile(application));
        current = new JSONObject();
        current.put("pid", Process.myPid());
        current.put("startedAt", System.currentTimeMillis());
      }
      stage("default_process_attach");
      Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
      Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
        try {
          synchronized (JunLuoStartupDiagnostics.class) {
            current.put("exception", exceptionFrames(error));
            write();
          }
        } catch (Throwable ignored) {
          // Recording must never prevent the platform's original fatal handling.
        } finally {
          if (previous != null) previous.uncaughtException(thread, error);
          else {
            Process.killProcess(Process.myPid());
            System.exit(10);
          }
        }
      });
      application.registerActivityLifecycleCallbacks(new Application.ActivityLifecycleCallbacks() {
        private boolean created;
        private boolean resumed;
        private boolean main(Activity activity) {
          return "com.anonymous.junluo.MainActivity".equals(activity.getClass().getName());
        }
        @Override public void onActivityCreated(Activity activity, Bundle state) {
          if (!created && main(activity)) { created = true; stage("main_activity_created"); }
        }
        @Override public void onActivityResumed(Activity activity) {
          if (!resumed && main(activity)) { resumed = true; stage("main_activity_resumed"); }
        }
        @Override public void onActivityStarted(Activity activity) {}
        @Override public void onActivityPaused(Activity activity) {}
        @Override public void onActivityStopped(Activity activity) {}
        @Override public void onActivitySaveInstanceState(Activity activity, Bundle state) {}
        @Override public void onActivityDestroyed(Activity activity) {}
      });
    } catch (Exception ignored) {
      // Optional diagnostics must not turn a writable-storage failure into a startup failure.
    }
  }

  public static synchronized void stage(String name) {
    if (current == null) return;
    try {
      current.put("stage", name);
      current.put("updatedAt", System.currentTimeMillis());
      write();
    } catch (Exception ignored) { }
  }

  private static void write() throws Exception {
    byte[] bytes = current.toString().getBytes(StandardCharsets.UTF_8);
    if (bytes.length > MAX_BYTES) return;
    FileOutputStream stream = null;
    try {
      stream = output.startWrite();
      stream.write(bytes);
      output.finishWrite(stream);
    } catch (Exception error) {
      if (stream != null) output.failWrite(stream);
      throw error;
    }
  }

  static String exceptionFrames(Throwable error) {
    StringBuilder result = new StringBuilder();
    Throwable next = error;
    for (int cause = 0; next != null && cause < 3; cause++) {
      if (cause > 0) result.append("Caused by class: ");
      result.append(limit(next.getClass().getName(), 160)).append('\n');
      StackTraceElement[] frames = next.getStackTrace();
      for (int i = 0; i < Math.min(8, frames.length); i++) {
        result.append("  at ").append(limit(frames[i].toString(), 160)).append('\n');
      }
      Throwable causeError = next.getCause();
      if (causeError == next) break;
      next = causeError;
    }
    // No Throwable.toString/getMessage: RN may put conversation text in a JS error message.
    return result.toString();
  }

  private static String limit(String value, int length) {
    return value.length() <= length ? value : value.substring(0, length);
  }

  static JSONObject readRecord(File file) throws Exception {
    // A reader must not call AtomicFile.openRead and race its writer's recovery/rename.
    try (FileInputStream input = new FileInputStream(file)) {
      byte[] bytes = new byte[MAX_BYTES + 1];
      int count = 0;
      int read;
      while (count < bytes.length && (read = input.read(bytes, count, bytes.length - count)) != -1) {
        count += read;
      }
      if (count > MAX_BYTES) throw new IllegalStateException("Oversized diagnostic record");
      JSONObject record = new JSONObject(new String(bytes, 0, count, StandardCharsets.UTF_8));
      if (!(record.opt("pid") instanceof Number) || record.getLong("pid") <= 0
          || record.getLong("pid") > Integer.MAX_VALUE
          || !(record.opt("startedAt") instanceof Number) || record.getLong("startedAt") <= 0
          || !(record.opt("updatedAt") instanceof Number) || record.getLong("updatedAt") <= 0
          || !(record.opt("stage") instanceof String) || record.getString("stage").length() > 80
          || (record.has("exception") && !(record.opt("exception") instanceof String))) {
        throw new IllegalStateException("Invalid diagnostic record");
      }
      return record;
    }
  }

  static boolean matchesRun(int pid, long startedAt, int exitPid, long exitedAt) {
    return pid > 0 && startedAt > 0 && pid == exitPid && exitedAt >= startedAt;
  }

  public static String report(Context context) {
    StringBuilder text = new StringBuilder("君落启动检查 · 2026-10-27\n");
    text.append("包名：").append(context.getPackageName()).append('\n');
    text.append("版本：").append(BuildConfig.VERSION_NAME).append(" / ")
        .append(BuildConfig.VERSION_CODE).append('\n');
    text.append("Android 接口版本：").append(Build.VERSION.SDK_INT).append('\n');
    text.append("系统提供的 ABI：").append(Arrays.toString(Build.SUPPORTED_ABIS)).append('\n');
    String name = processName();
    text.append("检查进程：").append(name == null ? "UNKNOWN" : name).append('\n');
    if (!isCheckProcessName(name, context.getPackageName())) {
      text.append("未确认检查进程隔离；不能判定 RN／Expo 已避开。\n");
    }
    JSONObject record = null;
    File file = recordFile(context);
    if (file.exists()) {
      try {
        record = readRecord(file);
        text.append("\n最近主进程记录（也可能由后台任务启动）：\n")
            .append("PID：").append(record.optInt("pid")).append('\n')
            .append("开始时间戳：").append(record.optLong("startedAt")).append('\n')
            .append("最后阶段：").append(record.optString("stage", "未知")).append('\n')
            .append("阶段时间戳：").append(record.optLong("updatedAt")).append('\n')
            .append("异常类别／Java 调用栈：\n")
            .append(record.optString("exception", "未捕获到；不代表没有发生异常。"))
            .append('\n');
      } catch (Exception error) {
        text.append("\n启动记录暂不可读：").append(error.getClass().getSimpleName()).append('\n');
      }
    } else text.append("\n尚无主进程阶段记录；过早退出也可能没有留下记录。\n");
    text.append("\n系统退出信息：\n");
    appendExit(context, record, text);
    text.append("\n阶段仅表示原生事件，不代表 JS／首页已就绪。\n")
        .append("不收集聊天、密钥或异常正文，不自动上传。\n")
        .append("native signal、兼容环境退出及过早故障可能无法记录。\n");
    return text.toString();
  }

  private static void appendExit(Context context, JSONObject record, StringBuilder text) {
    if (Build.VERSION.SDK_INT < 30) {
      text.append("当前 Android 接口不提供历史退出原因。\n");
      return;
    }
    try {
      ActivityManager manager = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
      for (ApplicationExitInfo info : manager.getHistoricalProcessExitReasons(context.getPackageName(), 0, 12)) {
        if (!context.getPackageName().equals(info.getProcessName())) continue;
        if (record != null && !matchesRun(record.optInt("pid"), record.optLong("startedAt"),
            info.getPid(), info.getTimestamp())) continue;
        text.append(record == null ? "无阶段记录；以下仅为同包最近主进程退出：\n" : "按 PID／时间筛出的退出记录（候选关联）：\n")
            .append("PID：").append(info.getPid()).append('\n')
            .append("退出时间戳：").append(info.getTimestamp()).append('\n')
            .append("reason：").append(info.getReason()).append("（")
            .append(exitReason(info.getReason())).append("）\n")
            .append("status：").append(info.getStatus()).append('\n');
        return;
      }
      text.append("没有匹配的记录，或兼容环境尚未提供；不能据此认定未崩溃。\n");
    } catch (Exception | LinkageError error) {
      text.append("暂不可用：").append(error.getClass().getSimpleName()).append('\n');
    }
  }

  private static String exitReason(int reason) {
    switch (reason) {
      case ApplicationExitInfo.REASON_CRASH: return "Java 崩溃";
      case ApplicationExitInfo.REASON_CRASH_NATIVE: return "原生崩溃";
      case ApplicationExitInfo.REASON_ANR: return "无响应";
      case ApplicationExitInfo.REASON_LOW_MEMORY: return "内存不足";
      case ApplicationExitInfo.REASON_SIGNALED: return "进程信号";
      case ApplicationExitInfo.REASON_EXIT_SELF: return "主动退出";
      case ApplicationExitInfo.REASON_USER_REQUESTED: return "用户或系统请求结束";
      default: return "其他系统原因";
    }
  }
}
