import { createClient } from '@supabase/supabase-js';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

const env = parseEnv(await readFile('.env.parko-backup.local', 'utf8'));
const endpoint = new URL(env.PARKO_LOCAL_STORAGE_URL ?? 'http://127.0.0.1:54321');
const database = new URL(env.PARKO_LOCAL_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres');
const loopback = ['localhost', '127.0.0.1', '[::1]'];
if (!loopback.includes(endpoint.hostname) || !loopback.includes(database.hostname) ||
  endpoint.port !== '54321' || database.port !== '54322' ||
  endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash ||
  database.pathname !== '/postgres' || database.search || database.hash ||
  !['http:', 'https:'].includes(endpoint.protocol) || !['postgresql:', 'postgres:'].includes(database.protocol)) {
  throw new Error('La sauvegarde de test utilise uniquement le Supabase local de PARKO.');
}
if (!env.PARKO_LOCAL_STORAGE_ADMIN_KEY) throw new Error('Renseigne la clé serveur du Supabase local.');

await mkdir('backups', { recursive: true, mode: 0o700 });
const directory = await mkdtemp('backups/parko-local-');
const databaseFile = join(directory, 'registre.dump');
const photosPath = join(directory, 'photos');
await mkdir(photosPath, { mode: 0o700 });

const dump = spawnSync('pg_dump', [
  '--format=custom', '--no-owner', '--file', databaseFile,
], {
  stdio: 'inherit',
  env: {
    PATH: process.env.PATH,
    PGHOST: database.hostname.replace(/^\[|\]$/g, ''),
    PGPORT: database.port,
    PGDATABASE: decodeURIComponent(database.pathname.slice(1)),
    PGUSER: decodeURIComponent(database.username),
    PGPASSWORD: decodeURIComponent(database.password),
  },
});
if (dump.status !== 0) throw new Error('Échec de la sauvegarde PostgreSQL. Vérifie pg_dump et la version du client.');

const storage = createClient(endpoint.origin, env.PARKO_LOCAL_STORAGE_ADMIN_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
}).storage.from('parko-plates');

async function copyObjects(prefix = '') {
  const limit = 100;
  let copied = 0;
  for (let offset = 0; ; offset += limit) {
    const { data: objects, error } = await storage.list(prefix, { limit, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw new Error(error.message);
    for (const object of objects) {
      if (!object.name || object.name === '.' || object.name === '..' || /[\\/\u0000]/.test(object.name)) {
        throw new Error('Nom de fichier inattendu dans le stockage local.');
      }
      const remote = prefix ? `${prefix}/${object.name}` : object.name;
      if (object.id === null) {
        await mkdir(join(photosPath, remote), { recursive: true, mode: 0o700 });
        copied += await copyObjects(remote);
      } else {
        const { data: blob, error: issue } = await storage.download(remote);
        if (issue) throw new Error(issue.message);
        await writeFile(join(photosPath, remote), Buffer.from(await blob.arrayBuffer()), { mode: 0o600 });
        copied += 1;
      }
    }
    if (objects.length < limit) return copied;
  }
}

const photos = await copyObjects();
await writeFile(join(directory, 'inventaire.json'), JSON.stringify({ generatedAt: new Date(), photos }, null, 2));
console.log(`Sauvegarde locale créée dans ${directory}. Base et ${photos} photo(s) sauvegardées séparément.`);
