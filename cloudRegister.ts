import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { File } from 'expo-file-system';
import { Platform } from 'react-native';

export type Vehicle = {
  id: string;
  plate: string;
  entryAt: string;
  photoUri: string | null;
  exitAt: string | null;
};

type VisitRow = {
  id: string;
  plate: string;
  entered_at: string;
  exited_at: string | null;
  expects_photo: boolean;
};

export type CloudRegister = {
  client: SupabaseClient;
  parkingId: string;
};

export type PhotoCache = Map<string, { uri: string | null; expiresAt: number }>;

const bucket = 'parko-plates';
const projectUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const parkingId = process.env.EXPO_PUBLIC_PARKING_ID;

export const cloudConfig: CloudRegister | 'invalid' | null = (() => {
  if (!projectUrl && !publishableKey && !parkingId) return null;
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
): Promise<Vehicle[]> {
  const access = await client.from('parkings').select('id').eq('id', parkingId)
    .abortSignal(signal).maybeSingle();
  if (access.error) throw new Error(access.error.message);
  if (!access.data) throw new Error('Ce compte n’a pas accès à ce parking.');

  const visits: VisitRow[] = [];
  const pageSize = 250;
  for (let offset = 0; ; offset += pageSize) {
    const page = await client.from('parking_visits')
      .select('id,plate,entered_at,exited_at,expects_photo')
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

  return [...new Map(visits.map((visit) => [visit.id, visit])).values()].map((visit) => ({
    id: visit.id,
    plate: visit.plate,
    entryAt: visit.entered_at,
    exitAt: visit.exited_at,
    photoUri: visit.expects_photo ? photoCache.get(`${parkingId}/${visit.id}`)?.uri ?? null : null,
  }));
}

export async function registerCloudEntry({ client, parkingId }: CloudRegister, vehicle: Vehicle) {
  const { error } = await client.rpc('register_parking_entry', {
    target_parking: parkingId,
    visit_id: vehicle.id,
    plate_text: vehicle.plate,
    with_photo: vehicle.photoUri !== null,
  });
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

export async function registerCloudExit({ client, parkingId }: CloudRegister, id: string) {
  const { error } = await client.rpc('register_parking_exit', { target_parking: parkingId, visit_id: id });
  if (error) throw new Error(error.message);
}
