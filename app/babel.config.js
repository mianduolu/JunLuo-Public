module.exports = function (api) {
  api.cache(true);

  return {
    presets: [require.resolve('babel-preset-expo')],
    plugins: ['react-native-reanimated/plugin'],
  };
};
