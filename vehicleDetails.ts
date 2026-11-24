export const DEFAULT_CAPACITY = 200;
export const AISLES = 'ABCDEFGHIJKLMNOPQRST'.split('');

export type VehicleDetails = {
  keyNumber?: string | null;
  aisle?: string | null;
  makeModel?: string | null;
  loadingNote?: string | null;
};

export type DetailsForm = { keyNumber: string; aisle: string; makeModel: string; loadingNote: string };

export function detailsForm(visit?: VehicleDetails): DetailsForm {
  return {
    keyNumber: visit?.keyNumber ?? '',
    aisle: visit?.aisle ?? '',
    makeModel: visit?.makeModel ?? '',
    loadingNote: visit?.loadingNote ?? '',
  };
}

export function normalizeReference(value: string) {
  return value.normalize('NFKC').trim().toUpperCase();
}

export function validKey(value: string) {
  return /^[A-Z0-9][A-Z0-9-]{0,31}$/.test(value);
}

export function validParkingPosition(key: string, aisle: string) {
  return validKey(normalizeReference(key)) && AISLES.includes(aisle);
}

export function assertAvailableKey(visits: (VehicleDetails & { id: string; exitAt: string | null })[],
  key: string, excludedId?: string) {
  if (visits.some((visit) => visit.id !== excludedId && visit.exitAt === null && visit.keyNumber === key)) {
    throw new Error('Ce numéro de clé est déjà affecté à un véhicule présent.');
  }
}

export function validLoadingNote(value: string) {
  return /^[A-Z0-9][A-Z0-9./_-]{0,63}$/.test(value);
}
