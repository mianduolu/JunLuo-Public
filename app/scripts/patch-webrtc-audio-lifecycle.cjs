const fs = require('node:fs');
const path = require('node:path');

const app = path.resolve(__dirname, '..');
const files = {
  options: 'node_modules/@livekit/react-native-webrtc/android/src/main/java/com/oney/WebRTCModule/WebRTCModuleOptions.java',
  module: 'node_modules/@livekit/react-native-webrtc/android/src/main/java/com/oney/WebRTCModule/WebRTCModule.java',
  livekit: 'node_modules/@livekit/react-native/android/src/main/java/com/livekit/reactnative/LiveKitReactNative.kt',
};

function replaceOnce(source, before, after) {
  if (source.includes(after)) {
    if (source.split(after).length !== 2) throw new Error('Duplicate WebRTC lifecycle patch block.');
    return source;
  }
  if (source.split(before).length !== 2) throw new Error('WebRTC lifecycle source changed; review the patch.');
  return source.replace(before, after);
}

function patchSource(kind, source) {
  source = source.replace(/\r\n/g, '\n');
  if (kind === 'options') {
    source = replaceOnce(source, 'import java.util.concurrent.Callable;',
      'import java.util.concurrent.Callable;\nimport java.util.function.Function;\nimport android.content.Context;');
    return replaceOnce(source, '    public AudioDeviceModule audioDeviceModule;',
      '    public AudioDeviceModule audioDeviceModule;\n    public Function<Context, AudioDeviceModule> audioDeviceModuleFactory;');
  }
  if (kind === 'module') {
    const start = '        AudioDeviceModule adm = options.audioDeviceModule;';
    const end = '        mAudioDeviceModule = adm;';
    const marker = '        // JunLuo: serialize factory ownership with LiveKit runtime teardown.\n';
    if (source.includes(marker)) {
      if (source.split(marker).length !== 2) throw new Error('Duplicate WebRTC lifecycle patch block.');
      return source;
    }
    if (source.split(start).length !== 2 || source.split(end).length !== 2) {
      throw new Error('WebRTC lifecycle source changed; review the constructor.');
    }
    const first = source.indexOf(start);
    const last = source.indexOf(end, first) + end.length;
    let body = source.slice(first, last);
    body = replaceOnce(body, start, [
      '        AudioDeviceModule adm = options.audioDeviceModuleFactory != null',
      '                ? options.audioDeviceModuleFactory.apply(reactContext)',
      '                : options.audioDeviceModule;',
    ].join('\n'));
    body = replaceOnce(body, [
      '        mFactory = pcFactoryBuilder.createPeerConnectionFactory();',
      '',
      "        // PeerConnectionFactory now owns the adm native pointer, and we don't need it anymore.",
      '        adm.release();',
    ].join('\n'), [
      '        try {',
      '            mFactory = pcFactoryBuilder.createPeerConnectionFactory();',
      '        } finally {',
      '            // Drop the Java-owned reference on success and failed construction alike.',
      '            adm.release();',
      '        }',
    ].join('\n'));
    body = body.split('\n').map(line => line ? `    ${line}` : '').join('\n');
    return source.slice(0, first) + marker + '        synchronized (options) {\n' + body
      + '\n        }' + source.slice(last);
  }
  if (kind !== 'livekit') throw new Error(`Unknown lifecycle source: ${kind}`);
  source = replaceOnce(source, 'import java.util.concurrent.Callable',
    'import java.util.concurrent.Callable\nimport java.lang.ref.WeakReference\nimport java.util.function.Function');
  source = replaceOnce(source, '    private var adm: JavaAudioDeviceModule? = null', [
    '    @Volatile private var adm: JavaAudioDeviceModule? = null',
    '    private var audioDeviceModuleOwner: WeakReference<Context>? = null',
  ].join('\n'));
  source = replaceOnce(source, '    private var _audioProcessingController: CustomAudioProcessingController? = null',
    '    @Volatile private var _audioProcessingController: CustomAudioProcessingController? = null');
  source = replaceOnce(source, [
    '        setupAdm(context)',
    '        options.audioDeviceModule = adm',
    "        // CustomAudioProcessingController can't be instantiated before WebRTC is loaded.",
  ].join('\n'), [
    '        setupAdm(context)',
    '        options.audioDeviceModule = adm',
    '        // Called while WebRTC holds the options monitor through native factory creation.',
    '        options.audioDeviceModuleFactory = Function { owner ->',
    '            if (audioDeviceModuleOwner != null && audioDeviceModuleOwner?.get() !== owner) {',
    '                setupAdm(owner.applicationContext)',
    '            }',
    '            audioDeviceModuleOwner = WeakReference(owner)',
    '            options.audioDeviceModule = adm',
    '            requireNotNull(adm)',
    '        }',
    "        // CustomAudioProcessingController can't be instantiated before WebRTC is loaded.",
  ].join('\n'));
  source = replaceOnce(source, [
    '    internal fun invalidate(context: Context) {',
    '        val options = WebRTCModuleOptions.getInstance()',
    '        if (options.audioDeviceModule == adm) {',
    '            options.audioDeviceModule = null',
    '        }',
    '        adm?.release()',
    '        adm = null',
    '',
    '        _audioProcessingController = null',
    '',
    '        // adm needs to be re-setup with a new one each time.',
    '        setupAdm(context)',
    '        options.audioDeviceModule = adm',
    '',
    '    }',
  ].join('\n'), [
    '    internal fun invalidate(context: Context) {',
    '        val options = WebRTCModuleOptions.getInstance()',
    '        synchronized(options) {',
    '            // An older runtime must not release or replace the newer runtime\'s audio.',
    '            if (audioDeviceModuleOwner?.get() !== context) return',
    '            audioDeviceModuleOwner = null',
    '            if (options.audioDeviceModule == adm) {',
    '                options.audioDeviceModule = null',
    '            }',
    '            adm?.release()',
    '            adm = null',
    '            _audioProcessingController = null',
    '',
    '            setupAdm(context.applicationContext)',
    '            options.audioDeviceModule = adm',
    '        }',
    '    }',
  ].join('\n'));
  return source;
}

function applyPatch() {
  for (const [name, version] of [['@livekit/react-native', '2.11.1'], ['@livekit/react-native-webrtc', '144.1.1']]) {
    const actual = JSON.parse(fs.readFileSync(path.join(app, 'node_modules', name, 'package.json'), 'utf8')).version;
    if (actual !== version) throw new Error(`Review WebRTC lifecycle patch for ${name}@${actual}.`);
  }
  // Validate every target before writing any of them.
  const edits = Object.entries(files).map(([kind, relative]) => {
    const target = path.join(app, relative);
    const before = fs.readFileSync(target, 'utf8');
    return { target, before, after: patchSource(kind, before) };
  });
  for (const { target, before, after } of edits) {
    if (before.replace(/\r\n/g, '\n') !== after) fs.writeFileSync(target, after);
  }
  console.log('WebRTC audio lifecycle patch is applied.');
}

module.exports = { files, patchSource, applyPatch };
if (require.main === module) applyPatch();
