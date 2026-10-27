package com.anonymous.junluo;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

/** Plain Android UI in its own process; never initializes the React app. */
public final class JunLuoStartupCheckActivity extends Activity {
  private TextView result;
  private Button refresh;
  private Button copy;
  private String report;
  private boolean loading;
  private boolean foreground;
  private int generation;

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    int padding = Math.round(18 * getResources().getDisplayMetrics().density);
    LinearLayout content = new LinearLayout(this);
    content.setOrientation(LinearLayout.VERTICAL);
    content.setPadding(padding, padding, padding, padding);
    TextView title = new TextView(this);
    title.setText("君落检查");
    title.setTextSize(24);
    content.addView(title);
    TextView description = new TextView(this);
    description.setText("查看本机启动技术信息，不自动上传。检查页能打开，不代表主界面已经正常。");
    content.addView(description);
    refresh = new Button(this);
    refresh.setText("刷新检查信息");
    refresh.setOnClickListener(view -> refresh());
    content.addView(refresh);
    copy = new Button(this);
    copy.setText("复制检查信息");
    copy.setEnabled(false);
    copy.setOnClickListener(view -> {
      try {
        ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        clipboard.setPrimaryClip(ClipData.newPlainText("君落启动检查", report));
        Toast.makeText(this, "检查信息已复制", Toast.LENGTH_SHORT).show();
      } catch (Exception | LinkageError error) {
        Toast.makeText(this, "复制失败，请手动选择检查信息。", Toast.LENGTH_SHORT).show();
      }
    });
    content.addView(copy);
    Button open = new Button(this);
    open.setText("打开君落试用");
    open.setOnClickListener(view -> {
      Intent intent = new Intent();
      // A class literal would load ReactActivity into this diagnostic process.
      intent.setClassName(getPackageName(), "com.anonymous.junluo.MainActivity");
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      try { startActivity(intent); }
      catch (Exception | LinkageError error) {
        Toast.makeText(this, "暂时无法打开，请从君落试用图标重试。", Toast.LENGTH_SHORT).show();
      }
    });
    content.addView(open);
    result = new TextView(this);
    result.setTextIsSelectable(true);
    result.setTextSize(14);
    content.addView(result);
    ScrollView scroll = new ScrollView(this);
    scroll.addView(content);
    scroll.setOnApplyWindowInsetsListener((view, insets) -> {
      if (Build.VERSION.SDK_INT >= 30) {
        android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
        scroll.setPadding(bars.left, bars.top, bars.right, bars.bottom);
      } else {
        scroll.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
            insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
      }
      return insets;
    });
    setContentView(scroll);
    scroll.requestApplyInsets();
  }

  @Override public void onResume() {
    super.onResume();
    foreground = true;
    refresh();
  }

  @Override public void onPause() {
    foreground = false;
    generation++;
    loading = false;
    super.onPause();
  }

  private void refresh() {
    if (!foreground || loading) return;
    loading = true;
    final int requestGeneration = ++generation;
    refresh.setEnabled(false);
    copy.setEnabled(false);
    result.setText("正在读取启动信息……");
    new Thread(() -> {
      String text;
      try { text = JunLuoStartupDiagnostics.report(getApplicationContext()); }
      catch (Exception | LinkageError error) { text = "检查信息暂不可用：" + error.getClass().getSimpleName(); }
      final String completed = text;
      runOnUiThread(() -> {
        if (!foreground || requestGeneration != generation || isDestroyed() || isFinishing()) return;
        report = completed;
        result.setText(report);
        loading = false;
        refresh.setEnabled(true);
        copy.setEnabled(true);
      });
    }, "JunLuoStartupCheckRead").start();
  }
}
