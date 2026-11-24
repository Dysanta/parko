import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../billing.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const { billingDate, calculateStatement, calculateDailyFinance, parseRate } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputText).toString('base64')
);

test('splits a stay across months and charges each movement or service only once', () => {
  const visit = {
    plate: 'AB123CD',
    entryAt: '2026-10-31T21:00:00',
    exitAt: '2026-11-02T10:00:00',
    billing: { services: [
      { id: '1', kind: 'photos', performedOn: '2026-10-31' },
      { id: '2', kind: 'inspection', performedOn: '2026-11-01' },
      { id: '3', kind: 'exterior', performedOn: '2026-11-01' },
      { id: '4', kind: 'full_wash', performedOn: '2026-11-02' },
    ] },
  };
  const asOf = Date.parse('2026-11-20T12:00');
  const october = calculateStatement([visit], '2026-10', asOf);
  const november = calculateStatement([visit], '2026-11', asOf, 170);
  assert.deepEqual(october.rows.map((row) => row.quantity), [1, 1, 0, 1, 0, 0, 0]);
  assert.deepEqual(november.rows.map((row) => row.quantity), [2, 0, 1, 0, 1, 1, 1]);
  assert.equal(october.total, 1799);
  assert.equal(november.total, 7040);
  assert.equal(calculateStatement([visit], '2026-11', asOf).total, null);
});

test('uses indivisible local days across a daylight saving change', () => {
  withTimeZone('Europe/Paris', () => {
    const visit = {
      plate: 'AB123CD',
      entryAt: '2026-10-24T22:30:00Z',
      exitAt: '2026-10-25T23:00:00Z',
      billing: { services: [] },
    };
    assert.equal(billingDate(visit.entryAt), '2026-10-25');
    assert.equal(billingDate(visit.exitAt), '2026-10-26');
    const asOf = Date.parse('2026-10-27T12:00Z');
    const statement = calculateStatement([visit, { ...visit, plate: 'CD456EF', billing: undefined }], '2026-10', asOf);
    assert.equal(statement.visits.length, 2);
    assert.equal(statement.total, 3398);
  });
});

function withTimeZone(zone, check) {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    check();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

test('moves a UTC month boundary with the device time zone and preserves imported civil dates', () => {
  const visit = { plate: 'AB123CD', entryAt: '2026-11-01T00:30:00Z', exitAt: '2026-11-01T07:00:00Z' };
  const asOf = Date.parse('2026-11-01T08:00:00Z');
  withTimeZone('America/Los_Angeles', () => {
    const october = calculateStatement([visit], '2026-10', asOf);
    const november = calculateDailyFinance([visit], '2026-11', asOf, 199);
    assert.equal(october.visits[0].entryDay, '2026-10-31');
    assert.equal(october.visits[0].days, 1);
    assert.equal(november.days[0].exits, 1);
    assert.equal(november.days[0].stored, 0);
    assert.equal(billingDate('2026-10-31T23:00:00Z', false), '2026-11-01');
  });
  withTimeZone('Africa/Lome', () => {
    const november = calculateDailyFinance([visit], '2026-11', asOf);
    assert.equal(november.days[0].entries, 1);
    assert.equal(november.days[0].exits, 1);
    assert.equal(november.days[0].stored, 1);
  });
});

test('stays still present contribute only through the calculation date', () => {
  const visit = { plate: 'AB123CD', entryAt: '2026-10-01T15:00:00', exitAt: null, billing: { services: [] } };
  const asOf = Date.parse('2026-11-02T00:00');
  const statement = calculateStatement([visit], '2026-11', asOf, 199);
  assert.equal(statement.total, 398);
  assert.equal(statement.receipts, 0);
});

test('applies the monthly band to all storage and keeps the movement fees at each boundary', () => {
  const asOf = Date.parse('2026-11-03T00:00');
  const closed = { entryAt: '2026-11-01T10:00:00', exitAt: '2026-11-01T10:10:00' };
  for (const [entries, rate] of [[1, 199], [100, 199], [101, 170], [200, 170], [201, null]]) {
    const visits = Array.from({ length: entries }, (_, index) => ({ ...closed, plate: `AA${index}` }));
    const statement = calculateStatement(visits, '2026-11', asOf);
    assert.equal(statement.receipts, entries);
    assert.equal(statement.rows[0].rate, rate);
    assert.equal(statement.rows[0].quantity, entries);
    assert.equal(statement.rows[1].quantity, entries);
    assert.equal(statement.rows[2].quantity, entries);
    assert.equal(statement.total, rate === null ? null : entries * (rate + 800 + 700));
    const withQuote = calculateStatement(visits, '2026-11', asOf, 125);
    assert.equal(withQuote.total, entries * ((rate ?? 125) + 800 + 700));
  }
});

test('parses negotiated rates in integer euro cents', () => {
  assert.equal(parseRate('1,7'), 170);
  assert.equal(parseRate('1.99'), 199);
  assert.equal(parseRate('1,009'), null);
  assert.equal(parseRate('0'), null);
});

test('daily revenue and occupancy reconcile with the monthly statement', () => {
  const visits = [
    { plate: 'AB123CD', entryAt: '2026-10-31T18:00:00', exitAt: '2026-11-02T09:00:00',
      billing: { services: [{ id: '1', kind: 'photos', performedOn: '2026-11-02' }] } },
    { plate: 'AA123BB', entryAt: '2026-11-02T12:00:00', exitAt: null },
  ];
  const asOf = Date.parse('2026-11-03T08:00:00');
  const result = calculateDailyFinance(visits, '2026-11', asOf);
  const { days, statement } = result;
  assert.equal(result.storageRate, 199);
  assert.deepEqual(days.map(({ entries, exits, stored, present }) => [entries, exits, stored, present]), [
    [0, 0, 1, 1], [1, 1, 2, 1], [0, 0, 1, 1],
  ]);
  assert.deepEqual(days.map((day) => day.total), [199, 2698, 199]);
  assert.equal(days.at(-1).cumulative, statement.total);
  assert.equal(calculateDailyFinance(visits.slice(0, 1), '2026-11', asOf).days.at(-1).cumulative, null);
});
