const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const defaultBlockList = Array.isArray(config.resolver.blockList)
  ? config.resolver.blockList
  : [config.resolver.blockList].filter(Boolean);

config.resolver.blockList = [
  ...defaultBlockList,
  /[\\/]\.cache[\\/].*/,
  /[\\/]\.tmp[\\/].*/,
  /[\\/]android[\\/](?:app[\\/])?build[\\/].*/,
  /[\\/][^\\/]*\.tmp$/,
];

// Windows can exhaust file handles while Metro reads thousands of disk-cache entries.
config.cacheStores = [];

// Android's many dynamic imports otherwise retain overlapping development
// graphs until Metro hits its heap limit. Keep runtime import() timing, but
// deliver their code in one bundle. Preserve Expo's virtual-entry rewrite.
const rewriteRequestUrl = config.server.rewriteRequestUrl;
config.server.rewriteRequestUrl = (url) => {
  const rewritten = rewriteRequestUrl ? rewriteRequestUrl(url) : url;
  return /[?&]platform=android(?:&|$)/.test(rewritten)
    ? rewritten.replace(/([?&])lazy=(?:true|1)(?=&|$)/g, '$1lazy=false')
    : rewritten;
};

module.exports = config;
