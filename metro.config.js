const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Expo's development bundle scans .env files independently of the CLI loader.
// The isolated launcher supplies its own variables and must skip that scan's files.
const dotenvFiles = process.env.EXPO_NO_DOTENV === '1'
  ? /(^|[\\/])\.env(?:\.[^\\/]*)?$/
  : /(^|[\\/])\.env\.parko-[^\\/]*$/;

config.resolver.blockList = [...[].concat(config.resolver.blockList), dotenvFiles];

module.exports = config;
