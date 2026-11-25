import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Session } from '@supabase/supabase-js';
import { randomUUID } from 'expo-crypto';
import { File, Paths } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  cloudConfig,
  readCloudBilling,
  readCloudRegister,
  registerCloudEntry,
  saveCloudService,
  saveCloudVisitDetails,
  type CloudRegister,
  type PhotoCache,
  type Vehicle,
} from './cloudRegister';
import { billingDate } from './billing';
import { StatementPanel, VisitBillingPanel, type BillingAction } from './BillingPanels';
import { EditVehiclePanel, ExitReportPanel, VehicleDetailsFields } from './VehiclePanels';
import { assertAvailableKey, DEFAULT_CAPACITY, detailsForm, normalizeReference, validLoadingNote, validParkingPosition, type DetailsForm } from './vehicleDetails';
import { Reports } from './Reports';
import { LoadingNotePanel } from './LoadingNotePanel';
import { applyLocalRelease, assertLocalVisitNotReserved, confirmCloudRelease, withLocalRelease, withLocalReleaseWrite } from './loadingDocuments';
import { loadLocalRegister, RECOVERY_KEY, STORAGE_KEY, withLocalRegisterWrite } from './localRegister';
import type { ReleaseDocument } from './loadingNote';
import { COLORS } from './theme';
import { KeyboardViewport } from './KeyboardViewport';
import { CAMERA_DRAFT_KEY, discardTemporaryPhoto, preparePhoto, readPlateFromPhoto, recoverCameraDraft } from './registerCamera';

type VehicleFilter = 'active' | 'history';
const WORKSPACE_TABS = [
  { id: 'parking', label: 'Parking' },
  { id: 'vehicles', label: 'Rapport véhicules' },
  { id: 'finance', label: 'Suivi financier' },
] as const;

const parkLogo = require('./Logo_ParkLine.png');

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Une erreur inconnue est survenue.';
}

function normalizePlate(value: string) {
  return value.normalize('NFKC').toUpperCase().replace(/[\s.\p{Pd}]+/gu, '');
}

function isVisitIncomplete(visit: Vehicle) {
  return !visit.keyNumber || !visit.aisle || !visit.makeModel || (visit.exitAt !== null && !visit.loadingNote);
}

function showAlert(title: string, message: string) {
  if (Platform.OS === 'web') {
    window.alert(`${title}\n\n${message}`);
    return;
  }
  Alert.alert(title, message);
}

function formatDateTime(value: string, timeKnown = true) {
  const date = new Date(value);
  if (!timeKnown) {
    const [, month, day] = billingDate(value, false).split('-');
    return new Date(Date.UTC(2000, Number(month) - 1, Number(day))).toLocaleDateString('fr-FR', {
      day: '2-digit', month: 'short', timeZone: 'UTC',
    });
  }
  const day = date.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
  return `${day} · ${date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
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
      <KeyboardViewport style={styles.screen}>
        <ScrollView contentContainerStyle={styles.signIn} keyboardShouldPersistTaps="handled">
          <ParkBrand large />
          {session === undefined ? <ActivityIndicator color={COLORS.ink} /> : (
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
      </KeyboardViewport>
    </SafeAreaView>
  );
}

function ParkingScreen({ cloud, onSignOut }: { cloud?: CloudRegister; onSignOut?: () => void }) {
  const { tab } = useLocalSearchParams<{ tab?: string }>();
  const selectedTab = tab === 'vehicles' || tab === 'finance' ? tab : 'parking';
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [filter, setFilter] = useState<VehicleFilter>('active');
  const [search, setSearch] = useState('');
  const [capacity, setCapacity] = useState(DEFAULT_CAPACITY);
  const [entryDetails, setEntryDetails] = useState(() => detailsForm());
  const [detailVisitId, setDetailVisitId] = useState<string | null>(null);
  const [showExitReport, setShowExitReport] = useState(false);
  const [documentPanel, setDocumentPanel] = useState<'loading' | 'release' | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [billingError, setBillingError] = useState<string | null>(null);
  const [showStatement, setShowStatement] = useState(false);
  const [billingVisitId, setBillingVisitId] = useState<string | null>(null);
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
  const [now, setNow] = useState(Date.now);
  const storedVehiclesRef = useRef<Vehicle[] | null>(null);
  const registerLoad = useRef<Promise<Awaited<ReturnType<typeof loadLocalRegister>>> | null>(null);
  const photoCache = useRef<PhotoCache>(new Map());
  const pendingWrite = useRef(Promise.resolve());
  const savingEntry = useRef(false);
  const entryRequest = useRef<{ fingerprint: string; id: string; entryAt: string } | null>(null);
  const takingPhoto = useRef(false);
  const cameraRecovery = useRef<ReturnType<typeof recoverCameraDraft> | null>(null);

  useEffect(() => {
    if (cloud) return;
    let isMounted = true;

    async function loadVehicles() {
      try {
        registerLoad.current ??= withLocalRegisterWrite(loadLocalRegister);
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
        const [loaded, billing] = await Promise.all([
          readCloudRegister(cloudRegister, cache, controller.signal),
          readCloudBilling(cloudRegister, controller.signal)
            .then((data) => ({ data, error: null }))
            .catch((problem: unknown) => ({ data: null, error: getErrorMessage(problem) })),
        ]);
        if (controller.signal.aborted) return;
        setVehicles(loaded.vehicles.map((vehicle) => ({ ...vehicle, billing: billing.data?.get(vehicle.id) })));
        setCapacity(loaded.dedicatedCapacity);
        setNow(Date.now());
        setBillingError(billing.error);
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
        setEntryDetails(draft.details);
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
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') setNow(Date.now());
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, []);

  const activeVehicles = useMemo(
    () => vehicles.filter((vehicle) => vehicle.exitAt === null),
    [vehicles],
  );
  const historyVehicles = useMemo(
    () => vehicles.filter((vehicle) => vehicle.exitAt !== null),
    [vehicles],
  );
  const referenceSearch = normalizeReference(search);
  const plateSearch = normalizePlate(search);
  const visibleVehicles = (filter === 'active' ? activeVehicles : historyVehicles).filter((vehicle) =>
    !referenceSearch || (!!plateSearch && vehicle.plate.includes(plateSearch)) ||
    (vehicle.keyNumber ?? '').includes(referenceSearch),
  );
  const canEdit = !isLoading && !isRecoveringCamera && loadError === null;
  const billingVisit = vehicles.find((vehicle) => vehicle.id === billingVisitId);
  const detailVisit = activeVehicles.find((vehicle) => vehicle.id === detailVisitId);
  const billingUnavailable = loadError ?? billingError ?? (isLoading ? 'Chargement du registre…' : null);
  const isEntryBusy = isSaving || isTakingPhoto;
  const normalizedPlate = normalizePlate(plate);
  const isValidPlate = /^[\p{L}\p{N}]{1,32}$/u.test(normalizedPlate);
  const validEntryDetails = validParkingPosition(entryDetails.keyNumber, entryDetails.aisle);
  const today = billingDate(now);
  const todayEntries = vehicles.filter((vehicle) => billingDate(vehicle.entryAt, vehicle.entryTimeKnown) === today).length;
  const todayExits = historyVehicles.filter((vehicle) => vehicle.exitAt && billingDate(vehicle.exitAt, vehicle.exitTimeKnown) === today).length;
  const incomplete = vehicles.filter(isVisitIncomplete).length;

  function closeAddModal() {
    discardTemporaryPhoto(photoUri);
    entryRequest.current = null;
    setIsAddingVehicle(false);
    setPlate('');
    setEntryDetails(detailsForm());
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
    const write = pendingWrite.current.then(() => withLocalRegisterWrite(async () => {
      if (storedVehiclesRef.current === null) throw new Error('Le registre est en lecture seule.');
      const { vehicles: current } = await loadLocalRegister();
      const updated = await update(current);
      if (updated !== current) await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      storedVehiclesRef.current = updated;
      setVehicles(updated);
    }));
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
          await AsyncStorage.setItem(CAMERA_DRAFT_KEY, JSON.stringify({ plate, details: entryDetails }));
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
    if (!validEntryDetails) {
      showAlert('Fiche incomplète', 'Renseigne un numéro de clé et sélectionne une allée.');
      return;
    }

    const entryAt = new Date();
    const vehicle: Vehicle = {
      id: `${entryAt.getTime()}-${normalizedPlate}`,
      plate: normalizedPlate,
      entryAt: entryAt.toISOString(),
      photoUri,
      exitAt: null,
      keyNumber: normalizeReference(entryDetails.keyNumber),
      aisle: entryDetails.aisle,
      makeModel: entryDetails.makeModel.trim() || null,
    };

    savingEntry.current = true;
    setIsSaving(true);
    let storedPhoto: File | undefined;
    try {
      if (cloud) {
        const fingerprint = JSON.stringify([normalizedPlate, photoUri, vehicle.keyNumber, vehicle.aisle, vehicle.makeModel]);
        const previous = entryRequest.current;
        if (previous?.fingerprint === fingerprint) {
          vehicle.id = previous.id;
          vehicle.entryAt = previous.entryAt;
        } else {
          vehicle.id = randomUUID();
          entryRequest.current = { fingerprint, id: vehicle.id, entryAt: vehicle.entryAt };
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
        assertAvailableKey(current, normalizeReference(entryDetails.keyNumber));
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

  async function confirmRelease(document: ReleaseDocument) {
    if (!canEdit) throw new Error('Actualise le registre avant de valider l’enlèvement.');
    if (!cloud) {
      const deviceTime = Date.now();
      await withLocalRelease(document.number, (saved, documents) => updateVehicles((current) =>
        applyLocalRelease(saved, current, deviceTime, documents)));
      setNow(Date.now());
      return;
    }
    const confirmedAt = await confirmCloudRelease(document.number, cloud);
    setNow(Date.now());
    setLoadAttempt((attempt) => attempt + 1);
    return confirmedAt;
  }

  async function saveVehicleDetails(id: string, form: DetailsForm) {
    if (!canEdit) throw new Error('Actualise le registre avant de modifier la fiche.');
    const keyNumber = normalizeReference(form.keyNumber);
    const loadingNote = normalizeReference(form.loadingNote) || null;
    if (!validParkingPosition(keyNumber, form.aisle)) {
      throw new Error('Renseigne un numéro de clé et sélectionne une allée.');
    }
    if (loadingNote && !validLoadingNote(loadingNote)) throw new Error('Le numéro de bon est invalide.');
    const details = { keyNumber, aisle: form.aisle, makeModel: form.makeModel.trim() || null, loadingNote };
    if (cloud) {
      await saveCloudVisitDetails(cloud, id, details);
      setLoadAttempt((attempt) => attempt + 1);
      return;
    }
    await withLocalReleaseWrite(() => updateVehicles(async (current) => {
      const before = current.find((item) => item.id === id && item.exitAt === null);
      if (!before) throw new Error('Le véhicule a déjà quitté le parking.');
      assertAvailableKey(current, keyNumber, id);
      if (before.keyNumber !== keyNumber || before.aisle !== details.aisle ||
        (before.loadingNote ?? null) !== loadingNote) {
        await assertLocalVisitNotReserved(id);
      }
      return current.map((item) => item.id === id ? { ...item, ...details } : item);
    }));
  }

  async function changeVisitBilling(id: string, action: BillingAction) {
    if (billingUnavailable) throw new Error(billingUnavailable);

    function update(visit: Vehicle): Vehicle {
      const { service, remove } = action;
      if (!remove && (service.performedOn < billingDate(visit.entryAt, visit.entryTimeKnown)
        || service.performedOn > billingDate(visit.exitAt ?? Date.now(), visit.exitAt ? visit.exitTimeKnown : true))) {
        throw new Error('La date de réalisation doit être comprise dans le séjour.');
      }
      const remaining = (visit.billing?.services ?? []).filter((item) => item.id !== service.id);
      return { ...visit, billing: { services: remove ? remaining : [...remaining, service] } };
    }

    if (cloud) {
      await saveCloudService(cloud, id, action.service, action.remove);
      setVehicles((current) => current.map((visit) => {
        if (visit.id !== id) return visit;
        // A refresh can have picked up another agent's edit during this request.
        try {
          return update(visit);
        } catch {
          return visit;
        }
      }));
      setLoadAttempt((attempt) => attempt + 1);
      return;
    }
    await updateVehicles((current) => current.map((visit) => visit.id === id ? update(visit) : visit));
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <KeyboardViewport style={styles.screen}>
        <View style={styles.header}>
          <ParkBrand />
          {onSignOut ? (
            <Pressable accessibilityRole="button" onPress={onSignOut} disabled={isEntryBusy} style={styles.signOut}>
              <Text style={styles.registerAction}>Se déconnecter</Text>
            </Pressable>
          ) : null}
        </View>

        <View accessibilityRole="tablist" style={styles.workspaceTabs}>
          {WORKSPACE_TABS.map(({ id, label }) => (
            <Pressable key={id} accessibilityRole="tab" accessibilityState={{ selected: id === selectedTab }}
              onPress={() => {
                setNow(Date.now());
                router.setParams({ tab: id });
              }} style={[styles.workspaceTab, id === selectedTab && styles.workspaceTabSelected]}>
              <Text style={styles.workspaceTabLabel}>{label}</Text>
            </Pressable>
          ))}
        </View>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {selectedTab !== 'parking' ? (
            <Reports kind={selectedTab} cloud={cloud} vehicles={vehicles} asOf={now}
              localError={loadError ?? (isLoading ? 'Chargement du registre…' : null)} />
          ) : (
            <>
            <Text style={styles.dateLabel}>
              {new Date(now).toLocaleDateString('fr-FR', {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
              })}
            </Text>
            <View style={styles.vehicleActions}>
              <Pressable accessibilityRole="button" onPress={() => {
                setNow(Date.now());
                setShowStatement(true);
              }} style={[styles.exitButton, styles.actionButton]}>
                <Text style={styles.exitButtonText}>Facturation</Text>
              </Pressable>
              <Pressable accessibilityRole="button" disabled={!canEdit}
                onPress={() => setDocumentPanel('loading')} style={[styles.exitButton, styles.actionButton]}>
                <Text style={styles.exitButtonText}>Bon de chargement</Text>
              </Pressable>
              <Pressable accessibilityRole="button"
                onPress={() => setDocumentPanel('release')} style={[styles.exitButton, styles.actionButton]}>
                <Text style={styles.exitButtonText}>Bon de sortie</Text>
              </Pressable>
              <Pressable accessibilityRole="button" disabled={!canEdit}
                onPress={() => { setNow(Date.now()); setShowExitReport(true); }} style={[styles.exitButton, styles.actionButton]}>
                <Text style={styles.exitButtonText}>Rapport des sorties</Text>
              </Pressable>
            </View>

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
            <Text style={styles.sectionSubtitle}>
              {Math.max(0, capacity - activeVehicles.length)} places libres sur {capacity}
              {' · '}{Math.round(activeVehicles.length / capacity * 100)} % d’occupation
              {' · '}{todayExits} sortie(s) aujourd’hui
              {' · '}{incomplete} fiche(s) à compléter
            </Text>

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
                <Text style={styles.addButtonPlus}>+</Text>
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

            <TextInput
              accessibilityLabel="Rechercher par plaque ou clé" value={search} onChangeText={setSearch}
              placeholder="Rechercher par plaque ou clé" autoCorrect={false} style={styles.plateResult}
            />
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
                <ActivityIndicator color={COLORS.ink} />
                <Text style={styles.loadingText}>Chargement des véhicules…</Text>
              </View>
            ) : visibleVehicles.length === 0 ? (
              <View style={styles.emptyState}>
                <View style={styles.emptyIcon}>
                  <Text style={styles.emptyIconText}>{filter === 'active' ? 'P' : '↗'}</Text>
                </View>
                <Text style={styles.emptyTitle}>
                  {referenceSearch ? 'Aucun véhicule trouvé' : filter === 'active' ? 'Parking vide pour le moment' : 'Pas encore d’historique'}
                </Text>
                <Text style={styles.emptyDescription}>
                  {referenceSearch ? 'Essaie avec une autre plaque ou un autre numéro de clé.' : filter === 'active'
                    ? loadError
                      ? 'Aucun véhicule présent ne peut être affiché.'
                      : 'Enregistrez une entrée pour commencer le suivi.'
                    : 'Les véhicules sortis apparaîtront ici.'}
                </Text>
                {filter === 'active' && canEdit && !referenceSearch && (
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
                    onEdit={canEdit ? () => setDetailVisitId(vehicle.id) : undefined}
                    onBilling={() => {
                      setNow(Date.now());
                      setBillingVisitId(vehicle.id);
                    }}
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
            </>
          )}
        </ScrollView>
      </KeyboardViewport>

      {showStatement && (
        <StatementPanel
          vehicles={vehicles} asOf={now} unavailable={billingUnavailable}
          onClose={() => setShowStatement(false)}
        />
      )}
      {billingVisit && (
        <VisitBillingPanel
          key={billingVisit.id}
          visit={billingVisit} asOf={now} unavailable={billingUnavailable}
          onChange={(action) => changeVisitBilling(billingVisit.id, action)}
          onClose={() => setBillingVisitId(null)}
        />
      )}
      {detailVisit && (
        <EditVehiclePanel key={detailVisit.id} visit={detailVisit} onClose={() => setDetailVisitId(null)}
          onSave={(form) => saveVehicleDetails(detailVisit.id, form)} />
      )}
      {showExitReport && (
        <ExitReportPanel vehicles={historyVehicles} asOf={now} onClose={() => setShowExitReport(false)} />
      )}
      {documentPanel && (
        <LoadingNotePanel key={documentPanel} vehicles={vehicles} cloud={cloud} lookup={documentPanel === 'release'}
          canConfirm={canEdit} onConfirm={confirmRelease} onCreate={() => setDocumentPanel('loading')}
          onClose={() => setDocumentPanel(null)} />
      )}

      <Modal
        animationType="slide"
        onRequestClose={requestCloseAddModal}
        transparent
        visible={isAddingVehicle}
      >
        <KeyboardViewport modal style={styles.modalOverlay}>
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
            <View style={styles.detailsFields}>
              <VehicleDetailsFields value={entryDetails} onChange={setEntryDetails} disabled={isEntryBusy} />
            </View>

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
              disabled={isEntryBusy || !canEdit || !isValidPlate || !validEntryDetails}
              onPress={() => void saveVehicleEntry()}
              style={({ pressed }) => [
                styles.submitButton,
                (pressed || isEntryBusy || !canEdit || !isValidPlate || !validEntryDetails) && styles.pressed,
              ]}
            >
              {isSaving ? (
                <ActivityIndicator color={COLORS.ink} />
              ) : (
                <Text style={styles.submitButtonText}>Enregistrer l’entrée</Text>
              )}
            </Pressable>
          </ScrollView>
        </KeyboardViewport>
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
  onEdit,
  onBilling,
}: {
  vehicle: Vehicle;
  now: number;
  onEdit?: () => void;
  onBilling: () => void;
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
          <Text style={styles.vehicleEntry}>Clé {vehicle.keyNumber || '—'} · Allée {vehicle.aisle || '—'}</Text>
          {vehicle.makeModel && <Text style={styles.vehicleEntry}>{vehicle.makeModel}</Text>}
          {vehicle.loadingNote && <Text style={styles.vehicleEntry}>Bon · {vehicle.loadingNote}</Text>}
          {isVisitIncomplete(vehicle) && <Text style={styles.vehicleEntry}>Fiche à compléter</Text>}
          <Text style={styles.vehicleEntry}>Entrée · {formatDateTime(vehicle.entryAt, vehicle.entryTimeKnown)}</Text>
          {vehicle.exitAt && (
            <Text style={styles.vehicleEntry}>Sortie · {formatDateTime(vehicle.exitAt, vehicle.exitTimeKnown)}</Text>
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
          <Text style={styles.durationValue}>
            {vehicle.entryTimeKnown === false || vehicle.exitTimeKnown === false ? 'Heure inconnue' : duration}
          </Text>
        </View>
        {isActive && onEdit && (
          <Pressable accessibilityRole="button" onPress={onEdit} style={styles.exitButton}>
            <Text style={styles.exitButtonText}>Modifier la fiche</Text>
          </Pressable>
        )}
        <Pressable accessibilityRole="button" onPress={onBilling} style={styles.exitButton}>
          <Text style={styles.exitButtonText}>Prestations</Text>
        </Pressable>
      </View>
    </View>
  );
}

function ParkBrand({ large = false }: { large?: boolean }) {
  return (
    <View style={[styles.brand, large && styles.largeBrand]}>
      <View style={[styles.logoFrame, large && styles.largeLogoFrame]}>
        <Image source={parkLogo} accessibilityLabel="PerfectLine Park" accessible resizeMode="contain"
          style={[styles.logoImage, large && styles.largeLogoImage]} />
      </View>
      <Text accessibilityRole="header" style={[styles.brandName, large && styles.largeBrandName]}>Parko</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  workspaceTabs: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 18, paddingBottom: 6 },
  workspaceTab: {
    paddingVertical: 10, paddingHorizontal: 10, borderRadius: 9, backgroundColor: COLORS.white,
    borderWidth: 1, borderColor: COLORS.border,
  },
  workspaceTabSelected: { backgroundColor: COLORS.orangeTint, borderColor: COLORS.orange },
  workspaceTabLabel: { color: COLORS.ink, fontSize: 12, fontWeight: '800' },
  vehicleActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  actionButton: { flexBasis: '46%', flexGrow: 1, justifyContent: 'center', minHeight: 44 },
  detailsFields: { marginTop: 14 },
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.background,
    borderTopWidth: 3,
    borderTopColor: COLORS.orange,
  },
  screen: {
    flex: 1,
  },
  header: {
    minHeight: 76,
    paddingHorizontal: 20,
    backgroundColor: COLORS.white,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    marginBottom: 12,
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  largeBrand: { flexDirection: 'column', gap: 4 },
  brandName: { color: COLORS.ink, fontSize: 22, fontWeight: '900' },
  largeBrandName: { fontSize: 30 },
  signOut: { flexShrink: 1 },
  logoFrame: { width: 118, height: 62, overflow: 'hidden', backgroundColor: COLORS.white },
  logoImage: { position: 'absolute', width: 200, height: 90, left: -41, top: -19 },
  largeLogoFrame: { width: 212, height: 120 },
  largeLogoImage: { width: 359, height: 161, left: -74, top: -27 },
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
    backgroundColor: COLORS.ink,
    borderRadius: 24,
    borderTopWidth: 3,
    borderTopColor: COLORS.orange,
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
    backgroundColor: COLORS.orange,
  },
  liveText: {
    color: COLORS.orange,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.1,
  },
  summaryCaption: {
    color: COLORS.onDarkMuted,
    fontSize: 12,
  },
  summaryBottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 13,
  },
  vehicleCount: {
    color: COLORS.white,
    fontSize: 48,
    fontWeight: '700',
    letterSpacing: -2,
    lineHeight: 54,
  },
  summaryDivider: {
    width: 1,
    height: 38,
    backgroundColor: COLORS.onDarkBorder,
    marginHorizontal: 20,
  },
  summaryStats: {
    gap: 2,
  },
  summaryStatNumber: {
    color: COLORS.white,
    fontSize: 19,
    fontWeight: '700',
  },
  summaryStatLabel: {
    color: COLORS.onDarkMuted,
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
    borderColor: COLORS.onDarkBorder,
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
    backgroundColor: COLORS.orange,
    paddingHorizontal: 13,
    height: 42,
    borderRadius: 14,
  },
  addButtonPlus: {
    color: COLORS.ink,
    fontSize: 19,
    fontWeight: '500',
    marginTop: -1,
  },
  addButtonText: {
    color: COLORS.ink,
    fontSize: 12,
    fontWeight: '800',
  },
  filterBar: {
    backgroundColor: COLORS.neutral,
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
    backgroundColor: COLORS.white,
    shadowColor: COLORS.ink,
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
    backgroundColor: COLORS.border,
    overflow: 'hidden',
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  filterCountSelected: {
    color: COLORS.ink,
    backgroundColor: COLORS.orangeTint,
  },
  vehicleList: {
    gap: 11,
  },
  vehicleCard: {
    backgroundColor: COLORS.white,
    borderRadius: 18,
    padding: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  vehicleCardTop: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  platePhoto: {
    height: 52,
    width: 67,
    borderRadius: 9,
    backgroundColor: COLORS.border,
  },
  platePlaceholder: {
    height: 48,
    minWidth: 70,
    paddingHorizontal: 6,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: COLORS.inputBorder,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.background,
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
    backgroundColor: COLORS.orangeTint,
  },
  statusDone: {
    backgroundColor: COLORS.neutral,
  },
  vehicleStatusText: {
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 0.4,
  },
  statusTextActive: {
    color: COLORS.ink,
  },
  statusTextDone: {
    color: COLORS.muted,
  },
  vehicleCardBottom: {
    borderTopWidth: 1,
    borderTopColor: COLORS.neutral,
    marginTop: 13,
    paddingTop: 11,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
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
    backgroundColor: COLORS.orangeTint,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  exitButtonText: {
    color: COLORS.ink,
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
    color: COLORS.error,
    marginVertical: 12,
  },
  emptyState: {
    backgroundColor: COLORS.white,
    borderRadius: 18,
    alignItems: 'center',
    paddingHorizontal: 22,
    paddingVertical: 25,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  emptyIcon: {
    height: 44,
    width: 44,
    borderRadius: 15,
    backgroundColor: COLORS.orangeTint,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  emptyIconText: {
    color: COLORS.ink,
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
    backgroundColor: COLORS.orange,
    borderRadius: 11,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginTop: 15,
  },
  emptyActionText: {
    color: COLORS.ink,
    fontSize: 11,
    fontWeight: '800',
  },
  localNotice: {
    color: COLORS.muted,
    textAlign: 'center',
    fontSize: 10,
    marginTop: 18,
  },
  signIn: {
    gap: 14,
    width: '100%',
    maxWidth: 440,
    alignSelf: 'center',
    paddingHorizontal: 22,
    paddingTop: 32,
    paddingBottom: 28,
  },
  registerAction: {
    color: COLORS.orangeDark,
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
    backgroundColor: COLORS.overlay,
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
    backgroundColor: COLORS.border,
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
    backgroundColor: COLORS.neutral,
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
    backgroundColor: COLORS.white,
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
    backgroundColor: COLORS.white,
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
    backgroundColor: COLORS.orangeTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraIconText: {
    color: COLORS.ink,
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
    color: COLORS.ink,
    fontSize: 16,
    fontWeight: '700',
  },
  timeInfoText: {
    color: COLORS.muted,
    fontSize: 10,
  },
  submitButton: {
    minHeight: 52,
    backgroundColor: COLORS.orange,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitButtonText: {
    color: COLORS.ink,
    fontSize: 13,
    fontWeight: '800',
  },
  pressed: {
    opacity: 0.76,
  },
});
