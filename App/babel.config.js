// Babel config used by Jest (and Expo CLI).
// babel-preset-expo handles TypeScript and JSX for the test environment.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
  };
};
