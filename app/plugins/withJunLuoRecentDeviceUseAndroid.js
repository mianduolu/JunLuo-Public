const fs = require('node:fs');
const path = require('node:path');
const { withDangerousMod, withMainApplication } = require('@expo/config-plugins');

const files = ['JunLuoRecentDeviceUseModule.kt', 'JunLuoRecentDeviceUsePackage.kt'];
function applyMainApplication(contents, packageName) {
  const importLine = `import ${packageName}.recentuse.JunLuoRecentDeviceUsePackage`;
  let next = contents;
  if (!next.includes(importLine)) {
    const packageLine = /^(package\s+[\w.]+\r?\n)/mu;
    if (!packageLine.test(next)) throw new Error('Recent device use: MainApplication package anchor missing.');
    next = next.replace(packageLine, `$1\n${importLine}\n`);
  }
  if (!next.includes('add(JunLuoRecentDeviceUsePackage())')) {
    const anchor = /(PackageList\(this\)\.packages\.apply\s*\{\r?\n)/u;
    if (!anchor.test(next)) throw new Error('Recent device use: PackageList anchor missing.');
    next = next.replace(anchor, '$1              add(JunLuoRecentDeviceUsePackage())\n');
  }
  return next;
}
function renderTemplates(packageName) {
  return files.map(name => ({ name, contents: fs.readFileSync(path.join(__dirname,
    'withJunLuoRecentDeviceUseAndroid', 'templates', name), 'utf8').replaceAll('{packageName}', packageName) }));
}
module.exports = function withJunLuoRecentDeviceUseAndroid(config) {
  config = withMainApplication(config, mod => {
    mod.modResults.contents = applyMainApplication(mod.modResults.contents, mod.android.package);
    return mod;
  });
  return withDangerousMod(config, ['android', async mod => {
    const destination = path.join(mod.modRequest.platformProjectRoot, 'app', 'src', 'main', 'java',
      ...mod.android.package.split('.'), 'recentuse');
    await fs.promises.mkdir(destination, { recursive: true });
    for (const file of renderTemplates(mod.android.package)) {
      await fs.promises.writeFile(path.join(destination, file.name), file.contents);
    }
    return mod;
  }]);
};
module.exports.applyMainApplication = applyMainApplication;
module.exports.renderTemplates = renderTemplates;
