import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../registerEnvironment.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});

function load(mode, development = false) {
  const exports = {};
  new Function('exports', 'process', '__DEV__', outputText)(
    exports, { env: { EXPO_PUBLIC_PARKO_MODE: mode } }, development,
  );
  return exports;
}

test('development defaults to an isolated register and rejects a release mode override', () => {
  assert.equal(load(undefined, true).registerMode, 'offline');
  assert.equal(load('release', true).registerMode, 'offline');
  assert.equal(load('local', true).registerMode, 'local');
  assert.equal(load('offline').registerStorageKey('vehicles'), 'parko-test:vehicles');
  assert.equal(load('local').registerStorageKey('vehicles'), 'parko-test:vehicles');
  assert.equal(load(undefined).registerStorageKey('vehicles'), 'vehicles');
});

test('local Supabase only accepts loopback addresses and the Android emulator', () => {
  const { isLoopbackSupabase } = load('local');
  for (const url of ['http://127.0.0.1:54321', 'http://[::1]:54321', 'http://10.0.2.2:54321']) {
    assert.equal(isLoopbackSupabase(url), true, url);
  }
  for (const url of ['https://production.supabase.co', 'http://localhost@production.example',
    'http://localhost:54321/path', 'http://localhost:54321?redirect=x', 'http://user@localhost']) {
    assert.equal(isLoopbackSupabase(url), false, url);
  }
});
