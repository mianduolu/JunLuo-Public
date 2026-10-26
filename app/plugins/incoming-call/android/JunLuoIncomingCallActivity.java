package com.anonymous.junluo.incomingcall;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.Space;
import android.widget.TextView;
import com.anonymous.junluo.R;
import java.lang.ref.WeakReference;

public class JunLuoIncomingCallActivity extends Activity {
  private static WeakReference<JunLuoIncomingCallActivity> activeActivity = new WeakReference<>(null);
  private String invitationId;

  @Override protected void onCreate(Bundle state) {
    super.onCreate(state);
    overridePendingTransition(0, 0);
    activeActivity = new WeakReference<>(this);
    configureWindow();
    invitationId = getIntent().getStringExtra("invitationId");
    if (invitationId == null) {
      finish();
      return;
    }
    setContentView(createIncomingCallView());
  }

  private void configureWindow() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(true);
      setTurnScreenOn(true);
    } else {
      getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
    }
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
      getWindow().setStatusBarColor(Color.TRANSPARENT);
      getWindow().setNavigationBarColor(Color.rgb(247, 247, 247));
    }
    int systemUi = View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) systemUi |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) systemUi |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
    getWindow().getDecorView().setSystemUiVisibility(systemUi);
  }

  private View createIncomingCallView() {
    FrameLayout root = new FrameLayout(this);
    ImageView background = new ImageView(this);
    background.setImageResource(R.drawable.junluo_incoming_background);
    background.setScaleType(ImageView.ScaleType.CENTER_CROP);
    root.addView(background, matchParent());

    View scrim = new View(this);
    scrim.setBackgroundColor(Color.argb(117, 9, 14, 23));
    root.addView(scrim, matchParent());

    LinearLayout content = new LinearLayout(this);
    content.setOrientation(LinearLayout.VERTICAL);
    content.setGravity(Gravity.CENTER_HORIZONTAL);
    content.setPadding(dp(28), dp(46), dp(28), dp(34));
    root.addView(content, matchParent());

    TextView status = text("正在来电", 13, Color.argb(214, 255, 255, 255), true);
    content.addView(status, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(34)));

    LinearLayout identity = new LinearLayout(this);
    identity.setOrientation(LinearLayout.VERTICAL);
    identity.setGravity(Gravity.CENTER);
    content.addView(identity, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));

    ImageView avatar = new ImageView(this);
    avatar.setImageResource(R.drawable.junluo_incoming_avatar);
    avatar.setScaleType(ImageView.ScaleType.CENTER_CROP);
    LinearLayout.LayoutParams avatarParams = new LinearLayout.LayoutParams(dp(144), dp(144));
    avatarParams.bottomMargin = dp(22);
    identity.addView(avatar, avatarParams);

    TextView name = text("白云小姐", 34, Color.WHITE, true);
    identity.addView(name, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
    TextView hint = text("来电", 17, Color.argb(209, 255, 255, 255), true);
    LinearLayout.LayoutParams hintParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    hintParams.topMargin = dp(9);
    identity.addView(hint, hintParams);

    LinearLayout actions = new LinearLayout(this);
    actions.setGravity(Gravity.CENTER);
    View decline = callButton(R.drawable.junluo_incoming_hangup_button, "挂断", "挂断白云小姐来电");
    View answer = callButton(R.drawable.junluo_incoming_answer_button, "接听", "接听白云小姐来电");
    actions.addView(decline, new LinearLayout.LayoutParams(dp(104), dp(108)));
    actions.addView(new Space(this), new LinearLayout.LayoutParams(dp(42), 1));
    actions.addView(answer, new LinearLayout.LayoutParams(dp(104), dp(108)));
    content.addView(actions, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

    decline.setOnClickListener(view -> settle("declined"));
    answer.setOnClickListener(view -> settle("answered"));
    return root;
  }

  private View callButton(int imageResource, String caption, String accessibilityLabel) {
    LinearLayout button = new LinearLayout(this);
    button.setOrientation(LinearLayout.VERTICAL);
    button.setGravity(Gravity.CENTER_HORIZONTAL);
    button.setContentDescription(accessibilityLabel);
    button.setClickable(true);
    button.setFocusable(true);
    ImageView image = new ImageView(this);
    image.setImageResource(imageResource);
    image.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
    button.addView(image, new LinearLayout.LayoutParams(dp(82), dp(82)));
    TextView label = text(caption, 14, Color.argb(219, 255, 255, 255), true);
    LinearLayout.LayoutParams labelParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    labelParams.topMargin = dp(4);
    button.addView(label, labelParams);
    return button;
  }

  private TextView text(String value, int sizeSp, int color, boolean bold) {
    TextView text = new TextView(this);
    text.setText(value);
    text.setTextColor(color);
    text.setTextSize(sizeSp);
    text.setGravity(Gravity.CENTER);
    text.setTypeface(Typeface.DEFAULT, bold ? Typeface.BOLD : Typeface.NORMAL);
    return text;
  }

  private FrameLayout.LayoutParams matchParent() {
    return new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
  }

  private int dp(int value) {
    return Math.round(value * getResources().getDisplayMetrics().density);
  }

  private void settle(String status) {
    JunLuoIncomingCallReceiver.settle(this, invitationId, status);
    finishWithoutAnimation();
  }

  @Override public void onBackPressed() {
    settle("declined");
  }

  static void dismissIfShowing(String settledInvitationId) {
    JunLuoIncomingCallActivity activity = activeActivity.get();
    if (activity == null || settledInvitationId == null || !settledInvitationId.equals(activity.invitationId)) return;
    activity.runOnUiThread(activity::finishWithoutAnimation);
  }

  private void finishWithoutAnimation() {
    finish();
    overridePendingTransition(0, 0);
  }

  @Override protected void onDestroy() {
    if (activeActivity.get() == this) activeActivity.clear();
    super.onDestroy();
  }
}
