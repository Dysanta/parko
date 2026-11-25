import { useEffect, useMemo, useRef, useState } from 'react';
import { getDocumentAsync } from 'expo-document-picker';
import { File } from 'expo-file-system';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Choice, Panel } from './BillingPanels';
import { billingDate, validBillingDate } from './billing';
import { exportLoadingRelease } from './billingDocument';
import type { CloudRegister, Vehicle } from './cloudRegister';
import { cancelReleaseDocument, issueReleaseDocument, listReleaseDocuments, readReleaseDocument } from './loadingDocuments';
import { formatReleaseNumber, indexVisitsByPlate, matchLoadingNote, releaseConfirmationDate, sameLoadingNote, type LoadingNote, type ReleaseDocument } from './loadingNote';
import { normalizeReference, validLoadingNote } from './vehicleDetails';
import { COLORS } from './theme';

type LoadingDraft = LoadingNote & { announcedCount: string };

const fields = [
  { key: 'reference', label: 'Bon de chargement n°', max: 64 },
  { key: 'lot', label: 'N° de lot', max: 64 },
  { key: 'transport', label: 'Ensemble constitué', max: 200 },
  { key: 'announcedCount', label: 'Nombre de véhicules à transporter', max: 3 },
  { key: 'pickupLocation', label: 'Lieu d’enlèvement', max: 350 },
  { key: 'pickupDate', label: 'Date d’enlèvement', max: 10 },
] as const;

export function LoadingNotePanel({ vehicles, cloud, lookup, canConfirm, canCancel, onClose, onConfirm, onCreate }: {
  vehicles: Vehicle[]; cloud?: CloudRegister; lookup: boolean; canConfirm: boolean; canCancel: boolean; onClose: () => void;
  onConfirm: (document: ReleaseDocument) => Promise<string | undefined>;
  onCreate: () => void;
}) {
  const [note, setNote] = useState<LoadingDraft | null>(null);
  const [document, setDocument] = useState<ReleaseDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [manual, setManual] = useState(false);
  const [search, setSearch] = useState('');
  const [numberInput, setNumberInput] = useState('');
  const [askingCancellation, setAskingCancellation] = useState(false);
  const working = useRef(false);
  const visits = useMemo(() => new Map(vehicles.map((visit) => [visit.id, visit])), [vehicles]);
  const plates = useMemo(() => indexVisitsByPlate(vehicles), [vehicles]);
  const reference = normalizeReference(note?.reference ?? '');
  const matches = useMemo(() => note && !document ? matchLoadingNote({ ...note, reference }, plates) : [],
    [note, document, reference, plates]);
  const eligible = manual && !document ? vehicles.filter((visit) =>
    ((!visit.exitAt && !visit.loadingNote) || (!!reference && visit.loadingNote === reference)) &&
    visit.plate.includes(normalizeReference(search).replace(/[\s.-]+/g, '')),
  ) : [];
  const readyDocument = document?.pickupLocation && !document.cancelledAt ? document : null;
  const confirmedAt = document && releaseConfirmationDate(document, visits);
  const confirmationDisabled = busy || !canConfirm || !!confirmedAt || !!document?.cancelledAt || askingCancellation;
  const number = Number(numberInput.trim());
  const validNumber = /^\d{1,10}$/.test(numberInput.trim()) && number > 0 && number <= 2147483647;

  async function run(operation: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Le bon n’a pas pu être traité.');
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  async function load() {
    const selected = await getDocumentAsync({ type: 'application/pdf', copyToCacheDirectory: true });
    if (selected.canceled) return;
    const asset = selected.assets[0];
    setNote(null);
    setDocument(null);
    setAskingCancellation(false);
    setConflict(false);
    setManual(false);
    setSearch('');
    if (asset.size && asset.size > 5_000_000) throw new Error('Choisis un bon PDF de moins de 5 Mo.');
    const reader = await import('./loadingNotePdf');
    const bytes = Platform.OS === 'web' && asset.file
      ? new Uint8Array(await asset.file.arrayBuffer())
      : await new File(asset.uri).bytes();
    const imported = await reader.readLoadingNotePdf(bytes);
    const existing = await readReleaseDocument(imported.reference, cloud);
    setNote({ ...imported, announcedCount: String(imported.vehicles.length) });
    if (existing && !sameLoadingNote(imported, existing)) {
      setConflict(true);
      throw new Error('Un document différent existe déjà pour ce numéro de chargement.');
    }
    setDocument(existing ?? null);
  }

  function showDocument(saved: ReleaseDocument, fallbackLocation = '') {
    setAskingCancellation(false);
    setNote({
      reference: saved.reference, lot: saved.lot, transport: saved.transport,
      pickupDate: saved.pickupDate, pickupLocation: saved.pickupLocation ?? fallbackLocation,
      vehicles: saved.rows.map(({ plate, makeModel }) => ({ plate, makeModel })),
      announcedCount: String(saved.rows.length),
    });
    setDocument(saved);
  }

  async function findDocument() {
    if (!validNumber) return;
    const saved = await readReleaseDocument(number, cloud);
    if (!saved) throw new Error('Aucun bon de sortie ne correspond à ce numéro.');
    showDocument(saved);
  }

  function confirm() {
    if (!document || confirmationDisabled) return;
    void run(async () => {
      const date = await onConfirm(document);
      if (date) setDocument({ ...document, confirmedAt: date });
    });
  }

  function startManual() {
    setNote({
      reference: '', lot: '', transport: '', pickupLocation: '',
      pickupDate: billingDate(Date.now()), announcedCount: '0', vehicles: [],
    });
    setDocument(null);
    setAskingCancellation(false);
    setConflict(false);
    setError(null);
    setSearch('');
    setManual(true);
  }

  async function save() {
    if (!note || conflict) return;
    const frenchDate = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(note.pickupDate.trim());
    const pickupDate = frenchDate ? `${frenchDate[3]}-${frenchDate[2]}-${frenchDate[1]}` : note.pickupDate.trim();
    const loading: LoadingNote = {
      reference, pickupDate, lot: note.lot.trim(), transport: note.transport.trim(),
      pickupLocation: note.pickupLocation.trim(),
      vehicles: note.vehicles.map((vehicle) => ({ ...vehicle, makeModel: vehicle.makeModel.trim() })),
    };
    if (!validLoadingNote(reference) || !loading.lot || !loading.transport || !loading.pickupLocation || !validBillingDate(pickupDate)) {
      throw new Error('Renseigne le bon, le lot, l’ensemble constitué, le lieu et une date d’enlèvement valide.');
    }
    const count = loading.vehicles.length;
    if (count < 1 || count > 200) {
      throw new Error('Sélectionne entre 1 et 200 véhicules pour enregistrer le bon.');
    }
    if (!manual && (!/^\d{1,3}$/.test(note.announcedCount) || Number(note.announcedCount) !== count)) {
      throw new Error('Le nombre de véhicules à transporter doit correspondre au nombre de véhicules du bon.');
    }
    if (loading.vehicles.some((vehicle) => !vehicle.makeModel)) {
      throw new Error('Renseigne la marque ou le modèle de chaque véhicule.');
    }
    const previous = document ?? await readReleaseDocument(reference, cloud);
    if (previous && !sameLoadingNote(loading, previous)) {
      throw new Error('Un document différent existe déjà pour ce numéro de chargement.');
    }
    const unmatched = matches.find((match) => !match.row);
    if (!previous && unmatched) {
      throw new Error(`${unmatched.vehicle.plate} · ${unmatched.error}`);
    }
    const saved = previous?.pickupLocation ? previous : await issueReleaseDocument(loading, cloud);
    showDocument(saved, loading.pickupLocation);
  }

  return (
    <Panel title={lookup ? 'Bon de sortie' : 'Bon de chargement'} onClose={() => { if (!working.current) onClose(); }}>
      {lookup ? (
        document ? (
          <Choice label="Retour aux bons" disabled={busy} onPress={() => {
            setDocument(null);
            setNote(null);
            setNumberInput('');
            setError(null);
          }} />
        ) : <>
          <Choice label="Créer un bon de sortie" disabled={busy || !canConfirm} onPress={onCreate} selected />
          <TextInput accessibilityLabel="Numéro du bon de sortie" placeholder="Ex. 000001" value={numberInput}
            keyboardType="number-pad" maxLength={10} editable={!busy} style={styles.input}
            onChangeText={(value) => { setNumberInput(value); setError(null); }}
            onSubmitEditing={() => void run(findDocument)} />
          <Choice label="Rechercher le bon" disabled={busy || !validNumber} onPress={() => void run(findDocument)} />
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          <SavedReleases cloud={cloud} visits={visits} disabled={busy} onOpen={(saved) => {
            setError(null);
            showDocument(saved);
          }} />
        </>
      ) : (
        <>
          <Choice label={busy ? 'Traitement en cours…' : 'Importer le bon de chargement PDF'}
            onPress={() => void run(load)} disabled={busy} selected />
          <Choice label="Saisir un bon manuellement" onPress={startManual} disabled={busy} />
        </>
      )}
      {document && (
        <View style={styles.row}>
          {document.cancelledAt ? (
            <>
              <Text style={styles.heading}>Bon de sortie n° {formatReleaseNumber(document.number)} · Annulé</Text>
              {document.cancellationReason ? <Text style={styles.detail}>{document.cancellationReason}</Text> : null}
            </>
          ) : <>
            <ReleaseCheckbox
            label={`Bon de sortie n° ${formatReleaseNumber(document.number)}`}
            accessibilityLabel={`Valider l’enlèvement du bon de sortie n° ${formatReleaseNumber(document.number)}`}
            checked={!!confirmedAt} disabled={confirmationDisabled} onPress={confirm} />
          <Text style={styles.detail}>{confirmedAt
            ? `Enlèvement validé le ${new Date(confirmedAt).toLocaleString('fr-FR')}`
            : `Coche la case à l’enlèvement des ${document.rows.length} véhicule(s) du bon.`}</Text>
            {canCancel && !confirmedAt && (askingCancellation ? (
              <>
                <Text style={styles.detail}>Les véhicules resteront présents et pourront être ajoutés à un nouveau bon.</Text>
                <Choice label="Confirmer l’annulation du bon" disabled={busy || !canConfirm}
                  onPress={() => void run(async () => showDocument(await cancelReleaseDocument(document, cloud)))} />
                <Choice label="Garder le bon" disabled={busy} onPress={() => setAskingCancellation(false)} />
              </>
            ) : <Choice label="Annuler ce bon" disabled={busy || !canConfirm} onPress={() => setAskingCancellation(true)} />)}
          </>}
        </View>
      )}
      {error && (document || (!lookup && !note)) ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {note && (
        <>
          {fields.filter(({ key }) => !manual || !!document || key !== 'announcedCount').map(({ key, label, max }) => (
            <View key={key} style={styles.field}>
              <Text style={styles.heading}>{label}</Text>
              <TextInput accessibilityLabel={label} value={key === 'pickupLocation' ? document?.pickupLocation ?? note[key] : note[key]}
                editable={!busy && !conflict && (!document || (key === 'pickupLocation' && !document.pickupLocation && !document.cancelledAt))}
                maxLength={max} keyboardType={key === 'announcedCount' ? 'number-pad' : 'default'}
                placeholder={key === 'pickupDate' ? 'AAAA-MM-JJ ou JJ/MM/AAAA' : undefined}
                onChangeText={(value) => setNote({ ...note, [key]: value })} style={styles.input} />
            </View>
          ))}
          {manual && !document && (
            <>
              <Text style={styles.heading}>Coche les véhicules à transporter</Text>
              <TextInput accessibilityLabel="Rechercher une plaque" value={search} onChangeText={setSearch}
                placeholder="Immatriculation" style={styles.input} />
              {eligible.map((visit) => {
                const selected = note.vehicles.some((vehicle) => vehicle.plate === visit.plate);
                return (
                  <View key={visit.id} style={styles.row}>
                    <ReleaseCheckbox label={`${visit.plate} · ${visit.makeModel ?? 'Modèle à renseigner'}`}
                      checked={selected} disabled={busy || (!selected && note.vehicles.length >= 200)}
                      onPress={() => setNote({
                        ...note,
                        vehicles: selected ? note.vehicles.filter((vehicle) => vehicle.plate !== visit.plate)
                          : [...note.vehicles, { plate: visit.plate, makeModel: visit.makeModel ?? '' }],
                      })} />
                  </View>
                );
              })}
              {eligible.length === 0 && <Text style={styles.detail}>Aucun véhicule ne correspond.</Text>}
            </>
          )}
          <Text style={styles.heading}>{note.vehicles.length} véhicule(s) sur le bon</Text>
          {!document && !manual && Number(note.announcedCount) !== note.vehicles.length && (
            <Text style={styles.error}>Le nombre à transporter diffère du nombre de véhicules du bon.</Text>
          )}
          {document ? document.rows.map((row) => (
            <View key={row.plate} style={styles.row}>
              <Text style={styles.heading}>{row.plate} · {row.makeModel}</Text>
              <Text style={styles.detail}>Allée {row.aisle} · Clé {row.keyNumber}</Text>
            </View>
          )) : matches.map(({ vehicle, row, error: issue }) => (
            <View key={vehicle.plate} style={styles.row}>
              <Text style={styles.heading}>{vehicle.plate} · {vehicle.makeModel}</Text>
              {manual && (
                <TextInput accessibilityLabel={`Marque / modèle ${vehicle.plate}`} value={vehicle.makeModel}
                  editable={!busy} maxLength={100} placeholder="Marque / modèle" style={styles.input}
                  onChangeText={(makeModel) => setNote({ ...note,
                    vehicles: note.vehicles.map((item) => item.plate === vehicle.plate ? { ...item, makeModel } : item),
                  })} />
              )}
              {row ? <Text style={styles.detail}>Allée {row.aisle} · Clé {row.keyNumber}</Text>
                : <Text style={styles.error}>{issue}</Text>}
            </View>
          ))}
          {readyDocument ? (
            <Choice label={`Imprimer / PDF · N° ${formatReleaseNumber(readyDocument.number)}`}
              disabled={busy} selected onPress={() => void run(() => exportLoadingRelease(readyDocument))} />
          ) : !document?.cancelledAt && (
            <>
              {error && !document ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
              <Choice label={document ? 'Compléter le lieu d’enlèvement' : 'Enregistrer le bon de sortie'}
                disabled={busy || !canConfirm || conflict || (!document && !note.vehicles.length)}
                selected onPress={() => void run(save)} />
            </>
          )}
        </>
      )}
    </Panel>
  );
}

function SavedReleases({ cloud, visits, disabled, onOpen }: {
  cloud?: CloudRegister; visits: ReadonlyMap<string, Vehicle>; disabled: boolean;
  onOpen: (document: ReleaseDocument) => void;
}) {
  const [documents, setDocuments] = useState<ReleaseDocument[]>([]);
  const [cursor, setCursor] = useState<number>();
  const [next, setNext] = useState<number>();
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void listReleaseDocuments(cloud, cursor).then((page) => {
      if (!active) return;
      setDocuments((current) => cursor === undefined ? page.documents : [...current, ...page.documents]);
      setNext(page.next);
    }).catch((problem: unknown) => {
      if (active) setError(problem instanceof Error ? problem.message : 'Impossible de charger les bons.');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [cloud, cursor, attempt]);

  return (
    <>
      <Text style={styles.heading}>Bons enregistrés</Text>
      {documents.map((saved) => {
        const status = saved.cancelledAt ? 'Annulé' : releaseConfirmationDate(saved, visits) ? 'Enlèvement validé' : 'À enlever';
        return <Choice key={saved.number}
          label={`N° ${formatReleaseNumber(saved.number)} · ${saved.reference}\n${saved.rows.length} véhicule(s) · ${status}`}
          disabled={disabled} onPress={() => onOpen(saved)} />;
      })}
      {loading ? <Text style={styles.detail}>Chargement des bons…</Text> : null}
      {error ? (
        <>
          <Text accessibilityRole="alert" style={styles.error}>{error}</Text>
          <Choice label="Réessayer" disabled={disabled || loading} onPress={() => {
            setError(undefined);
            setLoading(true);
            setAttempt((value) => value + 1);
          }} />
        </>
      ) : !loading && (
        documents.length === 0 ? <Text style={styles.detail}>{cloud ? 'Aucun bon enregistré pour ce parking.'
          : 'Aucun bon enregistré sur cet appareil.'}</Text> : next !== undefined ?
            <Choice label="Afficher les bons précédents" disabled={disabled}
              onPress={() => { setLoading(true); setCursor(next); }} /> : null
      )}
    </>
  );
}

function ReleaseCheckbox({ label, accessibilityLabel, checked, disabled, onPress }: {
  label: string; accessibilityLabel?: string; checked: boolean; disabled: boolean; onPress: () => void;
}) {
  return (
    <Pressable accessibilityRole="checkbox" accessibilityLabel={accessibilityLabel ?? label}
      aria-checked={checked} aria-disabled={disabled} disabled={disabled} style={styles.confirm} onPress={onPress}
      onKeyDown={Platform.OS === 'web' ? (event) => {
        // React Native Web only handles Enter for the checkbox role.
        if (disabled || !('key' in event) || event.key !== ' ') return;
        event.preventDefault();
        if (!('repeat' in event) || !event.repeat) onPress();
      } : undefined}>
      <View style={[styles.checkbox, checked && styles.checked]}>
        {checked ? <Text style={styles.checkmark}>✓</Text> : null}
      </View>
      <Text style={styles.heading}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  heading: { color: COLORS.ink, fontWeight: '800' },
  detail: { color: COLORS.muted },
  field: { gap: 4 },
  input: { color: COLORS.ink, backgroundColor: COLORS.white, padding: 11, borderRadius: 9, borderWidth: 1, borderColor: COLORS.border },
  row: { padding: 10, gap: 3, backgroundColor: COLORS.white, borderRadius: 9 },
  confirm: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  checkbox: { alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 5, borderWidth: 2, borderColor: COLORS.ink },
  checked: { backgroundColor: COLORS.orange },
  checkmark: { color: COLORS.ink, fontWeight: '800' },
  error: { color: COLORS.error },
});
