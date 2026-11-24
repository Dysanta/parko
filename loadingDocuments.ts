import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CloudRegister, Vehicle } from './cloudRegister';
import {
  formatReleaseNumber, indexVisitsByPlate, matchLoadingNote, releaseConfirmationDate, sameLoadingNote,
  type LoadingNote, type ReleaseDocument,
} from './loadingNote';
import { loadLocalRegister, withLocalRegisterWrite } from './localRegister';

const documentKey = '@stationnement/exit-documents';
const reservationVersionKey = '@stationnement/exit-reservations-v1';
const releasePageSize = 25;
let releaseWrite = Promise.resolve();

export function withLocalReleaseWrite<T>(write: () => Promise<T>) {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(documentKey, write);
  }
  const result = releaseWrite.then(write);
  releaseWrite = result.then(() => {}, () => {});
  return result;
}

async function localDocuments() {
  const stored = await AsyncStorage.getItem(documentKey);
  return stored ? JSON.parse(stored) as ReleaseDocument[] : [];
}

async function migrateLocalDocuments() {
  const documents = await localDocuments();
  if (await AsyncStorage.getItem(reservationVersionKey)) return documents;

  const { vehicles } = await withLocalRegisterWrite(loadLocalRegister);
  const visits = new Map(vehicles.map((visit) => [visit.id, visit]));
  const reserved = new Set<string>();
  const cancelledAt = new Date().toISOString();
  const migrated = [...documents].sort((left, right) => left.number - right.number).map((document) => {
    if (document.cancelledAt) return document;
    const confirmedAt = releaseConfirmationDate(document, visits);
    if (confirmedAt) return { ...document, confirmedAt };
    if (document.rows.some(({ visitId }) => {
      const visit = visits.get(visitId);
      return !visit || reserved.has(visitId) ||
        ((!!visit.exitAt || !!visit.loadingNote) && visit.loadingNote !== document.reference);
    })) {
      return {
        ...document, cancelledAt,
        cancellationReason: 'Véhicule déjà affecté à un autre bon ou séjour indisponible.',
      };
    }
    for (const { visitId } of document.rows) reserved.add(visitId);
    return document;
  });
  if (migrated.length) await AsyncStorage.setItem(documentKey, JSON.stringify(migrated));
  await AsyncStorage.setItem(reservationVersionKey, '1');
  return migrated;
}

function checkReleaseRead(error: { code: string; message: string } | null) {
  if (error?.code === 'PGRST205' || error?.code === '42P01') {
    throw new Error('Applique la migration Supabase 006 pour accéder aux bons partagés.');
  }
  if (error?.code === '42703') {
    throw new Error('Applique la migration Supabase 010 pour accéder aux bons par référence.');
  }
  if (error) throw new Error(error.message);
}

export async function listReleaseDocuments(cloud?: CloudRegister, before?: number) {
  let documents: ReleaseDocument[];
  if (cloud) {
    let query = cloud.client.from('parking_exit_documents').select('document')
      .eq('parking_id', cloud.parkingId).order('document_number', { ascending: false })
      .limit(releasePageSize + 1);
    if (before !== undefined) query = query.lt('document_number', before);
    const { data, error } = await query;
    checkReleaseRead(error);
    documents = (data ?? []).map(({ document }) => document as ReleaseDocument);
  } else {
    documents = (await withLocalReleaseWrite(migrateLocalDocuments)).filter(({ number }) => before === undefined || number < before)
      .sort((left, right) => right.number - left.number);
  }
  return {
    documents: documents.slice(0, releasePageSize),
    next: documents.length > releasePageSize ? documents[releasePageSize - 1].number : undefined,
  };
}

export async function readReleaseDocument(reference: string | number, cloud?: CloudRegister) {
  const byNumber = typeof reference === 'number';
  if (!cloud) return (await withLocalReleaseWrite(migrateLocalDocuments)).find((document) => byNumber ? document.number === reference
    : document.reference === reference && !document.cancelledAt);
  const query = cloud.client.from('parking_exit_documents').select('document')
    .eq('parking_id', cloud.parkingId);
  const { data, error } = await (byNumber ? query.eq('document_number', reference)
    : query.eq('reference', reference).is('cancelled_at', null)).maybeSingle();
  checkReleaseRead(error);
  return data ? data.document as ReleaseDocument : undefined;
}

export async function confirmCloudRelease(number: number, cloud: CloudRegister): Promise<string> {
  const { data, error } = await cloud.client.rpc('confirm_parking_exit_document', {
    target_parking: cloud.parkingId, release_number: number,
    device_at: new Date().toISOString(),
  });
  if (error?.code === 'PGRST202') {
    throw new Error('Applique la migration Supabase 010 pour valider les enlèvements.');
  }
  if (error) throw new Error(error.message);
  return data;
}

export async function withLocalRelease(number: number, operation: (document: ReleaseDocument, documents: ReleaseDocument[]) => Promise<void>) {
  return withLocalReleaseWrite(async () => {
    const documents = await migrateLocalDocuments();
    const document = documents.find((item) => item.number === number);
    if (!document || document.cancelledAt) throw new Error('Ce bon de sortie est introuvable ou annulé.');
    await operation(document, documents);
  });
}

export async function cancelReleaseDocument(document: ReleaseDocument, cloud?: CloudRegister) {
  if (cloud) {
    const { data, error } = await cloud.client.rpc('cancel_parking_exit_document', {
      target_parking: cloud.parkingId, release_number: document.number,
    });
    if (error?.code === 'PGRST202') throw new Error('Applique la migration Supabase 010 pour annuler les bons.');
    if (error) throw new Error(error.message);
    return data as ReleaseDocument;
  }
  let cancelled = document;
  await withLocalRelease(document.number, async (saved, documents) => {
    const { vehicles } = await withLocalRegisterWrite(loadLocalRegister);
    if (releaseConfirmationDate(saved, new Map(vehicles.map((visit) => [visit.id, visit])))) {
      throw new Error('Cet enlèvement est déjà validé.');
    }
    cancelled = { ...saved, cancelledAt: new Date().toISOString() };
    await AsyncStorage.setItem(documentKey, JSON.stringify(documents.map((item) =>
      item.number === cancelled.number ? cancelled : item,
    )));
  });
  return cancelled;
}

export async function assertLocalVisitNotReserved(visitId: string) {
  const reservation = (await localDocuments()).find((document) => !document.cancelledAt &&
    document.rows.some((row) => row.visitId === visitId));
  if (reservation) throw new Error(`Annule le bon de sortie n° ${formatReleaseNumber(reservation.number)} avant de changer la clé, l’allée ou le bon associé.`);
}

export function applyLocalRelease(document: ReleaseDocument, registry: Vehicle[], now: number, documents: ReleaseDocument[]) {
  const ids = new Set(document.rows.map(({ visitId }) => visitId));
  const visits = registry.filter((visit) => ids.has(visit.id));
  if (!ids.size || ids.size !== document.rows.length || visits.length !== ids.size ||
    visits.some((visit) => (visit.exitAt || visit.loadingNote) && visit.loadingNote !== document.reference)) {
    throw new Error('Un véhicule du bon est introuvable, déjà sorti ou associé à un autre bon.');
  }
  if (visits.every((visit) => visit.exitAt)) return registry;
  const earlier = documents.find((item) => !item.cancelledAt && item.number < document.number &&
    item.rows.some((row) => ids.has(row.visitId)));
  if (earlier) throw new Error(`Un véhicule est réservé par le bon n° ${formatReleaseNumber(earlier.number)}.`);
  if (visits.some((visit) => !visit.exitAt && Date.parse(visit.entryAt) > now)) {
    throw new Error('L’heure de l’appareil est antérieure à une entrée. Vérifie l’horloge.');
  }
  return registry.map((visit) => ids.has(visit.id) && !visit.exitAt ? {
    ...visit,
    exitAt: new Date(now).toISOString(),
    exitTimeKnown: true,
    loadingNote: document.reference,
  } : visit);
}

export async function issueReleaseDocument(note: LoadingNote, cloud?: CloudRegister) {
  if (cloud) {
    const { data, error } = await cloud.client.rpc('issue_parking_exit_document', {
      target_parking: cloud.parkingId, loading: note,
    });
    if (error?.code === 'PGRST202') {
      throw new Error('Applique les migrations Supabase 006 et 007 pour enregistrer les bons partagés.');
    }
    if (error?.message === 'Le bon de chargement transmis est incomplet.') {
      throw new Error('Vérifie les champs du bon et que la migration Supabase 007 est appliquée.');
    }
    if (error) throw new Error(error.message);
    return data as ReleaseDocument;
  }
  return withLocalReleaseWrite(async () => {
    const { vehicles } = await withLocalRegisterWrite(loadLocalRegister);
    return issueLocalRelease(note, vehicles);
  });
}

async function issueLocalRelease(note: LoadingNote, registry: Vehicle[]) {
  const documents = await migrateLocalDocuments();
  const previous = documents.find((document) => document.reference === note.reference && !document.cancelledAt);
  if (previous) {
    if (!sameLoadingNote(note, previous)) throw new Error('Un document différent existe pour ce numéro de chargement.');
    if (previous.pickupLocation) return previous;
    const completed = { ...previous, pickupLocation: note.pickupLocation };
    await AsyncStorage.setItem(documentKey, JSON.stringify(documents.map((item) =>
      item.number === previous.number ? completed : item,
    )));
    return completed;
  }
  const rows = matchLoadingNote(note, indexVisitsByPlate(registry)).flatMap((match) => match.row ? [match.row] : []);
  if (rows.length !== note.vehicles.length) throw new Error('Complète le rapprochement avec le registre.');
  const ids = new Set(rows.map((row) => row.visitId));
  const reservation = documents.find((document) => !document.cancelledAt &&
    document.rows.some((row) => ids.has(row.visitId)));
  if (reservation) {
    const plate = reservation.rows.find((row) => ids.has(row.visitId))?.plate;
    throw new Error(`Le véhicule ${plate} est déjà réservé par le bon de sortie n° ${formatReleaseNumber(reservation.number)}.`);
  }
  const { reference, lot, pickupDate, pickupLocation, transport } = note;
  const document = {
    reference, lot, pickupDate, pickupLocation, transport, rows,
    number: documents.reduce((max, item) => Math.max(max, item.number), 0) + 1,
  };
  await AsyncStorage.setItem(documentKey, JSON.stringify([...documents, document]));
  return document;
}
