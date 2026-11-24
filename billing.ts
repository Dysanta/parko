export const PROVIDER = 'PERFECT PARK';

export const SERVICES = {
  photos: { label: 'Photos détaillées', cents: 800 },
  inspection: { label: 'Contrôle visuel spécifique', cents: 1000 },
  exterior: { label: 'Lavage extérieur simple', cents: 1500 },
  full_wash: { label: 'Lavage intérieur et extérieur', cents: 3500 },
};

export type ServiceKind = keyof typeof SERVICES;
export type VisitService = { id: string; kind: ServiceKind; performedOn: string };
export type VisitBilling = { services: VisitService[] };

export const STORAGE_DAY_LABEL = 'Toute journée civile entamée est due selon le fuseau horaire de cet appareil.';
const ENTRY_FEE = 800;
const EXIT_FEE = 700;

type BillableVisit = {
  plate: string;
  entryAt: string;
  exitAt: string | null;
  entryTimeKnown?: boolean;
  exitTimeKnown?: boolean;
  billing?: VisitBilling;
};

// The historical spreadsheet imported date-only rows as midnight in Paris.
const importedDate = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Paris',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const euro = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const dayMs = 86_400_000;

export function billingDate(value: number | string, timeKnown = true) {
  const date = new Date(value);
  if (!timeKnown) {
    const [day, month, year] = importedDate.format(date).split('/');
    return `${year}-${month}-${day}`;
  }
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function validBillingDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

export function formatEuros(cents: number) {
  return euro.format(cents / 100);
}

export function parseRate(value: string) {
  const match = /^(\d{1,6})(?:[.,](\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return cents > 0 ? cents : null;
}

function dayIndex(date: string) {
  return Date.parse(date) / dayMs;
}

export function calculateStatement(
  vehicles: BillableVisit[],
  month: string,
  asOf: number,
  negotiatedRate: number | null = null,
) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new Error('Choisis un mois de facturation valide.');
  }
  const first = `${month}-01`;
  const nextMonth = new Date(first);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const start = dayIndex(first);
  const end = nextMonth.getTime() / dayMs;
  const today = billingDate(asOf);
  const inMonth = (date: string) => date.startsWith(`${month}-`);

  const visits = vehicles.flatMap((visit) => {
    const entered = Date.parse(visit.entryAt);
    if (entered > asOf) return [];
    const exited = visit.exitAt ? Date.parse(visit.exitAt) : null;
    const completed = exited !== null && exited <= asOf;
    const entryDay = billingDate(entered, visit.entryTimeKnown);
    const exitDay = completed ? billingDate(exited, visit.exitTimeKnown) : null;
    let endOfPresence = dayIndex(today) + 1;
    if (completed && exitDay) {
      const lastDay = visit.exitTimeKnown === false ? dayIndex(exitDay) - 1 : dayIndex(billingDate(exited - 1));
      endOfPresence = Math.max(dayIndex(entryDay), lastDay) + 1;
    }
    const storageStart = Math.max(start, dayIndex(entryDay));
    const storageEnd = Math.min(end, endOfPresence);
    const days = Math.max(0, storageEnd - storageStart);
    const received = inMonth(entryDay) ? 1 : 0;
    const released = exitDay && inMonth(exitDay) ? 1 : 0;
    const services = (visit.billing?.services ?? []).filter(
      ({ performedOn }) => inMonth(performedOn) && performedOn <= today,
    );
    if (!days && !received && !released && !services.length) return [];

    return [{
      plate: visit.plate, entryDay, exitDay, days, received, released, services, storageStart, storageEnd,
      servicesAndMovements: received * ENTRY_FEE + released * EXIT_FEE
        + services.reduce((sum, service) => sum + SERVICES[service.kind].cents, 0),
    }];
  });

  const total = (key: 'days' | 'received' | 'released') => visits.reduce((sum, visit) => sum + visit[key], 0);
  const receipts = total('received');
  const days = total('days');
  const releases = total('released');
  const agreedRate = negotiatedRate !== null && Number.isSafeInteger(negotiatedRate) && negotiatedRate > 0
    ? negotiatedRate : null;
  const rate = receipts >= 1 && receipts <= 100 ? 199
    : receipts >= 101 && receipts <= 200 ? 170
    : agreedRate;
  const needsRate = days > 0 && rate === null;
  const rows = [
    { label: 'Stockage', quantity: days, unit: 'jour-véhicule', rate },
    { label: 'Réception et rangement', quantity: total('received'), unit: 'entrée', rate: ENTRY_FEE },
    { label: 'Sortie et mise à disposition', quantity: releases, unit: 'sortie', rate: EXIT_FEE },
    ...Object.entries(SERVICES).map(([kind, service]) => ({
      label: service.label,
      quantity: visits.reduce((sum, visit) => sum + visit.services.filter((item) => item.kind === kind).length, 0),
      unit: 'prestation',
      rate: service.cents,
    })),
  ];
  return {
    month, asOf, rows, receipts, releases, storageDays: days, storageRate: rate, needsRate,
    visits: visits.map(({ servicesAndMovements, ...visit }) => ({
      ...visit,
      cents: visit.days && rate === null ? null : servicesAndMovements + visit.days * (rate ?? 0),
    })),
    total: needsRate ? null : rows.reduce((sum, row) => sum + row.quantity * (row.rate ?? 0), 0),
  };
}

export type Statement = ReturnType<typeof calculateStatement>;

export function calculateDailyFinance(vehicles: BillableVisit[], month: string, asOf: number, rate?: number | null) {
  const statement = calculateStatement(vehicles, month, asOf, rate);
  const today = billingDate(asOf);
  const first = dayIndex(`${month}-01`);
  const storageRate = statement.storageRate;
  const days = [];
  let cumulative: number | null = 0;
  for (let index = first; ; index += 1) {
    const date = new Date(index * dayMs).toISOString().slice(0, 10);
    if (!date.startsWith(`${month}-`) || date > today) break;
    let entries = 0;
    let exits = 0;
    let stored = 0;
    let present = 0;
    let services = 0;
    for (const visit of statement.visits) {
      if (visit.entryDay === date) entries += 1;
      if (visit.exitDay === date) exits += 1;
      if (index >= visit.storageStart && index < visit.storageEnd) stored += 1;
      if (visit.entryDay <= date && (visit.exitDay === null || visit.exitDay > date)) present += 1;
      for (const service of visit.services) {
        if (service.performedOn === date) services += SERVICES[service.kind].cents;
      }
    }
    const entryRevenue = entries * ENTRY_FEE;
    const exitRevenue = exits * EXIT_FEE;
    const storageRevenue = storageRate === null && stored ? null : stored * (storageRate ?? 0);
    const total = storageRevenue === null ? null : entryRevenue + exitRevenue + storageRevenue + services;
    cumulative = cumulative === null || total === null ? null : cumulative + total;
    days.push({ date, entries, exits, stored, present, entryRevenue, exitRevenue, storageRevenue, services, total, cumulative });
  }
  return { days, storageRate, statement };
}
