import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { File } from 'expo-file-system';
import { Platform } from 'react-native';
import type { ServiceKind, VisitBilling, VisitService } from './billing';
import type { VehicleDetails } from './vehicleDetails';

export type Vehicle = VehicleDetails & {
  id: string;
  plate: string;
  entryAt: string;
  photoUri: string | null;
  exitAt: string | null;
  billing?: VisitBilling;
  entryTimeKnown?: boolean;
  exitTimeKnown?: boolean;
  entryAgentId?: string | null;
  exitAgentId?: string | null;
  hasPhoto?: boolean;
};

type VisitRow = {
  id: string;
  plate: string;
  entered_at: string;
  exited_at: string | null;
  expects_photo: boolean;
  key_number: string | null;
  aisle: string | null;
  make_model: string | null;
  loading_note: string | null;
  entered_time_known: boolean;
  exited_time_known: boolean;
};

type BillingRow = {
  id: string;
  visit_id: string;
  kind: ServiceKind;
  performed_on: string;
};

export type CloudRegister = {
  client: SupabaseClient;
  parkingId: string;
};

export type PhotoCache = Map<string, { uri: string | null; expiresAt: number }>;
export type ReportsSnapshot = { asOf: string; vehicles: Vehicle[] };

const bucket = 'parko-plates';
const projectUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const parkingId = process.env.EXPO_PUBLIC_PARKING_ID;
const requiresSharedRegister = process.env.EXPO_PUBLIC_REQUIRE_SHARED_REGISTER === 'true';

export const cloudConfig: CloudRegister | 'invalid' | null = (() => {
  if (!projectUrl && !publishableKey && !parkingId) return requiresSharedRegister ? 'invalid' : null;
  if (!projectUrl?.startsWith('https://') || !publishableKey?.startsWith('sb_publishable_')
    || !parkingId || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(parkingId)) {
    return 'invalid';
  }
  try {
    const client = createClient(projectUrl, publishableKey, {
      auth: { storage: AsyncStorage, detectSessionInUrl: false, persistSession: true },
    });
    return { client, parkingId: parkingId.toLowerCase() };
  } catch {
    return 'invalid';
  }
})();

export async function readCloudRegister(
  { client, parkingId }: CloudRegister,
  photoCache: PhotoCache,
  signal: AbortSignal,
) {
  const access = await client.from('parkings').select('id,dedicated_capacity').eq('id', parkingId)
    .abortSignal(signal).maybeSingle();
  if (access.error?.code === '42703') throw new Error('Applique la migration Supabase 004 des mouvements.');
  if (access.error) throw new Error(access.error.message);
  if (!access.data) throw new Error('Ce compte n’a pas accès à ce parking.');

  const visits: VisitRow[] = [];
  const pageSize = 250;
  for (let offset = 0; ; offset += pageSize) {
    const page = await client.from('parking_visits')
      .select('id,plate,entered_at,exited_at,expects_photo,key_number,aisle,make_model,loading_note,entered_time_known,exited_time_known')
      .eq('parking_id', parkingId)
      .order('entered_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + pageSize - 1)
      .abortSignal(signal);
    if (page.error) throw new Error(page.error.message);
    visits.push(...page.data);
    if (page.data.length < pageSize) break;
  }

  const now = Date.now();
  for (const [key, photo] of photoCache) {
    if (photo.expiresAt <= now) photoCache.delete(key);
  }
  const missingPhotos = visits.filter((visit) => visit.expects_photo)
    .map((visit) => `${parkingId}/${visit.id}`)
    .filter((key) => !photoCache.has(key));
  for (let offset = 0; offset < missingPhotos.length; offset += pageSize) {
    if (signal.aborted) break;
    const paths = missingPhotos.slice(offset, offset + pageSize);
    const { data } = await client.storage.from(bucket).createSignedUrls(paths, 300);
    for (const photo of data ?? []) {
      if (!photo.path) continue;
      const uri = photo.signedUrl || null;
      photoCache.set(photo.path, { uri, expiresAt: now + (uri ? 240_000 : 15_000) });
    }
  }

  const vehicles = [...new Map(visits.map((visit) => [visit.id, visit])).values()].map((visit) => ({
    id: visit.id,
    plate: visit.plate,
    entryAt: visit.entered_at,
    exitAt: visit.exited_at,
    keyNumber: visit.key_number,
    aisle: visit.aisle,
    makeModel: visit.make_model,
    loadingNote: visit.loading_note,
    entryTimeKnown: visit.entered_time_known,
    exitTimeKnown: visit.exited_time_known,
    photoUri: visit.expects_photo ? photoCache.get(`${parkingId}/${visit.id}`)?.uri ?? null : null,
  }));
  return { vehicles, dedicatedCapacity: access.data.dedicated_capacity };
}

export async function readCloudBilling({ client, parkingId }: CloudRegister, signal: AbortSignal) {
  const billing = new Map<string, VisitBilling>();
  const pageSize = 250;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await client.from('parking_visit_services')
      .select('id,visit_id,kind,performed_on,parking_visits!inner(parking_id)')
      .eq('parking_visits.parking_id', parkingId)
      .order('performed_on')
      .order('id')
      .range(offset, offset + pageSize - 1)
      .abortSignal(signal);
    if (error?.code === 'PGRST200' || error?.code === 'PGRST205' || error?.code === '42P01') {
      throw new Error('Applique les migrations Supabase de facturation du parking.');
    }
    if (error) throw new Error(error.message);
    for (const row of data as BillingRow[]) {
      const visitBilling = billing.get(row.visit_id) ?? { services: [] };
      visitBilling.services.push({ id: row.id, kind: row.kind, performedOn: row.performed_on });
      billing.set(row.visit_id, visitBilling);
    }
    if (data.length < pageSize) return billing;
  }
}

export async function readCloudReports({ client, parkingId }: CloudRegister, signal: AbortSignal) {
  const { data, error } = await client.rpc('read_parking_reports', { target_parking: parkingId })
    .abortSignal(signal);
  if (error?.code === 'PGRST202' || error?.code === '42883') {
    throw new Error('Applique la migration Supabase 005 pour activer les rapports partagés.');
  }
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Ce compte n’a pas accès aux rapports de ce parking.');
  return data as ReportsSnapshot;
}

export async function saveCloudService(
  { client }: CloudRegister, visitId: string, service: VisitService, remove: boolean,
) {
  const table = client.from('parking_visit_services');
  const { error } = remove
    ? await table.delete().eq('visit_id', visitId).eq('id', service.id)
    : await table.upsert({
      id: service.id, visit_id: visitId, kind: service.kind, performed_on: service.performedOn,
      time_zone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
    }, { onConflict: 'id', ignoreDuplicates: true });
  if (error?.code === 'PGRST204' || error?.code === '42703') {
    throw new Error('Applique la migration Supabase 009 pour enregistrer les prestations en heure locale.');
  }
  if (error) throw new Error(error.message);
}

export async function registerCloudEntry({ client, parkingId }: CloudRegister, vehicle: Vehicle) {
  const { error } = await client.rpc('receive_parking_vehicle', {
    target_parking: parkingId,
    visit_id: vehicle.id,
    plate_text: vehicle.plate,
    with_photo: vehicle.photoUri !== null,
    key_text: vehicle.keyNumber,
    aisle_text: vehicle.aisle,
    model_text: vehicle.makeModel ?? null,
    device_at: vehicle.entryAt,
  });
  if (error?.code === 'PGRST202') {
    throw new Error('Applique la migration Supabase 010 pour partager les entrées avec l’heure de l’appareil.');
  }
  if (error?.code === '23505' && error.message.includes('parking_visits_active_key')) {
    throw new Error('Ce numéro de clé est déjà affecté à un véhicule présent.');
  }
  if (error?.code === '23505') throw new Error('Cette plaque est déjà enregistrée dans le parking.');
  if (error) throw new Error(error.message);

  if (vehicle.photoUri) {
    try {
      const image = Platform.OS === 'web' ? await fetch(vehicle.photoUri) : new File(vehicle.photoUri);
      const contentType = image instanceof File ? image.type : image.headers.get('Content-Type');
      const upload = await client.storage.from(bucket).upload(
        `${parkingId}/${vehicle.id}`,
        await image.arrayBuffer(),
        { contentType: contentType || 'image/jpeg' },
      );
      if (upload.error) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export async function saveCloudVisitDetails({ client, parkingId }: CloudRegister, id: string, details: VehicleDetails) {
  const { error } = await client.rpc('update_parking_visit_details', {
    target_parking: parkingId, visit_id: id,
    key_text: details.keyNumber, aisle_text: details.aisle,
    model_text: details.makeModel ?? null, note_text: details.loadingNote ?? null,
  });
  if (error?.code === '23505') throw new Error('Ce numéro de clé est déjà affecté à un véhicule présent.');
  if (error) throw new Error(error.message);
}
