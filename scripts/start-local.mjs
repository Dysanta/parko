import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { parseEnv } from 'node:util';

const [mode = 'offline', ...flags] = process.argv.slice(2);
if (!['offline', 'local'].includes(mode)) throw new Error('Choisis le mode offline ou local.');

const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('EXPO_PUBLIC_')));
env.EXPO_NO_DOTENV = '1';
env.EXPO_PUBLIC_PARKO_MODE = mode;
if (mode === 'local') {
  const local = parseEnv(readFileSync('.env.parko-test.local', 'utf8'));
  const url = new URL(local.EXPO_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321');
  if (!['127.0.0.1', '[::1]', 'localhost', '10.0.2.2'].includes(url.hostname) ||
    !['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
    url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Le mode local exige une adresse Supabase de boucle locale.');
  }
  env.EXPO_PUBLIC_SUPABASE_URL = url.origin;
  env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = local.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  env.EXPO_PUBLIC_PARKING_ID = local.EXPO_PUBLIC_PARKING_ID ?? '10000000-0000-4000-8000-000000000001';
  if (!/^sb_publishable_/.test(env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '')) {
    throw new Error('Renseigne la clé publiable du Supabase local dans .env.parko-test.local.');
  }
}

const child = spawn(process.execPath, ['./node_modules/expo/bin/cli', 'start', ...flags], { env, stdio: 'inherit' });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
