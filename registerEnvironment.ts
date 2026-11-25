const requestedMode = process.env.EXPO_PUBLIC_PARKO_MODE;
const development = typeof __DEV__ !== 'undefined' && __DEV__;

export const registerMode = development
  ? (requestedMode === 'local' ? 'local' : 'offline')
  : (requestedMode ?? 'release');

export function isLoopbackSupabase(url: string) {
  try {
    const target = new URL(url);
    return ['http:', 'https:'].includes(target.protocol) &&
      ['localhost', '127.0.0.1', '[::1]', '10.0.2.2'].includes(target.hostname) &&
      !target.username && !target.password && target.pathname === '/' && !target.search && !target.hash;
  } catch {
    return false;
  }
}

export function registerStorageKey(key: string) {
  return registerMode === 'offline' || registerMode === 'local' ? `parko-test:${key}` : key;
}
