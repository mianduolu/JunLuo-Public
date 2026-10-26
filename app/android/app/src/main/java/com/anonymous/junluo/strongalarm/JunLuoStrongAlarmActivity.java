package com.anonymous.junluo.strongalarm;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

public class JunLuoStrongAlarmActivity extends Activity {
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(true);
      setTurnScreenOn(true);
    } else {
      getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
    }
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD);
    String nativeId = getIntent().getStringExtra("nativeId");
    LinearLayout layout = new LinearLayout(this);
    layout.setOrientation(LinearLayout.VERTICAL);
    layout.setGravity(Gravity.CENTER);
    layout.setPadding(48, 64, 48, 64);
    layout.setBackgroundColor(Color.rgb(255, 245, 246));
    TextView title = new TextView(this);
    title.setText("强闹钟响啦");
    title.setTextSize(32);
    title.setTypeface(Typeface.DEFAULT_BOLD);
    title.setGravity(Gravity.CENTER);
    title.setTextColor(Color.rgb(64, 54, 62));
    TextView hint = new TextView(this);
    hint.setText("点下面的大按钮停止响铃");
    hint.setTextSize(18);
    hint.setGravity(Gravity.CENTER);
    hint.setTextColor(Color.rgb(116, 94, 104));
    Button stop = new Button(this);
    stop.setText("停止强闹钟");
    stop.setTextSize(26);
    stop.setAllCaps(false);
    stop.setMinHeight(160);
    stop.setPadding(24, 36, 24, 36);
    stop.setOnClickListener((view) -> {
      Intent intent = new Intent(this, JunLuoStrongAlarmService.class);
      intent.setAction(JunLuoStrongAlarmService.ACTION_STOP);
      intent.putExtra("nativeId", nativeId);
      startService(intent);
      finish();
    });
    LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    layout.addView(title, titleParams);
    LinearLayout.LayoutParams hintParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    hintParams.setMargins(0, 24, 0, 56);
    layout.addView(hint, hintParams);
    LinearLayout.LayoutParams buttonParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    layout.addView(stop, buttonParams);
    setContentView(layout);
  }
}
