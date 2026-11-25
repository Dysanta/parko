import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { createClient } from '@supabase/supabase-js';

const seedParking = '10000000-0000-4000-8000-000000000001';
const env = parseEnv(readFileSync('.env.parko-test.local', 'utf8'));
const endpoint = new URL(env.EXPO_PUBLIC_SUPABASE_URL);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) && endpoint.port === '54321',
  'Les tests utilisent uniquement le Supabase local de PARKO.');
assert.equal(env.EXPO_PUBLIC_PARKING_ID, seedParking, 'Utilise le parking fictif du seed.');
assert.match(env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY, /^sb_publishable_/);

function checked({ data, error }) {
  if (error) throw error;
  return data;
}

async function connect(name) {
  const client = createClient(endpoint.origin, env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  if (name) checked(await client.auth.signInWithPassword({
    email: `${name}@parko.example`, password: 'Parko-Local-2026!',
  }));
  return client;
}

const agent = await connect('agent');
const manager = await connect('responsable');
const outsider = await connect('externe');
const anonymous = await connect();
const target = { target_parking: seedParking };
const agentAccess = checked(await agent.rpc('read_parking_access', target));
const managerAccess = checked(await manager.rpc('read_parking_access', target));
assert.equal(agentAccess.role, 'agent');
assert.equal(managerAccess.role, 'responsable');
assert.equal(checked(await outsider.rpc('read_parking_access', target)), null);
assert.ok((await anonymous.rpc('read_parking_access', target)).error);

const protectedMembers = [[agent, agentAccess], [manager, managerAccess]].filter(([, access]) => access.mfaRequired);
if (protectedMembers.length) {
  for (const [client, access] of protectedMembers) {
    assert.deepEqual(checked(await client.from('parkings').select('id').eq('id', seedParking)), []);
    assert.equal(checked(await client.rpc('read_parking_reports', target)), null);
    const { error } = await client.rpc('receive_parking_vehicle', {
      ...target, visit_id: randomUUID(), plate_text: 'TESTMFA', key_text: 'TEST',
      aisle_text: 'A', model_text: 'Véhicule de test', with_photo: false,
    });
    assert.equal(error?.code, '42501');
    console.log(`MFA vérifié : accès refusé au rôle ${access.role} avec le mot de passe seul.`);
  }
} else {
  await checkOperations();
}

async function checkOperations() {
  const id = randomUUID();
  const code = id.split('-')[0].toUpperCase();
  const plate = `TEST${code}`;
  const today = new Date().toISOString().slice(0, 10);
  const entry = {
    ...target, visit_id: id, plate_text: plate, key_text: code,
    aisle_text: 'A', model_text: 'Véhicule de test', with_photo: true,
  };
  assert.ok((await outsider.rpc('receive_parking_vehicle', entry)).error);
  assert.equal(checked(await agent.rpc('receive_parking_vehicle', entry)), id);
  assert.deepEqual(checked(await outsider.from('parking_visits').select('id').eq('id', id)), []);
  assert.ok((await anonymous.from('parking_visits').select('id').eq('id', id)).error);
  const photo = `${seedParking}/${id}`;
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBzUAAAAASUVORK5CYII=', 'base64');
  checked(await agent.storage.from('parko-plates').upload(photo, pixel, { contentType: 'image/png' }));
  assert.ok(checked(await agent.storage.from('parko-plates').createSignedUrl(photo, 30)).signedUrl);
  assert.ok((await outsider.storage.from('parko-plates').createSignedUrl(photo, 30)).error);
  assert.ok((await anonymous.storage.from('parko-plates').download(photo)).error);

  const serviceId = randomUUID();
  checked(await agent.from('parking_visit_services').insert({
    id: serviceId, visit_id: id, kind: 'photos', performed_on: today, time_zone: 'UTC',
  }));
  const snapshot = async (client) => (checked(await client.rpc('read_parking_reports', target))).vehicles.find((v) => v.id === id);
  assert.deepEqual((await snapshot(agent)).billing.services, []);
  assert.equal((await snapshot(manager)).billing.services[0].id, serviceId);
  assert.equal(checked(await outsider.rpc('read_parking_reports', target)), null);

  const removeService = async (client) => checked(await client.from('parking_visit_services').delete().eq('id', serviceId).select('id'));
  assert.deepEqual(await removeService(agent), []);
  assert.deepEqual(await removeService(manager), [{ id: serviceId }]);

  const issue = checked(await agent.rpc('issue_parking_exit_document', {
    ...target, loading: {
      reference: `TEST-${code}`, lot: 'LOT-TEST', pickupDate: today, pickupLocation: 'Parking de test',
      transport: 'Transport de test', vehicles: [{ plate, makeModel: 'Véhicule de test' }],
    },
  }));
  const release = { ...target, release_number: issue.number };
  assert.deepEqual(checked(await outsider.from('parking_exit_documents').select('document_number').eq('document_number', issue.number)), []);
  assert.equal((await agent.rpc('cancel_parking_exit_document', release)).error?.code, '42501');
  assert.ok(checked(await manager.rpc('cancel_parking_exit_document', release)).cancelledAt);
  const audit = (client) => client.from('parking_audit').select('actor_id, action').eq('reference', String(issue.number));
  assert.deepEqual(checked(await audit(agent)), []);
  assert.ok(checked(await audit(manager)).some(row => row.actor_id && row.action === 'bon_annule'));
  assert.ok((await manager.from('parking_audit').delete().eq('reference', String(issue.number))).error);

  console.log('Accès anonymes et externes, photos privées, rôles et journal vérifiés sur le parking fictif.');
}
