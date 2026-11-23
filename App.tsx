import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Session } from '@supabase/supabase-js';
import { randomUUID } from 'expo-crypto';
import { File, Paths } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { recognizeText } from 'expo-ocr-kit';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  cloudConfig,
  readCloudRegister,
  registerCloudEntry,
  registerCloudExit,
  type CloudRegister,
  type PhotoCache,
  type Vehicle,
} from './cloudRegister';

type VehicleFilter = 'active' | 'history';

const STORAGE_KEY = '@stationnement/vehicles';
const RECOVERY_KEY = '@stationnement/vehicles-recovery/';
const CAMERA_DRAFT_KEY = '@stationnement/camera-draft';
const INITIAL_TIME = Date.now();
const COLORS = {
  background: '#F3F4EE',
  card: '#FFFFFF',
  ink: '#17221B',
  muted: '#7B837C',
  green: '#174B35',
  greenLight: '#E1F1E5',
  lime: '#D5F66A',
  border: '#E8EBE4',
  red: '#A64235',
};

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
      (typeof vehicle.exitAt === 'string' && Number.isFinite(Date.parse(vehicle.exitAt))))
  );
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Une erreur inconnue est survenue.';
}

function normalizePlate(value: string) {
  return value.normalize('NFKC').toUpperCase().replace(/[\s.\p{Pd}]+/gu, '');
}

async function loadLocalRegister() {
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

function extractPlate(text: string) {
  const normalizedText = text
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const matches = normalizedText.match(/\b[A-Z]{2}[-\s]?\d{3}[-\s]?[A-Z]{2}\b|\b\d{4}[-\s]?[A-Z]{2}[-\s]?\d{2}\b/g);
  const match = matches?.[0];
  return match ? match.replace(/[^A-Z0-9]/g, '') : null;
}

function showAlert(title: string, message: string) {
  if (Platform.OS === 'web') {
    window.alert(`${title}\n\n${message}`);
    return;
  }
  Alert.alert(title, message);
}

async function preparePhoto(asset: ImagePicker.ImagePickerAsset) {
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

function discardTemporaryPhoto(photoUri: string | null) {
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

async function readPlateFromPhoto(photoUri: string) {
  const result = await recognizeText(photoUri);
  return extractPlate(result.text);
}

async function recoverCameraDraft() {
  const draft = await AsyncStorage.getItem(CAMERA_DRAFT_KEY);
  const result = await ImagePicker.getPendingResultAsync();
  if (draft === null) return null;
  await AsyncStorage.removeItem(CAMERA_DRAFT_KEY);
  if (result && 'code' in result) throw new Error(result.message);
  const asset = result?.assets?.[0];
  if (!asset) return null;
  const previousPlate: string = draft === 'pending-photo' ? '' : JSON.parse(draft);
  return { previousPlate, photoUri: await preparePhoto(asset) };
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return `${date.toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: 'short',
  })} · ${date.toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

function formatDuration(startAt: string, endAt: string) {
  const totalMinutes = Math.max(
    0,
    Math.floor((new Date(endAt).getTime() - new Date(startAt).getTime()) / 60_000),
  );
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  return `${days} j · ${hours} h · ${minutes} min`;
}

export default function App() {
  if (cloudConfig === 'invalid') {
    return (
      <SafeAreaView style={styles.safeArea}>
        <Text accessibilityRole="alert" style={styles.storageError}>
          La configuration du registre partagé est incomplète ou invalide.
        </Text>
      </SafeAreaView>
    );
  }
  return cloudConfig ? <CloudSignIn cloud={cloudConfig} /> : <ParkingScreen />;
}

function CloudSignIn({ cloud }: { cloud: CloudRegister }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { auth } = cloud.client;

  useEffect(() => {
    const { data: { subscription } } = auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });
    const appStateSubscription = Platform.OS === 'web' ? null : AppState.addEventListener(
      'change',
      (state) => {
        if (state === 'active') void auth.startAutoRefresh();
        else void auth.stopAutoRefresh();
      },
    );
    if (Platform.OS !== 'web' && AppState.currentState === 'active') void auth.startAutoRefresh();
    return () => {
      subscription.unsubscribe();
      appStateSubscription?.remove();
      if (Platform.OS !== 'web') void auth.stopAutoRefresh();
    };
  }, [auth]);

  async function signIn() {
    if (busy || !email.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      const result = await auth.signInWithPassword({ email: email.trim(), password });
      if (result.error) throw result.error;
      setPassword('');
    } catch (problem) {
      setError(getErrorMessage(problem));
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    try {
      const result = await auth.signOut({ scope: 'local' });
      if (result.error) throw result.error;
    } catch (problem) {
      showAlert('Déconnexion impossible', getErrorMessage(problem));
    }
  }

  if (session) {
    return <ParkingScreen key={session.user.id} cloud={cloud} onSignOut={() => void signOut()} />;
  }
  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.signIn} keyboardShouldPersistTaps="handled">
          <Text style={styles.brand}>PARKO</Text>
          {session === undefined ? <ActivityIndicator color={COLORS.green} /> : (
            <>
              <Text style={styles.modalTitle}>Connexion agent</Text>
              <TextInput
                accessibilityLabel="Adresse e-mail"
                autoCapitalize="none"
                autoComplete="email"
                keyboardType="email-address"
                onChangeText={setEmail}
                placeholder="Adresse e-mail"
                placeholderTextColor={COLORS.muted}
                style={styles.plateResult}
                value={email}
              />
              <TextInput
                accessibilityLabel="Mot de passe"
                autoComplete="current-password"
                onChangeText={setPassword}
                onSubmitEditing={() => void signIn()}
                placeholder="Mot de passe"
                placeholderTextColor={COLORS.muted}
                secureTextEntry
                style={styles.plateResult}
                value={password}
              />
              {error && <Text accessibilityRole="alert" style={styles.storageError}>{error}</Text>}
              <Pressable
                accessibilityRole="button"
                disabled={busy || !email.trim() || !password}
                onPress={() => void signIn()}
                style={[styles.submitButton, (busy || !email.trim() || !password) && styles.pressed]}
              >
                <Text style={styles.submitButtonText}>{busy ? 'Connexion…' : 'Se connecter'}</Text>
              </Pressable>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function ParkingScreen({ cloud, onSignOut }: { cloud?: CloudRegister; onSignOut?: () => void }) {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [filter, setFilter] = useState<VehicleFilter>('active');
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [hasRecoveryBackup, setHasRecoveryBackup] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isAddingVehicle, setIsAddingVehicle] = useState(false);
  const [plate, setPlate] = useState('');
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [ocrStatus, setOcrStatus] = useState<'idle' | 'reading' | 'success' | 'error'>('idle');
  const [isSaving, setIsSaving] = useState(false);
  const [isTakingPhoto, setIsTakingPhoto] = useState(false);
  const [isRecoveringCamera, setIsRecoveringCamera] = useState(Platform.OS === 'android');
  const [now, setNow] = useState(INITIAL_TIME);
  const storedVehiclesRef = useRef<Vehicle[] | null>(null);
  const registerLoad = useRef<Promise<Awaited<ReturnType<typeof loadLocalRegister>>> | null>(null);
  const photoCache = useRef<PhotoCache>(new Map());
  const pendingWrite = useRef(Promise.resolve());
  const savingEntry = useRef(false);
  const entryRequest = useRef<{ plate: string; photoUri: string | null; id: string } | null>(null);
  const takingPhoto = useRef(false);
  const cameraRecovery = useRef<ReturnType<typeof recoverCameraDraft> | null>(null);

  useEffect(() => {
    if (cloud) return;
    let isMounted = true;

    async function loadVehicles() {
      try {
        registerLoad.current ??= loadLocalRegister();
        const { vehicles: loadedVehicles, recovered } = await registerLoad.current;

        if (!isMounted) return;
        storedVehiclesRef.current = loadedVehicles;
        setVehicles(loadedVehicles);
        setLoadError(null);
        setHasRecoveryBackup(recovered);
      } catch (error) {
        if (isMounted) setLoadError(getErrorMessage(error));
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }

    void loadVehicles();
    return () => {
      isMounted = false;
    };
  }, [cloud, loadAttempt]);

  useEffect(() => {
    if (!cloud) return;
    const cloudRegister = cloud;
    const controller = new AbortController();
    const cache = photoCache.current;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function refresh() {
      try {
        const loaded = await readCloudRegister(cloudRegister, cache, controller.signal);
        if (controller.signal.aborted) return;
        setVehicles(loaded);
        setLoadError(null);
      } catch (problem) {
        if (controller.signal.aborted) return;
        setVehicles([]);
        setLoadError(getErrorMessage(problem));
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
          timer = setTimeout(() => void refresh(), 15_000);
        }
      }
    }

    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [cloud, loadAttempt]);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    let isMounted = true;
    cameraRecovery.current ??= recoverCameraDraft();
    void cameraRecovery.current
      .then(async (draft) => {
        if (!isMounted || !draft) return;
        const detected = await readPlateFromPhoto(draft.photoUri).catch(() => null);
        if (!isMounted) return;
        setPlate(draft.previousPlate || detected || '');
        setPhotoUri(draft.photoUri);
        setOcrStatus(detected ? 'success' : 'error');
        setIsAddingVehicle(true);
      })
      .catch((error: unknown) => {
        if (isMounted) showAlert('Récupération de la photo impossible', getErrorMessage(error));
      })
      .finally(() => {
        if (isMounted) setIsRecoveringCamera(false);
      });
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const activeVehicles = useMemo(
    () => vehicles.filter((vehicle) => vehicle.exitAt === null),
    [vehicles],
  );
  const historyVehicles = useMemo(
    () => vehicles.filter((vehicle) => vehicle.exitAt !== null),
    [vehicles],
  );
  const visibleVehicles = filter === 'active' ? activeVehicles : historyVehicles;
  const canEdit = !isLoading && !isRecoveringCamera && loadError === null;
  const isEntryBusy = isSaving || isTakingPhoto;
  const normalizedPlate = normalizePlate(plate);
  const isValidPlate = /^[\p{L}\p{N}]{1,32}$/u.test(normalizedPlate);
  const todayEntries = vehicles.filter(
    (vehicle) => new Date(vehicle.entryAt).toDateString() === new Date(now).toDateString(),
  ).length;

  function closeAddModal() {
    discardTemporaryPhoto(photoUri);
    entryRequest.current = null;
    setIsAddingVehicle(false);
    setPlate('');
    setPhotoUri(null);
    setOcrStatus('idle');
  }

  function requestCloseAddModal() {
    if (!savingEntry.current && !takingPhoto.current) closeAddModal();
  }

  function retryLoad() {
    registerLoad.current = null;
    setIsLoading(true);
    setLoadAttempt((attempt) => attempt + 1);
  }

  async function exportRegister() {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const keys = (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(RECOVERY_KEY));
      const backups = await AsyncStorage.multiGet(keys);
      const data = JSON.stringify({
        vehicles: storedVehiclesRef.current?.map((vehicle) => ({ ...vehicle, photoUri: null })),
        recovery: backups.map(([, raw]) => raw),
        unreadableRegister: storedVehiclesRef.current === null
          ? await AsyncStorage.getItem(STORAGE_KEY)
          : undefined,
      }, null, 2);

      if (Platform.OS === 'web') {
        const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = 'parko-registre.json';
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1_000);
      } else {
        await Share.share({ title: 'Registre Parko', message: data });
      }
    } catch (error) {
      showAlert('Export impossible', getErrorMessage(error));
    } finally {
      setIsExporting(false);
    }
  }

  function updateVehicles(update: (current: Vehicle[]) => Vehicle[] | Promise<Vehicle[]>) {
    const write = pendingWrite.current.then(async () => {
      const current = storedVehiclesRef.current;
      if (current === null) throw new Error('Le registre est en lecture seule.');
      const updated = await update(current);
      if (updated === current) return;
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      storedVehiclesRef.current = updated;
      setVehicles(updated);
    });
    pendingWrite.current = write.catch(() => {});
    return write;
  }

  async function takePlatePhoto() {
    if (takingPhoto.current || savingEntry.current) return;
    takingPhoto.current = true;
    setIsTakingPhoto(true);
    let hasAndroidDraft = false;
    try {
      if (Platform.OS !== 'web') {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
          showAlert(
            'Accès à la caméra requis',
            'Autorisez l’accès à la caméra dans les réglages pour photographier la plaque.',
          );
          return;
        }
        if (Platform.OS === 'android') {
          await AsyncStorage.setItem(CAMERA_DRAFT_KEY, JSON.stringify(plate));
          hasAndroidDraft = true;
        }
      }

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [4, 3],
        quality: 0.75,
      });

      if (!result.canceled) {
        const asset = result.assets[0];
        if (!asset) throw new Error('La photo prise n’a pas pu être lue.');

        const preparedPhotoUri = await preparePhoto(asset);
        if (photoUri !== preparedPhotoUri) discardTemporaryPhoto(photoUri);
        setPhotoUri(preparedPhotoUri);
        if (Platform.OS !== 'web') {
          setOcrStatus('reading');
          const detected = await readPlateFromPhoto(preparedPhotoUri).catch(() => null);
          if (detected) setPlate((current) => normalizePlate(current) ? current : detected);
          setOcrStatus(detected ? 'success' : 'error');
        }
      }
    } catch (error) {
      showAlert('Photo indisponible', getErrorMessage(error));
    } finally {
      if (hasAndroidDraft) {
        try {
          await AsyncStorage.removeItem(CAMERA_DRAFT_KEY);
        } catch (error) {
          showAlert('Nettoyage du brouillon impossible', getErrorMessage(error));
        }
      }
      takingPhoto.current = false;
      setIsTakingPhoto(false);
    }
  }

  async function saveVehicleEntry() {
    if (!canEdit || savingEntry.current || takingPhoto.current) return;
    if (!isValidPlate) {
      showAlert('Plaque invalide', 'Saisissez un numéro de plaque avec des lettres ou des chiffres.');
      return;
    }

    const entryAt = new Date();
    const vehicle: Vehicle = {
      id: `${entryAt.getTime()}-${normalizedPlate}`,
      plate: normalizedPlate,
      entryAt: entryAt.toISOString(),
      photoUri,
      exitAt: null,
    };

    savingEntry.current = true;
    setIsSaving(true);
    let storedPhoto: File | undefined;
    try {
      if (cloud) {
        const previous = entryRequest.current;
        if (previous?.plate === normalizedPlate && previous.photoUri === photoUri) {
          vehicle.id = previous.id;
        } else {
          vehicle.id = randomUUID();
          entryRequest.current = { plate: normalizedPlate, photoUri, id: vehicle.id };
        }
        const photoSaved = await registerCloudEntry(cloud, vehicle);
        setLoadAttempt((attempt) => attempt + 1);
        setFilter('active');
        closeAddModal();
        if (!photoSaved) {
          showAlert('Entrée enregistrée', 'La photo n’a pas pu être envoyée. La plaque est dans le registre.');
        }
        return;
      }
      await updateVehicles(async (current) => {
        if (current.some((item) => item.exitAt === null && normalizePlate(item.plate) === normalizedPlate)) {
          throw new Error('Cette plaque est déjà enregistrée dans le parking.');
        }
        if (photoUri && Platform.OS !== 'web') {
          const source = new File(photoUri);
          const extension = /^\.[a-z0-9]+$/i.test(source.extension) ? source.extension : '.jpg';
          const filename = `plate-${entryAt.getTime()}-${Math.random().toString(36).slice(2)}${extension}`;
          storedPhoto = new File(Paths.document, filename);
          await source.copy(storedPhoto);
          vehicle.photoUri = storedPhoto.uri;
        }
        return [vehicle, ...current];
      });
      setFilter('active');
      closeAddModal();
    } catch (error) {
      try {
        if (storedPhoto?.exists) storedPhoto.delete();
      } catch {
        // Preserve the original write error if a temporary copy cannot be removed.
      }
      showAlert('Enregistrement impossible', getErrorMessage(error));
    } finally {
      savingEntry.current = false;
      setIsSaving(false);
    }
  }

  function confirmVehicleExit(vehicle: Vehicle) {
    if (!canEdit) return;
    const message = `Confirmer la sortie du véhicule ${vehicle.plate} ?`;
    if (Platform.OS === 'web') {
      if (window.confirm(message)) void saveVehicleExit(vehicle);
      return;
    }
    Alert.alert(
      'Enregistrer la sortie',
      message,
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Confirmer la sortie',
          onPress: () => {
            void saveVehicleExit(vehicle);
          },
        },
      ],
    );
  }

  async function saveVehicleExit(vehicle: Vehicle) {
    const exitAt = new Date().toISOString();
    try {
      if (cloud) {
        await registerCloudExit(cloud, vehicle.id);
        setLoadAttempt((attempt) => attempt + 1);
        return;
      }
      await updateVehicles((current) => {
        if (!current.some((item) => item.id === vehicle.id && item.exitAt === null)) return current;
        return current.map((item) =>
          item.id === vehicle.id && item.exitAt === null ? { ...item, exitAt } : item,
        );
      });
    } catch (error) {
      showAlert('Sortie impossible à enregistrer', getErrorMessage(error));
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <View style={styles.screen}>
        <View style={styles.header}>
          <View>
            <Text style={styles.brand}>PARKO</Text>
            <Text style={styles.headerSubtitle}>Gestion du parking</Text>
          </View>
          {onSignOut ? (
            <Pressable accessibilityRole="button" onPress={onSignOut} disabled={isEntryBusy}>
              <Text style={styles.registerAction}>Se déconnecter</Text>
            </Pressable>
          ) : (
            <View style={styles.headerBadge}>
              <Text style={styles.headerBadgeText}>P</Text>
            </View>
          )}
        </View>

        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.dateLabel}>
            {new Date(now).toLocaleDateString('fr-FR', {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
            })}
          </Text>

          <View style={styles.summaryCard}>
            <View style={styles.summaryTopRow}>
              <View style={styles.liveLabel}>
                <View style={styles.liveDot} />
                <Text style={styles.liveText}>EN DIRECT</Text>
              </View>
              <Text style={styles.summaryCaption}>Véhicules présents</Text>
            </View>
            <View style={styles.summaryBottomRow}>
              <Text style={styles.vehicleCount}>{String(activeVehicles.length).padStart(2, '0')}</Text>
              <View style={styles.summaryDivider} />
              <View style={styles.summaryStats}>
                <Text style={styles.summaryStatNumber}>{todayEntries}</Text>
                <Text style={styles.summaryStatLabel}>entrées aujourd’hui</Text>
              </View>
            </View>
            <View style={styles.summaryAccent} />
          </View>

          <View style={styles.sectionHeading}>
            <View>
              <Text style={styles.sectionTitle}>Véhicules</Text>
              <Text style={styles.sectionSubtitle}>Suivez les mouvements du parking</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              disabled={!canEdit}
              onPress={() => setIsAddingVehicle(true)}
              style={({ pressed }) => [styles.addButton, (pressed || !canEdit) && styles.pressed]}
            >
              <Text style={styles.addButtonPlus}>＋</Text>
              <Text style={styles.addButtonText}>Entrée</Text>
            </Pressable>
          </View>

          {loadError && (
            <View>
              <Text accessibilityRole="alert" style={styles.storageError}>
                {loadError} {cloud ? 'Vérifiez votre connexion ou votre accès.' : 'Le registre est en lecture seule pour préserver les données.'}
              </Text>
              <Pressable accessibilityRole="button" disabled={isLoading} onPress={retryLoad}>
                <Text style={styles.registerAction}>Réessayer le chargement</Text>
              </Pressable>
            </View>
          )}
          {hasRecoveryBackup && (
            <Text accessibilityRole="alert" style={styles.storageError}>
              Les données illisibles ont été mises de côté. Elles sont disponibles dans l’export du registre.
            </Text>
          )}

          <View style={styles.filterBar}>
            <FilterButton
              label="En cours"
              count={activeVehicles.length}
              selected={filter === 'active'}
              onPress={() => setFilter('active')}
            />
            <FilterButton
              label="Historique"
              count={historyVehicles.length}
              selected={filter === 'history'}
              onPress={() => setFilter('history')}
            />
          </View>

          {isLoading ? (
            <View style={styles.loadingState}>
              <ActivityIndicator color={COLORS.green} />
              <Text style={styles.loadingText}>Chargement des véhicules…</Text>
            </View>
          ) : visibleVehicles.length === 0 ? (
            <View style={styles.emptyState}>
              <View style={styles.emptyIcon}>
                <Text style={styles.emptyIconText}>{filter === 'active' ? 'P' : '↗'}</Text>
              </View>
              <Text style={styles.emptyTitle}>
                {filter === 'active' ? 'Parking vide pour le moment' : 'Pas encore d’historique'}
              </Text>
              <Text style={styles.emptyDescription}>
                {filter === 'active'
                  ? loadError
                    ? 'Aucun véhicule présent ne peut être affiché.'
                    : 'Enregistrez une entrée pour commencer le suivi.'
                  : 'Les véhicules sortis apparaîtront ici.'}
              </Text>
              {filter === 'active' && canEdit && (
                <Pressable onPress={() => setIsAddingVehicle(true)} style={styles.emptyAction}>
                  <Text style={styles.emptyActionText}>Enregistrer une entrée</Text>
                </Pressable>
              )}
            </View>
          ) : (
            <View style={styles.vehicleList}>
              {visibleVehicles.map((vehicle) => (
                <VehicleCard
                  key={vehicle.id}
                  vehicle={vehicle}
                  now={now}
                  onExit={canEdit ? () => confirmVehicleExit(vehicle) : undefined}
                />
              ))}
            </View>
          )}

          <Text style={styles.localNotice}>
            {cloud ? 'Registre partagé · actualisation toutes les 15 secondes' : 'Données enregistrées sur cet appareil'}
          </Text>
          {!cloud && (
            <Pressable
              accessibilityRole="button"
              disabled={isLoading || isExporting}
              onPress={() => void exportRegister()}
            >
              <Text style={styles.registerAction}>
                {isExporting ? 'Export en cours…' : 'Exporter les fiches du registre'}
              </Text>
            </Pressable>
          )}
        </ScrollView>
      </View>

      <Modal
        animationType="slide"
        onRequestClose={requestCloseAddModal}
        transparent
        visible={isAddingVehicle}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalOverlay}
        >
          <Pressable onPress={requestCloseAddModal} style={styles.modalBackdrop} />
          <ScrollView
            style={styles.modalSheet}
            contentContainerStyle={styles.modalContent}
            keyboardShouldPersistTaps="handled"
            bounces={false}
          >
            <View style={styles.modalHandle} />
            <View style={styles.modalHeader}>
              <View>
                <Text style={styles.modalTitle}>Nouvelle entrée</Text>
                <Text style={styles.modalSubtitle}>Enregistrez un véhicule à son arrivée</Text>
              </View>
              <Pressable
                accessibilityLabel="Fermer"
                accessibilityRole="button"
                disabled={isEntryBusy}
                onPress={requestCloseAddModal}
                style={styles.closeButton}
              >
                <Text style={styles.closeButtonText}>×</Text>
              </Pressable>
            </View>

            <Text style={styles.inputLabel}>PLAQUE D’IMMATRICULATION</Text>
            <TextInput
              accessibilityLabel="Plaque d’immatriculation"
              autoCapitalize="characters"
              autoCorrect={false}
              editable={!isEntryBusy}
              onChangeText={setPlate}
              placeholder="Saisir la plaque"
              placeholderTextColor={COLORS.muted}
              style={styles.plateResult}
              value={plate}
            />

            <Text style={[styles.inputLabel, styles.photoLabel]}>PHOTO DE LA PLAQUE (FACULTATIVE)</Text>
            <Pressable
              accessibilityRole="button"
              disabled={isEntryBusy}
              onPress={() => void takePlatePhoto()}
              style={({ pressed }) => [styles.photoButton, (pressed || isEntryBusy) && styles.pressed]}
            >
              {photoUri ? (
                <>
                  <Image source={{ uri: photoUri }} style={styles.photoPreview} />
                  <View style={styles.photoButtonTextWrap}>
                    <Text style={styles.photoButtonTitle}>Photo ajoutée</Text>
                    <Text style={styles.photoButtonSubtitle}>
                      {ocrStatus === 'reading'
                        ? 'Lecture automatique en cours…'
                        : ocrStatus === 'success'
                          ? 'Vérifiez la plaque avant d’enregistrer'
                          : ocrStatus === 'error'
                            ? 'Lecture impossible · saisissez la plaque'
                            : 'Toucher pour remplacer la photo'}
                    </Text>
                  </View>
                </>
              ) : (
                <>
                  <View style={styles.cameraIcon}>
                    <Text style={styles.cameraIconText}>⌾</Text>
                  </View>
                  <View style={styles.photoButtonTextWrap}>
                    <Text style={styles.photoButtonTitle}>Prendre une photo</Text>
                    <Text style={styles.photoButtonSubtitle}>Cadrez clairement la plaque</Text>
                  </View>
                  <Text style={styles.photoChevron}>›</Text>
                </>
              )}
            </Pressable>
            {photoUri && (
              <Pressable
                accessibilityRole="button"
                disabled={isEntryBusy}
                onPress={() => {
                  discardTemporaryPhoto(photoUri);
                  setPhotoUri(null);
                  setOcrStatus('idle');
                }}
              >
                <Text style={styles.registerAction}>Retirer la photo</Text>
              </Pressable>
            )}

            <View style={styles.timeInfo}>
              <Text style={styles.timeInfoIcon}>◷</Text>
              <Text style={styles.timeInfoText}>
                Date et heure d’entrée enregistrées automatiquement
              </Text>
            </View>

            <Pressable
              accessibilityRole="button"
              disabled={isEntryBusy || !canEdit || !isValidPlate}
              onPress={() => void saveVehicleEntry()}
              style={({ pressed }) => [
                styles.submitButton,
                (pressed || isEntryBusy || !canEdit || !isValidPlate) && styles.pressed,
              ]}
            >
              {isSaving ? (
                <ActivityIndicator color={COLORS.ink} />
              ) : (
                <Text style={styles.submitButtonText}>Enregistrer l’entrée</Text>
              )}
            </Pressable>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

function FilterButton({
  label,
  count,
  selected,
  onPress,
}: {
  label: string;
  count: number;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.filterButton, selected && styles.filterButtonSelected]}
    >
      <Text style={[styles.filterButtonText, selected && styles.filterButtonTextSelected]}>
        {label}
      </Text>
      <Text style={[styles.filterCount, selected && styles.filterCountSelected]}>{count}</Text>
    </Pressable>
  );
}

function VehicleCard({
  vehicle,
  now,
  onExit,
}: {
  vehicle: Vehicle;
  now: number;
  onExit?: () => void;
}) {
  const isActive = vehicle.exitAt === null;
  const endAt = vehicle.exitAt ?? new Date(now).toISOString();
  const duration = formatDuration(vehicle.entryAt, endAt);

  return (
    <View style={styles.vehicleCard}>
      <View style={styles.vehicleCardTop}>
        {vehicle.photoUri ? (
          <Image source={{ uri: vehicle.photoUri }} style={styles.platePhoto} />
        ) : (
          <View style={styles.platePlaceholder}>
            <Text style={styles.platePlaceholderText}>{vehicle.plate}</Text>
          </View>
        )}
        <View style={styles.vehicleInfo}>
          <Text style={styles.vehiclePlate}>{vehicle.plate}</Text>
          <Text style={styles.vehicleEntry}>Entrée · {formatDateTime(vehicle.entryAt)}</Text>
          {vehicle.exitAt && (
            <Text style={styles.vehicleEntry}>Sortie · {formatDateTime(vehicle.exitAt)}</Text>
          )}
        </View>
        <View style={[styles.vehicleStatus, isActive ? styles.statusActive : styles.statusDone]}>
          <Text
            style={[
              styles.vehicleStatusText,
              isActive ? styles.statusTextActive : styles.statusTextDone,
            ]}
          >
            {isActive ? 'PRÉSENT' : 'SORTI'}
          </Text>
        </View>
      </View>

      <View style={styles.vehicleCardBottom}>
        <View>
          <Text style={styles.durationLabel}>{isActive ? 'TEMPS ÉCOULÉ' : 'DURÉE TOTALE'}</Text>
          <Text style={styles.durationValue}>{duration}</Text>
        </View>
        {isActive && onExit && (
          <Pressable
            accessibilityRole="button"
            onPress={onExit}
            style={({ pressed }) => [styles.exitButton, pressed && styles.pressed]}
          >
            <Text style={styles.exitButtonText}>Sortie ↗</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  screen: {
    flex: 1,
  },
  header: {
    height: 74,
    paddingHorizontal: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  brand: {
    color: COLORS.green,
    fontSize: 20,
    fontWeight: '900',
    letterSpacing: 2,
  },
  headerSubtitle: {
    color: COLORS.muted,
    fontSize: 11,
    marginTop: 2,
  },
  headerBadge: {
    height: 42,
    width: 42,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.lime,
  },
  headerBadgeText: {
    color: COLORS.green,
    fontSize: 19,
    fontWeight: '900',
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingBottom: 36,
  },
  dateLabel: {
    color: COLORS.muted,
    fontSize: 13,
    fontWeight: '600',
    marginTop: 7,
    marginBottom: 14,
    textTransform: 'capitalize',
  },
  summaryCard: {
    backgroundColor: COLORS.green,
    borderRadius: 24,
    padding: 21,
    overflow: 'hidden',
    minHeight: 159,
  },
  summaryTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  liveLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  liveDot: {
    height: 7,
    width: 7,
    borderRadius: 4,
    backgroundColor: COLORS.lime,
  },
  liveText: {
    color: COLORS.lime,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.1,
  },
  summaryCaption: {
    color: '#CAD8CD',
    fontSize: 12,
  },
  summaryBottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 13,
  },
  vehicleCount: {
    color: '#FFFFFF',
    fontSize: 48,
    fontWeight: '700',
    letterSpacing: -2,
    lineHeight: 54,
  },
  summaryDivider: {
    width: 1,
    height: 38,
    backgroundColor: '#54735F',
    marginHorizontal: 20,
  },
  summaryStats: {
    gap: 2,
  },
  summaryStatNumber: {
    color: '#FFFFFF',
    fontSize: 19,
    fontWeight: '700',
  },
  summaryStatLabel: {
    color: '#CAD8CD',
    fontSize: 11,
  },
  summaryAccent: {
    position: 'absolute',
    right: -48,
    bottom: -83,
    height: 160,
    width: 160,
    borderRadius: 80,
    borderWidth: 1,
    borderColor: '#315F47',
  },
  sectionHeading: {
    marginTop: 28,
    marginBottom: 17,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionTitle: {
    color: COLORS.ink,
    fontSize: 21,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  sectionSubtitle: {
    color: COLORS.muted,
    fontSize: 11,
    marginTop: 4,
  },
  addButton: {
    flexDirection: 'row',
    gap: 4,
    alignItems: 'center',
    backgroundColor: COLORS.lime,
    paddingHorizontal: 13,
    height: 42,
    borderRadius: 14,
  },
  addButtonPlus: {
    color: COLORS.green,
    fontSize: 19,
    fontWeight: '500',
    marginTop: -1,
  },
  addButtonText: {
    color: COLORS.green,
    fontSize: 12,
    fontWeight: '800',
  },
  filterBar: {
    backgroundColor: '#E8EAE3',
    borderRadius: 14,
    padding: 4,
    flexDirection: 'row',
    marginBottom: 14,
  },
  filterButton: {
    flex: 1,
    height: 38,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 7,
  },
  filterButtonSelected: {
    backgroundColor: COLORS.card,
    shadowColor: '#29372D',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 3,
    elevation: 1,
  },
  filterButtonText: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '600',
  },
  filterButtonTextSelected: {
    color: COLORS.ink,
  },
  filterCount: {
    color: COLORS.muted,
    fontSize: 10,
    fontWeight: '700',
    backgroundColor: '#DDE0D8',
    overflow: 'hidden',
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  filterCountSelected: {
    color: COLORS.green,
    backgroundColor: COLORS.greenLight,
  },
  vehicleList: {
    gap: 11,
  },
  vehicleCard: {
    backgroundColor: COLORS.card,
    borderRadius: 18,
    padding: 14,
    borderWidth: 1,
    borderColor: '#ECEEE9',
  },
  vehicleCardTop: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  platePhoto: {
    height: 52,
    width: 67,
    borderRadius: 9,
    backgroundColor: '#E8EBE4',
  },
  platePlaceholder: {
    height: 48,
    minWidth: 70,
    paddingHorizontal: 6,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: '#D6DAD3',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FAFBF8',
  },
  platePlaceholderText: {
    color: COLORS.ink,
    fontWeight: '900',
    fontSize: 10,
    letterSpacing: 0.3,
  },
  vehicleInfo: {
    flex: 1,
    marginLeft: 12,
    gap: 4,
  },
  vehiclePlate: {
    color: COLORS.ink,
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  vehicleEntry: {
    color: COLORS.muted,
    fontSize: 10,
  },
  vehicleStatus: {
    borderRadius: 8,
    paddingHorizontal: 7,
    paddingVertical: 5,
    alignSelf: 'flex-start',
  },
  statusActive: {
    backgroundColor: COLORS.greenLight,
  },
  statusDone: {
    backgroundColor: '#F0F1EE',
  },
  vehicleStatusText: {
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 0.4,
  },
  statusTextActive: {
    color: COLORS.green,
  },
  statusTextDone: {
    color: COLORS.muted,
  },
  vehicleCardBottom: {
    borderTopWidth: 1,
    borderTopColor: '#F0F1EE',
    marginTop: 13,
    paddingTop: 11,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  durationLabel: {
    color: COLORS.muted,
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  durationValue: {
    color: COLORS.ink,
    fontSize: 12,
    fontWeight: '700',
    marginTop: 4,
  },
  exitButton: {
    backgroundColor: '#F5F6F1',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  exitButtonText: {
    color: COLORS.green,
    fontSize: 11,
    fontWeight: '800',
  },
  loadingState: {
    height: 178,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  loadingText: {
    color: COLORS.muted,
    fontSize: 12,
  },
  storageError: {
    color: COLORS.red,
    marginVertical: 12,
  },
  emptyState: {
    backgroundColor: COLORS.card,
    borderRadius: 18,
    alignItems: 'center',
    paddingHorizontal: 22,
    paddingVertical: 25,
    borderWidth: 1,
    borderColor: '#ECEEE9',
  },
  emptyIcon: {
    height: 44,
    width: 44,
    borderRadius: 15,
    backgroundColor: COLORS.greenLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  emptyIconText: {
    color: COLORS.green,
    fontSize: 22,
    fontWeight: '800',
  },
  emptyTitle: {
    color: COLORS.ink,
    fontSize: 14,
    fontWeight: '800',
    textAlign: 'center',
  },
  emptyDescription: {
    color: COLORS.muted,
    fontSize: 11,
    lineHeight: 17,
    textAlign: 'center',
    marginTop: 6,
  },
  emptyAction: {
    backgroundColor: COLORS.lime,
    borderRadius: 11,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginTop: 15,
  },
  emptyActionText: {
    color: COLORS.green,
    fontSize: 11,
    fontWeight: '800',
  },
  localNotice: {
    color: '#9BA198',
    textAlign: 'center',
    fontSize: 10,
    marginTop: 18,
  },
  signIn: {
    gap: 14,
    padding: 22,
  },
  registerAction: {
    color: COLORS.green,
    fontSize: 12,
    fontWeight: '700',
    paddingVertical: 12,
    textAlign: 'center',
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  modalBackdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(18, 30, 21, 0.48)',
  },
  modalSheet: {
    flexGrow: 0,
    maxHeight: '100%',
    backgroundColor: COLORS.background,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
  },
  modalContent: {
    paddingHorizontal: 22,
    paddingTop: 10,
    paddingBottom: Platform.OS === 'ios' ? 28 : 22,
  },
  modalHandle: {
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#D5D9D0',
    alignSelf: 'center',
    marginBottom: 18,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 23,
  },
  modalTitle: {
    color: COLORS.ink,
    fontSize: 21,
    fontWeight: '800',
  },
  modalSubtitle: {
    color: COLORS.muted,
    fontSize: 11,
    marginTop: 4,
  },
  closeButton: {
    height: 34,
    width: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: '#E8EAE3',
  },
  closeButtonText: {
    color: COLORS.ink,
    fontSize: 23,
    lineHeight: 25,
  },
  inputLabel: {
    color: COLORS.muted,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1,
    marginBottom: 8,
  },
  plateResult: {
    height: 53,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 13,
    paddingHorizontal: 15,
    color: COLORS.ink,
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 1,
  },
  photoLabel: {
    marginTop: 20,
  },
  photoButton: {
    minHeight: 70,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 14,
    padding: 10,
  },
  photoPreview: {
    height: 50,
    width: 67,
    borderRadius: 9,
    backgroundColor: COLORS.border,
  },
  photoButtonTextWrap: {
    flex: 1,
    marginLeft: 11,
  },
  photoButtonTitle: {
    color: COLORS.ink,
    fontSize: 12,
    fontWeight: '700',
  },
  photoButtonSubtitle: {
    color: COLORS.muted,
    fontSize: 10,
    marginTop: 4,
  },
  photoChevron: {
    color: COLORS.muted,
    fontSize: 24,
    paddingHorizontal: 5,
  },
  cameraIcon: {
    height: 42,
    width: 42,
    borderRadius: 13,
    backgroundColor: COLORS.greenLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraIconText: {
    color: COLORS.green,
    fontSize: 25,
    fontWeight: '700',
  },
  timeInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 17,
    marginBottom: 17,
  },
  timeInfoIcon: {
    color: COLORS.green,
    fontSize: 16,
    fontWeight: '700',
  },
  timeInfoText: {
    color: COLORS.muted,
    fontSize: 10,
  },
  submitButton: {
    minHeight: 52,
    backgroundColor: COLORS.lime,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitButtonText: {
    color: COLORS.green,
    fontSize: 13,
    fontWeight: '800',
  },
  pressed: {
    opacity: 0.76,
  },
});
