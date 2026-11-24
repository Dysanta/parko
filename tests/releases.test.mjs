import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

function localReleaseFixture() {
  const modules = new Map();
  const storage = new Map();
  const asyncStorage = {
    getItem: async (key) => storage.get(key) ?? null,
    setItem: async (key, value) => { storage.set(key, value); },
  };

  function load(name) {
    if (name === '@react-native-async-storage/async-storage') return { __esModule: true, default: asyncStorage };
    const cached = modules.get(name);
    if (cached) return cached;
    const source = readFileSync(new URL(`../${name}.ts`, import.meta.url), 'utf8');
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    });
    const exports = {};
    new Function('require', 'exports', outputText)(load, exports);
    modules.set(name, exports);
    return exports;
  }

  const registry = [{
    id: 'visit-1', plate: 'AB123CD', entryAt: '2026-11-01T08:00:00Z', exitAt: null,
    photoUri: null, keyNumber: '007', aisle: 'A',
  }];
  const note = {
    reference: 'BL-1', lot: 'L1', pickupDate: '2026-11-01', pickupLocation: 'Parking',
    transport: 'Transport', vehicles: [{ plate: 'AB123CD', makeModel: 'Modèle' }],
  };
  storage.set('@stationnement/vehicles', JSON.stringify(registry));
  return { ...load('./loadingDocuments'), storage, registry, note };
}

test('reserves a visit once, then assigns a new number after cancellation', async () => {
  const fixture = localReleaseFixture();
  const { issueReleaseDocument, cancelReleaseDocument, readReleaseDocument, withLocalRelease, registry, note } = fixture;
  const outcomes = await Promise.allSettled([
    issueReleaseDocument(note),
    issueReleaseDocument({ ...note, reference: 'BL-2' }),
  ]);
  assert.equal(outcomes[0].status, 'fulfilled');
  const issued = outcomes[0].value;
  assert.equal(issued.number, 1);
  assert.equal(outcomes[1].status, 'rejected');
  assert.match(outcomes[1].reason.message, /déjà réservé.*000001/);

  const cancelled = await cancelReleaseDocument(issued);
  assert.ok(cancelled.cancelledAt);
  assert.equal(registry[0].exitAt, null);
  assert.equal(await readReleaseDocument(note.reference), undefined);
  await assert.rejects(withLocalRelease(issued.number, async () => {}), /annulé/);
  const renewed = await issueReleaseDocument(note);
  assert.equal(renewed.number, 2);
  assert.ok((await readReleaseDocument(issued.number)).cancelledAt);
});

test('archives overlapping older data and validates the pickup time against the entry', async () => {
  const { issueReleaseDocument, readReleaseDocument, applyLocalRelease, note, registry, storage } = localReleaseFixture();
  const first = await issueReleaseDocument(note);
  storage.set('@stationnement/exit-documents', JSON.stringify([first, { ...first, number: 2, reference: 'BL-2' }]));
  storage.delete('@stationnement/exit-reservations-v1');
  assert.ok((await readReleaseDocument(2)).cancelledAt);
  assert.equal((await readReleaseDocument(1)).cancelledAt, undefined);
  assert.throws(() => applyLocalRelease(first, registry, Date.parse('2026-11-01T07:00:00Z'), [first]), /antérieure/);
  const pickedUp = applyLocalRelease(first, registry, Date.parse('2026-11-01T09:00:00Z'), [first]);
  assert.equal(pickedUp[0].exitAt, '2026-11-01T09:00:00.000Z');
  assert.equal(pickedUp[0].loadingNote, note.reference);
});
