const { withAndroidManifest } = require('@expo/config-plugins');

function ensureUsesFeature(manifest, name, attrs = {}) {
  manifest.manifest['uses-feature'] = manifest.manifest['uses-feature'] || [];
  const features = manifest.manifest['uses-feature'];
  const existing = features.find((item) => item.$?.['android:name'] === name);
  if (existing) {
    existing.$ = { ...existing.$, ...attrs, 'android:name': name };
    return;
  }
  features.push({ $: { ...attrs, 'android:name': name } });
}

function ensurePermission(manifest, name, attrs = {}) {
  manifest.manifest['uses-permission'] = manifest.manifest['uses-permission'] || [];
  const permissions = manifest.manifest['uses-permission'];
  const existing = permissions.find((item) => item.$?.['android:name'] === name);
  if (existing) {
    existing.$ = { ...existing.$, ...attrs, 'android:name': name };
    return;
  }
  permissions.push({ $: { ...attrs, 'android:name': name } });
}

module.exports = function withJunLuoBleAndroid(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults;

    ensureUsesFeature(manifest, 'android.hardware.bluetooth_le', {
      'android:required': 'false',
    });

    ensurePermission(manifest, 'android.permission.BLUETOOTH_SCAN', {
      'android:usesPermissionFlags': 'neverForLocation',
      'tools:targetApi': '31',
    });
    ensurePermission(manifest, 'android.permission.BLUETOOTH_CONNECT');
    ensurePermission(manifest, 'android.permission.BLUETOOTH', {
      'android:maxSdkVersion': '30',
    });
    ensurePermission(manifest, 'android.permission.BLUETOOTH_ADMIN', {
      'android:maxSdkVersion': '30',
    });

    return config;
  });
};
