import type { Vehicle } from './cloudRegister';

export type LoadingVehicle = { plate: string; makeModel: string };
export type LoadingNote = {
  reference: string;
  lot: string;
  pickupDate: string;
  pickupLocation: string;
  transport: string;
  vehicles: LoadingVehicle[];
};
export type ReleaseRow = LoadingVehicle & { aisle: string; keyNumber: string; visitId: string };
export type ReleaseDocument = Omit<LoadingNote, 'vehicles' | 'pickupLocation'> & {
  pickupLocation?: string;
  confirmedAt?: string;
  cancelledAt?: string;
  cancellationReason?: string;
  number: number;
  rows: ReleaseRow[];
};

export function formatReleaseNumber(number: number) {
  return String(number).padStart(6, '0');
}

export function releaseConfirmationDate(document: ReleaseDocument, visits: ReadonlyMap<string, Vehicle>) {
  if (document.cancelledAt) return undefined;
  if (document.confirmedAt) return document.confirmedAt;
  let latest: string | undefined;
  for (const { visitId } of document.rows) {
    const visit = visits.get(visitId);
    if (!visit?.exitAt || visit.loadingNote !== document.reference) return undefined;
    if (!latest || Date.parse(visit.exitAt) > Date.parse(latest)) latest = visit.exitAt;
  }
  return latest;
}

export function indexVisitsByPlate(registry: Vehicle[]) {
  const index = new Map<string, Vehicle[]>();
  for (const visit of registry) {
    const matches = index.get(visit.plate);
    if (matches) matches.push(visit);
    else index.set(visit.plate, [visit]);
  }
  return index;
}

export function matchLoadingNote(note: LoadingNote, registry: ReadonlyMap<string, Vehicle[]>) {
  return note.vehicles.map((vehicle) => {
    const samePlate = registry.get(vehicle.plate) ?? [];
    const assigned = samePlate.filter((visit) => visit.loadingNote === note.reference);
    const matches = assigned.length ? assigned : samePlate.filter((visit) => !visit.exitAt && !visit.loadingNote);
    const [match] = matches;
    if (matches.length > 1) return { vehicle, error: 'Plusieurs séjours correspondent à ce bon.' };
    if (!match) return { vehicle, error: 'Véhicule absent ou déjà affecté à un autre bon.' };
    if (!match.aisle || !match.keyNumber) return { vehicle, error: 'Allée ou numéro de clé à compléter.' };
    return { vehicle, row: { ...vehicle, aisle: match.aisle, keyNumber: match.keyNumber, visitId: match.id } };
  });
}

export function sameLoadingNote(note: LoadingNote, document: ReleaseDocument) {
  return note.reference === document.reference && note.lot === document.lot &&
    note.pickupDate === document.pickupDate && note.transport === document.transport &&
    (!note.pickupLocation || !document.pickupLocation || note.pickupLocation === document.pickupLocation) &&
    note.vehicles.length === document.rows.length &&
    note.vehicles.every((vehicle, index) =>
      vehicle.plate === document.rows[index].plate && vehicle.makeModel === document.rows[index].makeModel);
}
