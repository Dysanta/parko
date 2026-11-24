import AsyncStorage from '@react-native-async-storage/async-storage';
import { SERVICES, validBillingDate } from './billing';
import type { Vehicle } from './cloudRegister';

export const STORAGE_KEY = '@stationnement/vehicles';
export const RECOVERY_KEY = '@stationnement/vehicles-recovery/';

export function withLocalRegisterWrite<T>(write: () => Promise<T>) {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(STORAGE_KEY, write);
  }
  return write();
}

function isVehicle(value: unknown): value is Vehicle {
  if (typeof value !== 'object' || value === null) return false;
  const vehicle = value as Record<string, unknown>;

  return (
    typeof vehicle.id === 'string' &&
    typeof vehicle.plate === 'string' &&
    typeof vehicle.entryAt === 'string' &&
    Number.isFinite(Date.parse(vehicle.entryAt)) &&
    (typeof vehicle.photoUri === 'string' || vehicle.photoUri === null) &&
    (vehicle.exitAt === null ||
      (typeof vehicle.exitAt === 'string' && Number.isFinite(Date.parse(vehicle.exitAt)))) &&
    ['keyNumber', 'aisle', 'makeModel', 'loadingNote'].every((key) =>
      vehicle[key] == null || typeof vehicle[key] === 'string') &&
    (vehicle.billing === undefined || isVisitBilling(vehicle.billing))
  );
}

function isVisitBilling(value: unknown) {
  return typeof value === 'object' && value !== null && 'services' in value &&
    Array.isArray(value.services) && value.services.every((item: unknown) => {
      if (typeof item !== 'object' || item === null) return false;
      const { id, kind, performedOn } = item as Record<string, unknown>;
      return typeof id === 'string' && typeof kind === 'string' && Object.hasOwn(SERVICES, kind) &&
        typeof performedOn === 'string' && validBillingDate(performedOn);
    });
}

export async function loadLocalRegister() {
  const stored = await AsyncStorage.getItem(STORAGE_KEY);
  if (stored === null) return { vehicles: [], recovered: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    parsed = null;
  }

  const rows: unknown[] = Array.isArray(parsed) ? parsed : [];
  const vehicles: Vehicle[] = [];
  const unreadable: unknown[] = [];
  for (const row of rows) {
    // Older records may omit the optional photo.
    const candidate =
      typeof row === 'object' && row !== null && !('photoUri' in row)
        ? { ...row, photoUri: null }
        : row;
    if (isVehicle(candidate)) {
      vehicles.push(candidate);
    } else {
      unreadable.push(row);
    }
  }

  const recovered = !Array.isArray(parsed) || unreadable.length > 0;
  if (recovered) {
    const backup = Array.isArray(parsed) ? JSON.stringify(unreadable) : stored;
    const backupKey = `${RECOVERY_KEY}${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await AsyncStorage.setItem(backupKey, backup);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(vehicles));
  }

  return { vehicles, recovered };
}
