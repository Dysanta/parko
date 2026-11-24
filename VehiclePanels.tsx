import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Choice, Panel } from './BillingPanels';
import { billingDate, validBillingDate } from './billing';
import { exportExitReport } from './billingDocument';
import type { Vehicle } from './cloudRegister';
import { AISLES, detailsForm, normalizeReference, type DetailsForm } from './vehicleDetails';
import { COLORS } from './theme';

export function VehicleDetailsFields({ value, onChange, disabled, includeNote }: {
  value: DetailsForm; onChange: (value: DetailsForm) => void; disabled: boolean; includeNote?: boolean;
}) {
  return (
    <View style={styles.fields}>
      <Text style={styles.label}>N° de clé</Text>
      <TextInput
        accessibilityLabel="N° de clé" value={value.keyNumber} editable={!disabled} autoCapitalize="characters"
        autoCorrect={false} maxLength={32} onChangeText={(keyNumber) => onChange({ ...value, keyNumber })}
        placeholder="Ex. 007" style={styles.input}
      />
      <Text style={styles.label}>Allée / zone</Text>
      <View style={styles.aisles}>
        {AISLES.map((aisle) => (
          <Pressable
            key={aisle} accessibilityRole="button" accessibilityLabel={`Allée ${aisle}`}
            accessibilityState={{ selected: value.aisle === aisle, disabled }}
            disabled={disabled} onPress={() => onChange({ ...value, aisle })}
            style={[styles.aisle, value.aisle === aisle && styles.selected]}
          >
            <Text style={styles.label}>{aisle}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={styles.label}>Marque / modèle (facultatif)</Text>
      <TextInput
        accessibilityLabel="Marque / modèle" value={value.makeModel} editable={!disabled} maxLength={100}
        onChangeText={(makeModel) => onChange({ ...value, makeModel })} style={styles.input}
      />
      {includeNote && (
        <LoadingNoteInput value={value.loadingNote} editable={!disabled}
          onChange={(loadingNote) => onChange({ ...value, loadingNote })} />
      )}
    </View>
  );
}

function LoadingNoteInput({ value, editable, onChange }: {
  value: string; editable: boolean; onChange: (value: string) => void;
}) {
  return (
    <>
      <Text style={styles.label}>N° de bon de chargement</Text>
      <TextInput
        accessibilityLabel="N° de bon de chargement" value={value} editable={editable}
        onChangeText={onChange} autoCorrect={false} autoCapitalize="characters" maxLength={64}
        placeholder="Ex. BOTP001" style={styles.input}
      />
    </>
  );
}

export function EditVehiclePanel({ visit, onSave, onClose }: {
  visit: Vehicle; onSave: (details: DetailsForm) => Promise<void>; onClose: () => void;
}) {
  const [value, setValue] = useState(() => detailsForm(visit));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const working = useRef(false);

  async function save() {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      await onSave(value);
      onClose();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Enregistrement impossible.');
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  return (
    <Panel title={`Fiche · ${visit.plate}`} onClose={() => { if (!working.current) onClose(); }}>
      <VehicleDetailsFields value={value} onChange={setValue} disabled={busy} includeNote />
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      <Choice label="Enregistrer la fiche" onPress={() => void save()} disabled={busy} selected />
    </Panel>
  );
}

function vehicleLine(visit: Vehicle) {
  return `${visit.plate} · ${visit.makeModel || 'Marque à compléter'} · Allée ${visit.aisle || '—'} · Clé ${visit.keyNumber || '—'}`;
}

export function ExitReportPanel({ vehicles, asOf, onClose }: {
  vehicles: Vehicle[]; asOf: number; onClose: () => void;
}) {
  const [date, setDate] = useState(() => billingDate(asOf));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const rows = validBillingDate(date)
    ? vehicles.filter((visit) => visit.exitAt && billingDate(visit.exitAt, visit.exitTimeKnown) === date)
      .sort((a, b) => (a.loadingNote ?? '').localeCompare(b.loadingNote ?? '', 'fr') || a.plate.localeCompare(b.plate))
    : [];

  async function print() {
    setBusy(true);
    setError('');
    try {
      await exportExitReport(date, rows);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Impossible de générer le rapport.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Rapport des sorties" onClose={onClose}>
      <Text style={styles.label}>Date de sortie</Text>
      <TextInput
        accessibilityLabel="Date de sortie" placeholder="AAAA-MM-JJ" maxLength={10}
        value={date} onChangeText={setDate} style={styles.input}
      />
      {!validBillingDate(date) && <Text style={styles.error}>Saisis une date au format AAAA-MM-JJ.</Text>}
      <Text>{rows.length} véhicule(s) sorti(s)</Text>
      {rows.map((visit, index) => (
        <View key={visit.id} style={styles.fields}>
          {(index === 0 || (rows[index - 1].loadingNote ?? '') !== (visit.loadingNote ?? '')) && (
            <Text style={styles.label}>{visit.loadingNote || 'Sans bon de chargement'}</Text>
          )}
          <Text>{vehicleLine(visit)}</Text>
        </View>
      ))}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      <Choice label="Imprimer / exporter en PDF" onPress={() => void print()} disabled={busy || !rows.length} selected />
    </Panel>
  );
}

const styles = StyleSheet.create({
  fields: { gap: 6 },
  label: { color: COLORS.ink, fontWeight: '700' },
  input: { backgroundColor: COLORS.white, color: COLORS.ink, borderColor: COLORS.border, borderWidth: 1, borderRadius: 10, padding: 11 },
  aisles: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  aisle: { alignItems: 'center', justifyContent: 'center', width: 38, minHeight: 38, backgroundColor: COLORS.white, borderRadius: 8, borderWidth: 1, borderColor: COLORS.border },
  selected: { backgroundColor: COLORS.orangeTint, borderColor: COLORS.orange },
  error: { color: COLORS.error },
});
