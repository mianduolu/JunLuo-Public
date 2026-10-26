const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('@expo/config-plugins');

function insertOnce(source, anchor, addition) {
  if (source.includes(addition.trim())) return source;
  if (!source.includes(anchor)) throw new Error(`Incoming call plugin anchor missing: ${anchor}`);
  return source.replace(anchor, `${anchor}${addition}`);
}

module.exports = function withJunLuoIncomingCall(config) {
  return withDangerousMod(config, ['android', async (mod) => {
    const root = mod.modRequest.projectRoot;
    const androidRoot = path.join(root, 'android', 'app', 'src', 'main');
    const packageRoot = path.join(androidRoot, 'java', 'com', 'anonymous', 'junluo');
    const target = path.join(packageRoot, 'incomingcall');
    fs.mkdirSync(target, { recursive: true });
    const templates = path.join(root, 'plugins', 'incoming-call', 'android');
    for (const name of fs.readdirSync(templates)) {
      fs.copyFileSync(path.join(templates, name), path.join(target, name));
    }
    const raw = path.join(androidRoot, 'res', 'raw');
    fs.mkdirSync(raw, { recursive: true });
    fs.copyFileSync(
      path.join(root, 'assets', '语音通话', '铃声.wav'),
      path.join(raw, 'junluo_incoming_call.wav'),
    );
    const drawable = path.join(androidRoot, 'res', 'drawable-nodpi');
    fs.mkdirSync(drawable, { recursive: true });
    for (const [source, targetName] of [
      ['背景.jpg', 'junluo_incoming_background.jpg'],
      ['头像.png', 'junluo_incoming_avatar.png'],
      ['接听按钮.png', 'junluo_incoming_answer_button.png'],
      ['挂断按钮.png', 'junluo_incoming_hangup_button.png'],
    ]) {
      fs.copyFileSync(path.join(root, 'assets', '语音通话', source), path.join(drawable, targetName));
    }

    const applicationPath = path.join(packageRoot, 'MainApplication.kt');
    let application = fs.readFileSync(applicationPath, 'utf8');
    application = insertOnce(
      application,
      'import com.facebook.react.PackageList',
      '\nimport com.anonymous.junluo.incomingcall.JunLuoIncomingCallPackage',
    );
    application = insertOnce(
      application,
      'PackageList(this).packages.apply {',
      '\n              add(JunLuoIncomingCallPackage())',
    );
    fs.writeFileSync(applicationPath, application);

    const activityPath = path.join(packageRoot, 'MainActivity.kt');
    let activity = fs.readFileSync(activityPath, 'utf8');
    if (!activity.includes('import android.content.Intent')) {
      activity = insertOnce(activity, 'import android.os.Bundle', '\nimport android.content.Intent');
    }
    activity = insertOnce(
      activity,
      'import expo.modules.ReactActivityDelegateWrapper',
      '\nimport com.anonymous.junluo.incomingcall.JunLuoIncomingCallModule',
    );
    activity = insertOnce(
      activity,
      'import com.anonymous.junluo.incomingcall.JunLuoIncomingCallModule',
      '\nimport com.anonymous.junluo.incomingcall.IncomingCallWindowController',
    );
    if (!activity.includes('super.onCreate(null)\n    IncomingCallWindowController.apply(this, intent)')) {
      const createAnchor = 'super.onCreate(null)';
      if (!activity.includes(createAnchor)) throw new Error(`Incoming call plugin anchor missing: ${createAnchor}`);
      activity = activity.replace(
        createAnchor,
        `${createAnchor}\n    IncomingCallWindowController.apply(this, intent)`,
      );
    }
    if (!activity.includes('JunLuoIncomingCallModule.emitIncomingCallIntent(intent)')) {
      const phoneGuardAnchor = 'JunLuoPhoneActivityModule.emitPhoneGuardLaunchIntent(intent)';
      const genericAnchor = 'setIntent(intent)';
      if (activity.includes(phoneGuardAnchor)) {
        activity = activity.replace(phoneGuardAnchor, `${phoneGuardAnchor}\n      JunLuoIncomingCallModule.emitIncomingCallIntent(intent)`);
      } else if (activity.includes(genericAnchor)) {
        activity = insertOnce(activity, genericAnchor, '\n      JunLuoIncomingCallModule.emitIncomingCallIntent(intent)');
      } else {
        const delegateAnchor = '  override fun createReactActivityDelegate(): ReactActivityDelegate {';
        if (!activity.includes(delegateAnchor)) throw new Error(`Incoming call plugin anchor missing: ${delegateAnchor}`);
        activity = activity.replace(
          delegateAnchor,
          `  override fun onNewIntent(intent: Intent) {\n    super.onNewIntent(intent)\n    setIntent(intent)\n    JunLuoIncomingCallModule.emitIncomingCallIntent(intent)\n  }\n\n${delegateAnchor}`,
        );
      }
    }
    if (!activity.includes('setIntent(intent)\n      IncomingCallWindowController.apply(this, intent)')) {
      if (!activity.includes('setIntent(intent)')) throw new Error('Incoming call plugin anchor missing: setIntent(intent)');
      activity = activity.replace(
        'setIntent(intent)',
        'setIntent(intent)\n      IncomingCallWindowController.apply(this, intent)',
      );
    }
    fs.writeFileSync(activityPath, activity);

    const manifestPath = path.join(androidRoot, 'AndroidManifest.xml');
    let manifest = fs.readFileSync(manifestPath, 'utf8');
    manifest = insertOnce(manifest, '<application ', '');
    if (!manifest.includes('.incomingcall.JunLuoIncomingCallService')) {
      manifest = manifest.replace('</application>', [
        '    <service android:enabled="true" android:exported="false" android:foregroundServiceType="mediaPlayback" android:name=".incomingcall.JunLuoIncomingCallService"/>',
        '    <activity android:excludeFromRecents="true" android:exported="false" android:showWhenLocked="true" android:turnScreenOn="true" android:theme="@style/AppTheme" android:name=".incomingcall.JunLuoIncomingCallActivity"/>',
        '    <receiver android:enabled="true" android:exported="false" android:name=".incomingcall.JunLuoIncomingCallReceiver"/>',
        '    <receiver android:enabled="true" android:exported="true" android:name=".incomingcall.JunLuoIncomingCallBootReceiver"><intent-filter><action android:name="android.intent.action.BOOT_COMPLETED"/></intent-filter></receiver>',
        '  </application>',
      ].join('\n'));
    }
    manifest = manifest.replace(
      'android:theme="@style/AppTheme" android:name=".incomingcall.JunLuoIncomingCallActivity"',
      'android:theme="@style/JunLuoIncomingCallTheme" android:name=".incomingcall.JunLuoIncomingCallActivity"',
    );
    fs.writeFileSync(manifestPath, manifest);

    const stylesPath = path.join(androidRoot, 'res', 'values', 'styles.xml');
    let styles = fs.readFileSync(stylesPath, 'utf8');
    if (!styles.includes('name="JunLuoIncomingCallTheme"')) {
      styles = styles.replace('</resources>', [
        '  <style name="JunLuoIncomingCallTheme" parent="AppTheme">',
        '    <item name="android:windowBackground">@drawable/junluo_incoming_background</item>',
        '    <item name="android:windowNoTitle">true</item>',
        '    <item name="android:statusBarColor">@android:color/transparent</item>',
        '    <item name="android:navigationBarColor">#F7F7F7</item>',
        '    <item name="android:windowLightStatusBar">true</item>',
        '    <item name="android:windowLightNavigationBar">true</item>',
        '  </style>',
        '</resources>',
      ].join('\n'));
    }
    fs.writeFileSync(stylesPath, styles);
    return mod;
  }]);
};
