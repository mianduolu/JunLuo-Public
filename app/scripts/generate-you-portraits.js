const fs = require('fs');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const imageDir = path.join(appRoot, 'assets', 'images');
const outTs = path.join(appRoot, 'src', 'assets', 'youPortraitAssets.ts');
const androidDrawableDir = path.join(appRoot, 'android', 'app', 'src', 'main', 'res', 'drawable-nodpi');

function toResourceName(fileName) {
  return fileName
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const portraits = fs
  .readdirSync(imageDir)
  .filter((name) => /you-portrait.*\.png$/i.test(name))
  .sort((a, b) => a.localeCompare(b));

if (!portraits.length) {
  throw new Error('No you-portrait png files found.');
}

fs.mkdirSync(path.dirname(outTs), { recursive: true });
fs.mkdirSync(androidDrawableDir, { recursive: true });

const lines = [
  'export type YouPortraitAsset = {',
  '  key: string;',
  '  androidResourceName: string;',
  '  source: number;',
  '};',
  '',
  'export const youPortraitAssets: YouPortraitAsset[] = [',
];

for (const fileName of portraits) {
  const key = fileName.replace(/\.png$/i, '');
  const androidResourceName = toResourceName(fileName);
  fs.copyFileSync(path.join(imageDir, fileName), path.join(androidDrawableDir, `${androidResourceName}.png`));
  lines.push(
    `  { key: '${key}', androidResourceName: '${androidResourceName}', source: require('../../assets/images/${fileName}') },`,
  );
}

lines.push('];', '');

fs.writeFileSync(outTs, `${lines.join('\n')}`, 'utf8');

console.log(`Generated ${portraits.length} you portrait assets.`);
