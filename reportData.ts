import { billingDate, formatEuros, SERVICES } from './billing';
import type { Vehicle } from './cloudRegister';
import { normalizeReference } from './vehicleDetails';

export const VEHICLE_REPORT_FIELDS = [
  { key: 'plate', label: 'Immatriculation' },
  { key: 'makeModel', label: 'Marque / modèle' },
  { key: 'keyNumber', label: 'N° de clé' },
  { key: 'aisle', label: 'Allée / zone' },
  { key: 'entry', label: 'Entrée (heure locale)' },
  { key: 'exit', label: 'Sortie (heure locale)' },
  { key: 'status', label: 'Statut' },
  { key: 'duration', label: 'Durée écoulée' },
  { key: 'loadingNote', label: 'N° bon de chargement' },
  { key: 'services', label: 'Prestations réalisées' },
  { key: 'photo', label: 'Photo au dossier' },
  { key: 'entryAgent', label: 'ID agent entrée' },
  { key: 'exitAgent', label: 'ID agent sortie' },
  { key: 'id', label: 'ID séjour' },
] as const;

export const VEHICLE_COLUMNS = VEHICLE_REPORT_FIELDS.map(({ label }) => label);

export type ReportStatus = 'all' | 'active' | 'history';

export function filterVehicleReport(vehicles: Vehicle[], start: string, end: string, status: ReportStatus, search: string) {
  const query = normalizeReference(search);
  const plateQuery = query.replace(/[\s.\p{Pd}]+/gu, '');
  return vehicles.filter((visit) => {
    if (status === 'active' && visit.exitAt || status === 'history' && !visit.exitAt) return false;
    if (start && visit.exitAt && billingDate(visit.exitAt, visit.exitTimeKnown) < start) return false;
    if (end && billingDate(visit.entryAt, visit.entryTimeKnown) > end) return false;
    return !query || (!!plateQuery && visit.plate.includes(plateQuery))
      || [visit.keyNumber, visit.aisle, visit.loadingNote, visit.makeModel].some(
        (value) => value && normalizeReference(value).includes(query),
      );
  });
}

export function reportDateTime(value: string, timeKnown = true) {
  const date = billingDate(value, timeKnown);
  if (!timeKnown) return date;
  const time = new Date(value).toLocaleTimeString('fr-FR', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  return `${date} ${time}`;
}

export function vehicleReportRow(visit: Vehicle, asOf: number) {
  const duration = Math.floor(Math.max(0, (visit.exitAt ? Date.parse(visit.exitAt) : asOf) - Date.parse(visit.entryAt)) / 60_000);
  const durationText = visit.entryTimeKnown === false || (visit.exitAt && visit.exitTimeKnown === false)
    ? '' : `${Math.floor(duration / 60)} h ${duration % 60} min`;
  return {
    plate: visit.plate,
    makeModel: visit.makeModel ?? '',
    keyNumber: visit.keyNumber ?? '',
    aisle: visit.aisle ?? '',
    entry: reportDateTime(visit.entryAt, visit.entryTimeKnown),
    exit: visit.exitAt ? reportDateTime(visit.exitAt, visit.exitTimeKnown) : '',
    status: visit.exitAt ? 'Sorti' : 'Présent',
    duration: durationText,
    loadingNote: visit.loadingNote ?? '',
    services: (visit.billing?.services ?? []).map(({ kind, performedOn }) =>
      `${performedOn} · ${SERVICES[kind].label} · ${formatEuros(SERVICES[kind].cents)} HT`,
    ).join(' / '),
    photo: (visit.hasPhoto ?? !!visit.photoUri) ? 'Oui' : 'Non',
    entryAgent: visit.entryAgentId ?? '',
    exitAgent: visit.exitAgentId ?? '',
    id: visit.id,
  };
}

export function serializeReportCsv(columns: readonly string[], rows: (string | number)[][]) {
  return [columns, ...rows].map((row) => row.map((value) => {
    const text = String(value);
    // Neutralize imported spreadsheet formulas before opening the CSV in Excel.
    const safe = typeof value === 'string' && /^(?:\s*[=+@-]|[\t\r\n])/.test(text) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  }).join(';')).join('\r\n');
}
