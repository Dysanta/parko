import { useRef, useState, type ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import type { Vehicle } from './cloudRegister';
import {
  billingDate, calculateStatement, formatEuros, parseRate, SERVICES, STORAGE_DAY_LABEL,
  validBillingDate, type ServiceKind, type VisitService,
} from './billing';
import { exportStatement } from './billingDocument';
import { COLORS } from './theme';
import { KeyboardViewport } from './KeyboardViewport';

export function Panel({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <Modal transparent visible animationType="slide" onRequestClose={onClose}>
      <KeyboardViewport modal style={styles.overlay}>
        <View style={styles.panel}>
          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>
            <Pressable accessibilityLabel="Fermer" accessibilityRole="button" onPress={onClose} style={styles.close}>
              <Text style={styles.title}>×</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">{children}</ScrollView>
        </View>
      </KeyboardViewport>
    </Modal>
  );
}

export function Choice({ label, selected, disabled, onPress }: {
  label: string; selected?: boolean; disabled?: boolean; onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button" accessibilityState={{ selected, disabled }}
      disabled={disabled} onPress={onPress}
      style={[styles.choice, selected && styles.selected, disabled && styles.disabled]}
    >
      <Text style={styles.choiceText}>{label}</Text>
    </Pressable>
  );
}

export function StatementPanel({ vehicles, asOf, unavailable, onClose }: {
  vehicles: Vehicle[]; asOf: number; unavailable: string | null; onClose: () => void;
}) {
  const [month, setMonth] = useState(() => billingDate(asOf).slice(0, 7));
  const [customRate, setCustomRate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const validMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && month <= billingDate(asOf).slice(0, 7);
  const report = !unavailable && validMonth
    ? calculateStatement(vehicles, month, asOf, parseRate(customRate))
    : null;

  async function exportPdf() {
    if (!report || report.needsRate || exporting) return;
    setExporting(true);
    setError(null);
    try {
      await exportStatement(report);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Impossible d’exporter le relevé.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <Panel title="Facturation" onClose={onClose}>
      <Text style={styles.description}>Relevé mensuel HT du parking</Text>
      {unavailable ? <Text accessibilityRole="alert" style={styles.error}>{unavailable}</Text> : (
        <>
          <Text style={styles.label}>Mois de facturation</Text>
          <TextInput
            accessibilityLabel="Mois de facturation" placeholder="AAAA-MM" maxLength={7}
            value={month} onChangeText={(value) => {
              setMonth(value);
              setCustomRate('');
              setError(null);
            }} style={styles.input}
          />
          {!validMonth && <Text style={styles.error}>Saisis un mois en cours ou passé au format AAAA-MM.</Text>}
          <Text style={styles.description}>{STORAGE_DAY_LABEL}</Text>
          {report && (
            <>
              <View style={styles.total}>
                <Text style={styles.label}>{report.total === null ? 'Total HT en attente du tarif de stockage' : `Total HT · ${formatEuros(report.total)}`}</Text>
                <Text style={styles.description}>{report.receipts} entrées effectives dans le mois · {report.visits.length} séjours concernés</Text>
              </View>
              {report.rows[0].quantity > 0 && (report.receipts === 0 || report.receipts > 200) && (
                <>
                  <Text style={styles.label}>{report.receipts
                    ? 'Plus de 200 entrées · tarif spécifique'
                    : 'Stockage reporté sans entrée ce mois-ci · tarif spécifique'}</Text>
                  <TextInput
                    accessibilityLabel="Tarif négocié en euros HT par jour" placeholder="Ex. 1,50"
                    keyboardType="decimal-pad" value={customRate} onChangeText={setCustomRate} style={styles.input}
                  />
                </>
              )}
              {report.rows.map((row) => (
                <View key={row.label} style={styles.row}>
                  <View style={styles.rowLabel}>
                    <Text style={styles.choiceText}>{row.label}</Text>
                    <Text style={styles.description}>{row.quantity} {row.unit} · {row.rate === null ? 'Tarif à définir' : `${formatEuros(row.rate)} HT / unité`}</Text>
                  </View>
                  <Text style={styles.label}>{row.rate === null && row.quantity ? 'À calculer' : formatEuros(row.quantity * (row.rate ?? 0))}</Text>
                </View>
              ))}
              <Choice label={exporting ? 'Export en cours…' : 'Exporter le relevé HT en PDF'} onPress={() => void exportPdf()} disabled={exporting || report.needsRate} selected />
              {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
            </>
          )}
        </>
      )}
    </Panel>
  );
}

export type BillingAction = { service: VisitService; remove: boolean };

export function VisitBillingPanel({ visit, asOf, unavailable, onChange, onClose }: {
  visit: Vehicle; asOf: number; unavailable: string | null; onChange: (action: BillingAction) => Promise<void>; onClose: () => void;
}) {
  const [service, setService] = useState<ServiceKind>();
  const [day, setDay] = useState(() => billingDate(visit.exitAt ?? asOf, visit.exitAt ? visit.exitTimeKnown : true));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const attempt = useRef<VisitService | null>(null);

  async function save(action: BillingAction) {
    if (working.current || unavailable) return;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      await onChange(action);
      if (!action.remove) {
        attempt.current = null;
        setService(undefined);
      }
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Impossible d’enregistrer la prestation.');
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  function add() {
    if (!service || working.current) return;
    const lastDay = billingDate(visit.exitAt ?? asOf, visit.exitAt ? visit.exitTimeKnown : true);
    if (!validBillingDate(day) || day < billingDate(visit.entryAt, visit.entryTimeKnown) || day > lastDay || day > billingDate(asOf)) {
      setError('Saisis une date de réalisation comprise dans le séjour au format AAAA-MM-JJ.');
      return;
    }
    if (attempt.current?.kind !== service || attempt.current.performedOn !== day) {
      attempt.current = { id: randomUUID(), kind: service, performedOn: day };
    }
    void save({ service: attempt.current, remove: false });
  }

  return (
    <Panel title={`Facturation · ${visit.plate}`} onClose={() => { if (!working.current) onClose(); }}>
      {unavailable ? <Text accessibilityRole="alert" style={styles.error}>{unavailable}</Text> : (
        <>
          {!!visit.billing?.services.length && <Text style={styles.label}>Prestations réalisées</Text>}
          {(visit.billing?.services ?? []).map((item) => (
            <View style={styles.row} key={item.id}>
              <View style={styles.rowLabel}>
                <Text style={styles.choiceText}>{SERVICES[item.kind].label}</Text>
                <Text style={styles.description}>{item.performedOn} · {formatEuros(SERVICES[item.kind].cents)} HT</Text>
              </View>
              <Choice label="Retirer" disabled={busy} onPress={() => void save({ service: item, remove: true })} />
            </View>
          ))}
          <Text style={styles.label}>Ajouter une prestation</Text>
          {(Object.keys(SERVICES) as ServiceKind[]).map((kind) => (
            <Choice
              key={kind} label={`${SERVICES[kind].label} · ${formatEuros(SERVICES[kind].cents)} HT`}
              selected={kind === service} disabled={busy} onPress={() => setService(kind)}
              />
          ))}
          <TextInput
            accessibilityLabel="Date de réalisation" placeholder="AAAA-MM-JJ" maxLength={10}
            value={day} onChangeText={setDay} editable={!busy} style={styles.input}
          />
          <Choice label="Enregistrer la prestation" disabled={busy || !service} selected onPress={add} />
          {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
        </>
      )}
    </Panel>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: COLORS.overlay, justifyContent: 'flex-end', alignItems: 'center' },
  panel: { width: '100%', maxWidth: 640, height: '85%', borderTopLeftRadius: 24, borderTopRightRadius: 24, backgroundColor: COLORS.background },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 10 },
  close: { paddingHorizontal: 12, paddingVertical: 8 },
  content: { paddingHorizontal: 20, paddingBottom: 36, gap: 9 },
  title: { color: COLORS.ink, fontSize: 22, fontWeight: '800', flexShrink: 1 },
  label: { color: COLORS.ink, fontWeight: '800', marginTop: 5 },
  description: { color: COLORS.muted, flexShrink: 1 },
  choice: { backgroundColor: COLORS.white, borderColor: COLORS.border, borderWidth: 1, borderRadius: 10, padding: 12 },
  choiceText: { color: COLORS.ink, fontWeight: '700' },
  selected: { backgroundColor: COLORS.orangeTint, borderColor: COLORS.orange },
  disabled: { opacity: 0.55 },
  input: { color: COLORS.ink, backgroundColor: COLORS.white, borderRadius: 10, padding: 12, borderWidth: 1, borderColor: COLORS.border },
  total: { backgroundColor: COLORS.orangeTint, padding: 12, gap: 5, borderRadius: 10 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingVertical: 6 },
  rowLabel: { flex: 1, gap: 4 },
  error: { color: COLORS.error },
});
