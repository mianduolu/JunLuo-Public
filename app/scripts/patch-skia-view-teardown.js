const fs = require('fs');
const path = require('path');

require('./patch-react-native-chat-draft-input');

const target = path.join(
  __dirname,
  '..',
  'node_modules',
  '@shopify',
  'react-native-skia',
  'android',
  'cpp',
  'jni',
  'include',
  'JniSkiaBaseView.h',
);

const replacements = [
  {
    before: '_manager(skiaManager->cthis())',
    after: '_manager(skiaManager->cthis()->getSkiaManager())',
  },
  {
    before: [
      '  std::shared_ptr<RNSkManager> getSkiaManager() {',
      '    return _manager->getSkiaManager();',
      '  }',
    ].join('\n'),
    after: '  std::shared_ptr<RNSkManager> getSkiaManager() { return _manager; }',
  },
  {
    before: [
      '  virtual void registerView(int nativeId) {',
      '    getSkiaManager()->registerSkiaView(nativeId,',
      '                                       _skiaAndroidView->getSkiaView());',
      '  }',
      '',
      '  virtual void unregisterView() {',
      '    getSkiaManager()->setSkiaView(',
      '        _skiaAndroidView->getSkiaView()->getNativeId(), nullptr);',
      '    getSkiaManager()->unregisterSkiaView(',
      '        _skiaAndroidView->getSkiaView()->getNativeId());',
      '  }',
    ].join('\n'),
    after: [
      '  virtual void registerView(int nativeId) {',
      '    auto manager = getSkiaManager();',
      '    auto view = _skiaAndroidView ? _skiaAndroidView->getSkiaView() : nullptr;',
      '    if (!manager || !view) {',
      '      return;',
      '    }',
      '    manager->registerSkiaView(nativeId, view);',
      '  }',
      '',
      '  virtual void unregisterView() {',
      '    auto manager = getSkiaManager();',
      '    auto view = _skiaAndroidView ? _skiaAndroidView->getSkiaView() : nullptr;',
      '    if (!manager || !view) {',
      '      return;',
      '    }',
      '    const auto nativeId = view->getNativeId();',
      '    manager->setSkiaView(nativeId, nullptr);',
      '    manager->unregisterSkiaView(nativeId);',
      '  }',
    ].join('\n'),
  },
  {
    before: '  JniSkiaManager *_manager;',
    after: '  std::shared_ptr<RNSkManager> _manager;',
  },
];

let source = fs.readFileSync(target, 'utf8');
let changed = false;
for (const { before, after } of replacements) {
  if (source.includes(after)) continue;
  const matches = source.split(before).length - 1;
  if (matches !== 1) {
    throw new Error(`Expected one Skia teardown block, found ${matches}.`);
  }
  source = source.replace(before, after);
  changed = true;
}

if (changed) {
  fs.writeFileSync(target, source);
  console.log('Applied Skia view teardown guard.');
} else {
  console.log('Skia view teardown guard is already applied.');
}
