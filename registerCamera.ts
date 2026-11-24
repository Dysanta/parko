import AsyncStorage from '@react-native-async-storage/async-storage';
import { File, Paths } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { recognizeText } from 'expo-ocr-kit';
import { Platform } from 'react-native';
import { detailsForm } from './vehicleDetails';

export const CAMERA_DRAFT_KEY = '@stationnement/camera-draft';

function extractPlate(text: string) {
  const normalizedText = text
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const matches = normalizedText.match(/\b[A-Z]{2}[-\s]?\d{3}[-\s]?[A-Z]{2}\b|\b\d{4}[-\s]?[A-Z]{2}[-\s]?\d{2}\b/g);
  const match = matches?.[0];
  return match ? match.replace(/[^A-Z0-9]/g, '') : null;
}

export async function preparePhoto(asset: ImagePicker.ImagePickerAsset) {
  if (Platform.OS === 'web') {
    try {
      const image = new window.Image();
      image.src = asset.uri;
      await image.decode();
      const scale = Math.min(1, 1024 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Le navigateur ne peut pas traiter cette photo.');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.75);
    } finally {
      URL.revokeObjectURL(asset.uri);
    }
  }

  // The camera result is temporary. Keep it there until the entry is saved.
  return asset.uri;
}

export function discardTemporaryPhoto(photoUri: string | null) {
  if (!photoUri || Platform.OS === 'web') return;

  try {
    const cacheUri = Paths.cache.uri.replace(/\/$/, '');
    if (!photoUri.startsWith(`${cacheUri}/ImagePicker/`)) return;
    const photo = new File(photoUri);
    if (photo.exists) photo.delete();
  } catch {
    // The device can clear cached camera files even if immediate deletion fails.
  }
}

export async function readPlateFromPhoto(photoUri: string) {
  const result = await recognizeText(photoUri);
  return extractPlate(result.text);
}

export async function recoverCameraDraft() {
  const draft = await AsyncStorage.getItem(CAMERA_DRAFT_KEY);
  const result = await ImagePicker.getPendingResultAsync();
  if (draft === null) return null;
  await AsyncStorage.removeItem(CAMERA_DRAFT_KEY);
  if (result && 'code' in result) throw new Error(result.message);
  const asset = result?.assets?.[0];
  if (!asset) return null;
  const saved = draft === 'pending-photo' ? '' : JSON.parse(draft);
  return {
    previousPlate: typeof saved === 'string' ? saved : saved.plate,
    details: typeof saved === 'string' ? detailsForm() : detailsForm(saved.details),
    photoUri: await preparePhoto(asset),
  };
}
