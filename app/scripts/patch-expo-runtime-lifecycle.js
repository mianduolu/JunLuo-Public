const fs = require('fs');
const path = require('path');

const target = path.join(
  __dirname, '..', 'node_modules', 'expo-modules-core', 'android', 'src', 'main',
  'java', 'expo', 'modules', 'kotlin', 'RuntimeContext.kt',
);

const replacements = [
  {
    before: '  internal lateinit var jsiContext: JSIContext',
    after: '  private var wasDeallocated = false\n\n  internal lateinit var jsiContext: JSIContext',
  },
  {
    before: '  fun installJSIContext() = synchronized(this) {\n    if (isJSIContextInitialized()) {',
    after: [
      '  fun installJSIContext() = synchronized(this) {',
      '    // A queued getConstants call may arrive after this runtime was destroyed.',
      '    if (wasDeallocated) return',
      '    if (isJSIContextInitialized()) {',
    ].join('\n'),
  },
  {
    before: '  fun deallocate() {\n    coreModule.module._runtimeContext = null',
    after: [
      '  fun deallocate(): Unit = synchronized(this) {',
      '    // Use the installation monitor so teardown cannot clear a live install.',
      '    if (wasDeallocated) return',
      '    wasDeallocated = true',
      '    coreModule.module._runtimeContext = null',
    ].join('\n'),
  },
];

let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
let changed = false;
for (const { before, after } of replacements) {
  if (source.includes(after)) continue;
  const matches = source.split(before).length - 1;
  if (matches !== 1) throw new Error(`Expected one Expo runtime lifecycle block, found ${matches}.`);
  source = source.replace(before, after);
  changed = true;
}
if (changed) fs.writeFileSync(target, source);
console.log(changed ? 'Applied Expo runtime lifecycle fix.' : 'Expo runtime lifecycle fix is already applied.');

const hostTarget = path.join(
  __dirname, '..', 'node_modules', 'expo-modules-core', 'android', 'src', 'main',
  'cpp', 'ExpoModulesHostObject.cpp',
);
const hostBefore = '      auto module = installer->getModule(cName);\n      return module->cthis()->getJSIObject(rt);';
const hostAfter = [
  '      auto module = installer->getModule(cName);',
  '      // The Kotlin registry may be cleared before the C++ installer is deallocated.',
  '      if (!module) {',
  '        return std::shared_ptr<jsi::Object>(nullptr);',
  '      }',
  '      return module->cthis()->getJSIObject(rt);',
].join('\n');
const hostSource = fs.readFileSync(hostTarget, 'utf8').replace(/\r\n/g, '\n');
if (hostSource.includes(hostAfter)) {
  console.log('Expo lazy module null guard is already applied.');
} else {
  const matches = hostSource.split(hostBefore).length - 1;
  if (matches !== 1) throw new Error(`Expected one Expo lazy module block, found ${matches}.`);
  fs.writeFileSync(hostTarget, hostSource.replace(hostBefore, hostAfter));
  console.log('Applied Expo lazy module null guard.');
}
