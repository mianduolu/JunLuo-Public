const fs = require('fs');
const path = require('path');
const {
  withAndroidManifest,
  withAppBuildGradle,
  withDangerousMod,
  withMainApplication,
} = require('@expo/config-plugins');

const MODULE_PACKAGE_SEGMENT = 'camera';
const SERVICE_CLASS_NAME = 'JunLuoCameraSessionService';
const SERVICE_MANIFEST_NAME = `.${MODULE_PACKAGE_SEGMENT}.${SERVICE_CLASS_NAME}`;
const AUTOMATIC_TASK_SERVICE_MANIFEST_NAME = `.${MODULE_PACKAGE_SEGMENT}.JunLuoCameraObservationTaskService`;
const AUTOMATIC_ALARM_RECEIVER_MANIFEST_NAME = `.${MODULE_PACKAGE_SEGMENT}.JunLuoCameraAutomaticObservationAlarmReceiver`;
const MANUAL_SAVE_PICKER_MANIFEST_NAME = `.${MODULE_PACKAGE_SEGMENT}.JunLuoCameraManualSavePickerActivity`;
const CAMERA_DEPENDENCIES_BEGIN = '    // @generated begin JunLuo CameraX dependencies';
const CAMERA_DEPENDENCIES_END = '    // @generated end JunLuo CameraX dependencies';
const CAMERA_DEPENDENCIES = [
  '    implementation("androidx.camera:camera-core:1.6.1")',
  '    implementation("androidx.camera:camera-camera2:1.6.1")',
  '    implementation("androidx.camera:camera-lifecycle:1.6.1")',
  '    implementation("androidx.camera:camera-view:1.6.1")',
  '    implementation("androidx.exifinterface:exifinterface:1.4.2")',
  '    testImplementation("junit:junit:4.13.2")',
  '    testImplementation("org.json:json:20180813")',
];
const CAMERA_PACKAGE_IMPORT = 'import {packageName}.camera.JunLuoCameraReactPackage';
const CAMERA_PACKAGE_REGISTRATION = '              add(JunLuoCameraReactPackage())';
const CAMERA_BACKUP_EXCLUDED_SHARED_PREFS = [
  'junluo_camera_perception_session_v1.xml',
  'junluo_camera_manual_save_destination_v1.xml',
  'junluo_camera_sensitive_backup_policy_v1.xml',
];
const CAMERA_TEMPLATE_MAPPINGS = [
  {
    template: 'main/JunLuoCameraContracts.kt',
    destination: 'app/src/main/java/{packagePath}/camera/JunLuoCameraContracts.kt',
  },
  {
    template: 'main/JunLuoCameraCore.kt',
    destination: 'app/src/main/java/{packagePath}/camera/JunLuoCameraCore.kt',
  },
  {
    template: 'main/JunLuoCameraServiceContracts.kt',
    destination: 'app/src/main/java/{packagePath}/camera/JunLuoCameraServiceContracts.kt',
  },
  {
    template: 'main/JunLuoCameraRuntimeConditionsContracts.kt',
    destination: 'app/src/main/java/{packagePath}/camera/JunLuoCameraRuntimeConditionsContracts.kt',
  },
  {
    template: 'main/JunLuoCameraRuntimeConditions.kt',
    destination: 'app/src/main/java/{packagePath}/camera/JunLuoCameraRuntimeConditions.kt',
  },
  {
    template: 'main/JunLuoCameraAutomaticObservationContracts.kt',
    destination: 'app/src/main/java/{packagePath}/camera/JunLuoCameraAutomaticObservationContracts.kt',
  },
  {
    template: 'main/JunLuoCameraAutomaticObservationScheduler.kt',
    destination: 'app/src/main/java/{packagePath}/camera/JunLuoCameraAutomaticObservationScheduler.kt',
  },
  {
    template: 'main/JunLuoCameraAutomaticObservationAlarmReceiver.kt',
    destination: 'app/src/main/java/{packagePath}/camera/JunLuoCameraAutomaticObservationAlarmReceiver.kt',
  },
  {
    template: 'main/JunLuoCameraObservationTaskService.kt',
    destination: 'app/src/main/java/{packagePath}/camera/JunLuoCameraObservationTaskService.kt',
  },
  {
    template: 'main/JunLuoCameraServiceStore.kt',
    destination: 'app/src/main/java/{packagePath}/camera/JunLuoCameraServiceStore.kt',
  },
  {
    template: 'main/JunLuoCameraServiceEventBus.kt',
    destination: 'app/src/main/java/{packagePath}/camera/JunLuoCameraServiceEventBus.kt',
  },
  {
    template: 'main/JunLuoCameraResourceArbiter.kt',
    destination: 'app/src/main/java/{packagePath}/camera/JunLuoCameraResourceArbiter.kt',
  },
  {
    template: 'main/JunLuoCameraBridgeFrameRegistry.kt',
    destination: 'app/src/main/java/{packagePath}/camera/JunLuoCameraBridgeFrameRegistry.kt',
  },
  {
    template: 'main/JunLuoCameraTemporaryFileManager.kt',
    destination: 'app/src/main/java/{packagePath}/camera/JunLuoCameraTemporaryFileManager.kt',
  },
  {
    template: 'main/JunLuoCameraSensitiveBackupPolicyStore.kt',
    destination: 'app/src/main/java/{packagePath}/camera/JunLuoCameraSensitiveBackupPolicyStore.kt',
  },
  {
    template: 'main/JunLuoCameraManualSaveStore.kt',
    destination: 'app/src/main/java/{packagePath}/camera/JunLuoCameraManualSaveStore.kt',
  },
  {
    template: 'main/JunLuoCameraManualSavePickerActivity.kt',
    destination: 'app/src/main/java/{packagePath}/camera/JunLuoCameraManualSavePickerActivity.kt',
  },
  {
    template: 'main/JunLuoCameraPerceptionModule.kt',
    destination: 'app/src/main/java/{packagePath}/camera/JunLuoCameraPerceptionModule.kt',
  },
  {
    template: 'main/JunLuoCameraPreviewCoordinator.kt',
    destination: 'app/src/main/java/{packagePath}/camera/JunLuoCameraPreviewCoordinator.kt',
  },
  {
    template: 'main/JunLuoCameraPreviewView.kt',
    destination: 'app/src/main/java/{packagePath}/camera/JunLuoCameraPreviewView.kt',
  },
  {
    template: 'main/JunLuoCameraPreviewViewManager.kt',
    destination: 'app/src/main/java/{packagePath}/camera/JunLuoCameraPreviewViewManager.kt',
  },
  {
    template: 'main/JunLuoCameraReactPackage.kt',
    destination: 'app/src/main/java/{packagePath}/camera/JunLuoCameraReactPackage.kt',
  },
  {
    template: 'main/JunLuoCameraSessionServiceController.kt',
    destination: 'app/src/main/java/{packagePath}/camera/JunLuoCameraSessionServiceController.kt',
  },
  {
    template: 'main/JunLuoCameraSessionService.kt',
    destination: 'app/src/main/java/{packagePath}/camera/JunLuoCameraSessionService.kt',
  },
  {
    template: 'main/junluo_camera_strings.xml',
    destination: 'app/src/main/res/values/junluo_camera_strings.xml',
  },
  {
    template: 'debug/JunLuoCameraDebugActivity.kt',
    destination: 'app/src/debug/java/{packagePath}/camera/JunLuoCameraDebugActivity.kt',
  },
  {
    template: 'debug/JunLuoCameraServiceDebugActivity.kt',
    destination: 'app/src/debug/java/{packagePath}/camera/JunLuoCameraServiceDebugActivity.kt',
  },
  {
    template: 'debug/AndroidManifest.xml',
    destination: 'app/src/debug/AndroidManifest.xml',
  },
  {
    template: 'test/JunLuoCameraCoreContractTest.kt',
    destination: 'app/src/test/java/{packagePath}/camera/JunLuoCameraCoreContractTest.kt',
  },
  {
    template: 'test/JunLuoCameraServiceContractTest.kt',
    destination: 'app/src/test/java/{packagePath}/camera/JunLuoCameraServiceContractTest.kt',
  },
  {
    template: 'test/JunLuoCameraRuntimeConditionsContractTest.kt',
    destination: 'app/src/test/java/{packagePath}/camera/JunLuoCameraRuntimeConditionsContractTest.kt',
  },
  {
    template: 'test/JunLuoCameraAutomaticObservationContractTest.kt',
    destination: 'app/src/test/java/{packagePath}/camera/JunLuoCameraAutomaticObservationContractTest.kt',
  },
  {
    template: 'test/JunLuoCameraBridgeContractTest.kt',
    destination: 'app/src/test/java/{packagePath}/camera/JunLuoCameraBridgeContractTest.kt',
  },
  {
    template: 'test/JunLuoCameraPreviewContractTest.kt',
    destination: 'app/src/test/java/{packagePath}/camera/JunLuoCameraPreviewContractTest.kt',
  },
  {
    template: 'test/JunLuoCameraPrivacyContractTest.kt',
    destination: 'app/src/test/java/{packagePath}/camera/JunLuoCameraPrivacyContractTest.kt',
  },
];

function applyCameraMainApplication(contents, packageName) {
  const importLine = CAMERA_PACKAGE_IMPORT.replace('{packageName}', packageName);
  const importPattern = /^import .*\.camera\.JunLuoCameraReactPackage\r?$/gmu;
  const withoutImports = contents.replace(importPattern, '').replace(/\n{3,}/gu, '\n\n');
  const packagePattern = new RegExp(`^(package\\s+${packageName.replaceAll('.', '\\.')})\\r?\\n`, 'mu');
  if (!packagePattern.test(withoutImports)) {
    throw new Error('JunLuo camera plugin could not find the MainApplication package declaration.');
  }
  let next = withoutImports.replace(packagePattern, `$1\n\n${importLine}\n`);
  const registrationPattern = /^[\t ]*add\(JunLuoCameraReactPackage\(\)\)[\t ]*\r?\n/gmu;
  next = next.replace(registrationPattern, '');
  const packagesAnchor = /(PackageList\(this\)\.packages\.apply\s*\{\r?\n)/u;
  if (!packagesAnchor.test(next)) {
    throw new Error('JunLuo camera plugin could not find PackageList(this).packages.apply.');
  }
  return next.replace(packagesAnchor, `$1${CAMERA_PACKAGE_REGISTRATION}\n`);
}

function ensurePermission(manifest, name) {
  manifest.manifest['uses-permission'] = manifest.manifest['uses-permission'] || [];
  const permissions = manifest.manifest['uses-permission'];
  const matches = permissions.filter((item) => item.$?.['android:name'] === name);
  const permission = matches[0] || { $: { 'android:name': name } };
  permission.$ = { ...permission.$, 'android:name': name };
  delete permission.$['tools:node'];
  manifest.manifest['uses-permission'] = [
    ...permissions.filter((item) => item.$?.['android:name'] !== name),
    permission,
  ];
}

function ensureUsesFeature(manifest, name, attrs = {}) {
  manifest.manifest['uses-feature'] = manifest.manifest['uses-feature'] || [];
  const features = manifest.manifest['uses-feature'];
  const matches = features.filter((item) => item.$?.['android:name'] === name);
  const feature = matches[0] || { $: { 'android:name': name } };
  feature.$ = { ...feature.$, ...attrs, 'android:name': name };
  manifest.manifest['uses-feature'] = [
    ...features.filter((item) => item.$?.['android:name'] !== name),
    feature,
  ];
}

function ensureApplicationChild(application, tag, androidName, attrs = {}) {
  application[tag] = application[tag] || [];
  const children = application[tag];
  const matches = children.filter((item) => item.$?.['android:name'] === androidName);
  const child = matches[0] || { $: { 'android:name': androidName } };
  child.$ = { ...child.$, ...attrs, 'android:name': androidName };
  application[tag] = [
    ...children.filter((item) => item.$?.['android:name'] !== androidName),
    child,
  ];
}

function applyCameraManifest(manifest) {
  ensurePermission(manifest, 'android.permission.CAMERA');
  ensurePermission(manifest, 'android.permission.FOREGROUND_SERVICE');
  ensurePermission(manifest, 'android.permission.FOREGROUND_SERVICE_CAMERA');
  ensureUsesFeature(manifest, 'android.hardware.camera.any', {
    'android:required': 'false',
  });

  const application = manifest.manifest.application?.[0];
  if (application) {
    ensureApplicationChild(application, 'service', SERVICE_MANIFEST_NAME, {
      'android:enabled': 'true',
      'android:exported': 'false',
      'android:foregroundServiceType': 'camera',
    });
    ensureApplicationChild(application, 'service', AUTOMATIC_TASK_SERVICE_MANIFEST_NAME, {
      'android:enabled': 'true',
      'android:exported': 'false',
    });
    ensureApplicationChild(application, 'receiver', AUTOMATIC_ALARM_RECEIVER_MANIFEST_NAME, {
      'android:enabled': 'true',
      'android:exported': 'false',
    });
    ensureApplicationChild(application, 'activity', MANUAL_SAVE_PICKER_MANIFEST_NAME, {
      'android:excludeFromRecents': 'true',
      'android:exported': 'false',
      'android:theme': '@style/AppTheme',
    });
  }
  return manifest;
}

function legacyCameraServiceJava(packageName) {
  return `package ${packageName}.${MODULE_PACKAGE_SEGMENT};

import android.app.Service;
import android.content.Intent;
import android.os.IBinder;

/**
 * Disabled Chapter 3 placeholder. Chapter 5 replaces this with the real camera
 * foreground service after the user-visible session flow exists.
 */
public final class ${SERVICE_CLASS_NAME} extends Service {
  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    stopSelf(startId);
    return START_NOT_STICKY;
  }
}
`;
}

function applyCameraGradleDependencies(contents) {
  const blockPattern = new RegExp(
    `^[\\t ]*${CAMERA_DEPENDENCIES_BEGIN.trim()}\\r?\\n[\\s\\S]*?^[\\t ]*${CAMERA_DEPENDENCIES_END.trim()}[\\t ]*\\r?\\n(?:[\\t ]*\\r?\\n)?`,
    'gm',
  );
  const withoutExistingBlock = contents.replace(blockPattern, '');
  const dependenciesMatch = /(dependencies\s*\{)[\t ]*\r?\n/u;
  if (!dependenciesMatch.test(withoutExistingBlock)) {
    throw new Error('JunLuo camera plugin could not find the Android dependencies block.');
  }
  const block = [
    CAMERA_DEPENDENCIES_BEGIN,
    ...CAMERA_DEPENDENCIES,
    CAMERA_DEPENDENCIES_END,
    '',
  ].join('\n');
  return withoutExistingBlock.replace(dependenciesMatch, (_match, opening) => `${opening}\n${block}`);
}

function writeFileIfChanged(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === contents) return;
  fs.writeFileSync(filePath, contents, 'utf8');
}

function applyCameraBackupExcludes(contents, dataExtractionRules) {
  let next = contents;
  for (const preference of CAMERA_BACKUP_EXCLUDED_SHARED_PREFS) {
    const escaped = preference.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    next = next.replace(
      new RegExp(`^[\\t ]*<exclude domain="sharedpref" path="${escaped}" \\/>\\r?\\n`, 'gmu'),
      '',
    );
  }
  const block = (indent) => CAMERA_BACKUP_EXCLUDED_SHARED_PREFS
    .map((preference) => `${indent}<exclude domain="sharedpref" path="${preference}" />`)
    .join('\n') + '\n';
  if (!dataExtractionRules) {
    if (!next.includes('</full-backup-content>')) {
      throw new Error('JunLuo camera plugin could not find full-backup-content closing tag.');
    }
    return next.replace('</full-backup-content>', `${block('  ')}</full-backup-content>`);
  }
  for (const closingTag of ['</cloud-backup>', '</device-transfer>']) {
    if (!next.includes(closingTag)) {
      throw new Error(`JunLuo camera plugin could not find ${closingTag}.`);
    }
    next = next.replace(closingTag, `${block('    ')}  ${closingTag}`);
  }
  return next;
}

function defaultCameraBackupRules(dataExtractionRules) {
  if (!dataExtractionRules) {
    return [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<full-backup-content>',
      '  <!-- Keystore material is device-bound; keep all other existing backup policy unchanged. -->',
      '  <exclude domain="sharedpref" path="SecureStore" />',
      '</full-backup-content>',
      '',
    ].join('\n');
  }
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<data-extraction-rules>',
    '  <cloud-backup>',
    '    <!-- Keystore material is device-bound; keep all other existing backup policy unchanged. -->',
    '    <exclude domain="sharedpref" path="SecureStore" />',
    '  </cloud-backup>',
    '  <device-transfer>',
    '    <exclude domain="sharedpref" path="SecureStore" />',
    '  </device-transfer>',
    '</data-extraction-rules>',
    '',
  ].join('\n');
}

function renderCameraTemplate(templatePath, packageName) {
  return fs.readFileSync(templatePath, 'utf8')
    .replaceAll('__PACKAGE_NAME__', packageName);
}

function withCameraManifest(config) {
  return withAndroidManifest(config, (config) => {
    config.modResults = applyCameraManifest(config.modResults);
    return config;
  });
}

function withCameraGradleDependencies(config) {
  return withAppBuildGradle(config, (config) => {
    config.modResults.contents = applyCameraGradleDependencies(config.modResults.contents);
    return config;
  });
}

function withCameraNativeSources(config) {
  return withDangerousMod(config, ['android', async (config) => {
    const packageName = config.android?.package || 'com.anonymous.junluo';
    const packagePath = packageName.split('.').join(path.sep);
    const javaRoot = path.join(
      config.modRequest.platformProjectRoot,
      'app/src/main/java',
      ...packageName.split('.'),
      MODULE_PACKAGE_SEGMENT,
    );
    const legacyServicePath = path.join(javaRoot, `${SERVICE_CLASS_NAME}.java`);
    if (fs.existsSync(legacyServicePath)) {
      const existingLegacyService = fs.readFileSync(legacyServicePath, 'utf8');
      if (existingLegacyService === legacyCameraServiceJava(packageName)) {
        fs.unlinkSync(legacyServicePath);
      } else {
        throw new Error(`JunLuo camera plugin refused to delete modified legacy service: ${legacyServicePath}`);
      }
    }
    const templateRoot = path.join(__dirname, 'withJunLuoCameraAndroid', 'templates');
    for (const mapping of CAMERA_TEMPLATE_MAPPINGS) {
      const templatePath = path.join(templateRoot, ...mapping.template.split('/'));
      const destination = mapping.destination.replace('{packagePath}', packagePath);
      writeFileIfChanged(
        path.join(config.modRequest.platformProjectRoot, ...destination.split('/')),
        renderCameraTemplate(templatePath, packageName),
      );
    }
    const backupRuleFiles = [
      ['app/src/main/res/xml/junluo_backup_rules.xml', false],
      ['app/src/main/res/xml/junluo_data_extraction_rules.xml', true],
    ];
    for (const [relativePath, dataExtractionRules] of backupRuleFiles) {
      const filePath = path.join(config.modRequest.platformProjectRoot, ...relativePath.split('/'));
      const existingRules = fs.existsSync(filePath)
        ? fs.readFileSync(filePath, 'utf8')
        : defaultCameraBackupRules(dataExtractionRules);
      writeFileIfChanged(
        filePath,
        applyCameraBackupExcludes(existingRules, dataExtractionRules),
      );
    }
    return config;
  }]);
}

function withCameraMainApplication(config) {
  return withMainApplication(config, (config) => {
    const packageName = config.android?.package || 'com.anonymous.junluo';
    config.modResults.contents = applyCameraMainApplication(config.modResults.contents, packageName);
    return config;
  });
}

function withJunLuoCameraAndroid(config) {
  config = withCameraManifest(config);
  config = withCameraGradleDependencies(config);
  config = withCameraMainApplication(config);
  config = withCameraNativeSources(config);
  return config;
}

module.exports = withJunLuoCameraAndroid;
module.exports.applyCameraManifest = applyCameraManifest;
module.exports.applyCameraGradleDependencies = applyCameraGradleDependencies;
module.exports.applyCameraMainApplication = applyCameraMainApplication;
module.exports.legacyCameraServiceJava = legacyCameraServiceJava;
module.exports.CAMERA_DEPENDENCIES = CAMERA_DEPENDENCIES;
module.exports.CAMERA_DEPENDENCIES_BEGIN = CAMERA_DEPENDENCIES_BEGIN;
module.exports.CAMERA_DEPENDENCIES_END = CAMERA_DEPENDENCIES_END;
module.exports.CAMERA_TEMPLATE_MAPPINGS = CAMERA_TEMPLATE_MAPPINGS;
module.exports.CAMERA_BACKUP_EXCLUDED_SHARED_PREFS = CAMERA_BACKUP_EXCLUDED_SHARED_PREFS;
module.exports.applyCameraBackupExcludes = applyCameraBackupExcludes;
module.exports.defaultCameraBackupRules = defaultCameraBackupRules;
module.exports.SERVICE_MANIFEST_NAME = SERVICE_MANIFEST_NAME;
module.exports.AUTOMATIC_TASK_SERVICE_MANIFEST_NAME = AUTOMATIC_TASK_SERVICE_MANIFEST_NAME;
module.exports.AUTOMATIC_ALARM_RECEIVER_MANIFEST_NAME = AUTOMATIC_ALARM_RECEIVER_MANIFEST_NAME;
module.exports.MANUAL_SAVE_PICKER_MANIFEST_NAME = MANUAL_SAVE_PICKER_MANIFEST_NAME;
