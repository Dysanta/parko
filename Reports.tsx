import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { billingDate, calculateDailyFinance, formatEuros, parseRate, STORAGE_DAY_LABEL, validBillingDate } from './billing';
import { exportReportCsv, exportReportPdf } from './billingDocument';
import { readCloudReports, type CloudRegister, type ReportsSnapshot, type Vehicle } from './cloudRegister';
import { filterVehicleReport, reportDateTime, vehicleReportRow, VEHICLE_COLUMNS, VEHICLE_REPORT_FIELDS, type ReportStatus } from './reportData';
import { COLORS } from './theme';

type ReportKind = 'vehicles' | 'finance';
type ReportData = { vehicles: Vehicle[]; asOf: number };
const financeColumns = [
  'Date', 'Entrées', 'Sorties', 'Véhicules stockés', 'CA entrées HT', 'CA sorties HT',
  'CA stockage HT', 'CA prestations HT', 'CA total jour HT', 'CA cumulé du mois HT', 'Présents fin de jour',
];

function Button({ title, onPress, disabled = false, selected = false }: {
  title: string; onPress: () => void; disabled?: boolean; selected?: boolean;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected, disabled }} disabled={disabled}
      onPress={onPress} style={[styles.button, selected && styles.selected, disabled && styles.disabled]}>
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  );
}

function ExportButtons({ title, subtitle, filename, columns, getRows, disabled = false }: {
  title: string; subtitle: string; filename: string; columns: readonly string[];
  getRows: (kind: 'csv' | 'pdf') => (string | number)[][]; disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(kind: 'csv' | 'pdf') {
    setBusy(true);
    setError(null);
    try {
      const rows = getRows(kind);
      if (kind === 'csv') await exportReportCsv(filename, columns, rows);
      else await exportReportPdf(title, subtitle, columns, rows);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Export impossible.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <View style={styles.actions}>
        <Button title="Exporter le CSV" disabled={disabled || busy} onPress={() => void save('csv')} selected />
        <Button title="Imprimer / PDF" disabled={disabled || busy} onPress={() => void save('pdf')} />
      </View>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    </>
  );
}

function VehicleReport({ vehicles, asOf }: ReportData) {
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<ReportStatus>('all');
  const [limit, setLimit] = useState(25);
  const today = billingDate(asOf);
  const validPeriod = (!start || validBillingDate(start) && start <= today) && (!end || validBillingDate(end) && end <= today)
    && (!start || !end || start <= end);
  const matches = validPeriod ? filterVehicleReport(vehicles, start, end, status, search) : [];
  const inPeriod = (day: string) => (!start || day >= start) && (!end || day <= end);
  const entries = matches.filter((visit) => inPeriod(billingDate(visit.entryAt, visit.entryTimeKnown))).length;
  const exits = matches.filter((visit) => visit.exitAt && inPeriod(billingDate(visit.exitAt, visit.exitTimeKnown))).length;
  const statusLabels: [ReportStatus, string][] = [['all', 'Tous'], ['active', 'Présents'], ['history', 'Sortis']];
  const context = `Généré le ${reportDateTime(new Date(asOf).toISOString())} · ${matches.length} séjour(s) · ${entries} entrée(s), ${exits} sortie(s)`;
  const period = start || end ? `Période de présence ${start || '—'} au ${end || '—'}` : 'Toutes les dates';

  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.title}>Rapport des véhicules</Text>
      <Text style={styles.description}>Une ligne par séjour. Laisse les dates vides pour inclure tout le registre.</Text>
      <View style={styles.actions}>
        <View style={styles.field}>
          <Text style={styles.label}>Du</Text>
          <TextInput accessibilityLabel="Début de la période" value={start} onChangeText={(value) => { setStart(value); setLimit(25); }}
            placeholder="AAAA-MM-JJ" maxLength={10} style={styles.input} />
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>Au</Text>
          <TextInput accessibilityLabel="Fin de la période" value={end} onChangeText={(value) => { setEnd(value); setLimit(25); }}
            placeholder="AAAA-MM-JJ" maxLength={10} style={styles.input} />
        </View>
      </View>
      {!validPeriod && <Text style={styles.error}>Vérifie le format AAAA-MM-JJ, l’ordre et les dates futures.</Text>}
      <TextInput accessibilityLabel="Rechercher dans le rapport" placeholder="Plaque, clé, allée, modèle ou bon"
        value={search} onChangeText={(value) => { setSearch(value); setLimit(25); }} style={styles.input} />
      <View style={styles.actions}>
        {statusLabels.map(([value, label]) => (
          <Button key={value} title={label} selected={status === value} onPress={() => { setStatus(value); setLimit(25); }} />
        ))}
      </View>
      {validPeriod && (
        <>
          <Text style={styles.highlight}>{matches.length} séjour(s) · {entries} entrée(s) · {exits} sortie(s)</Text>
          <ExportButtons title="Rapport des véhicules" subtitle={`${context} · ${period}`}
            filename="parko-rapport-vehicules.csv" columns={VEHICLE_COLUMNS}
            disabled={!matches.length} getRows={() => matches.map((visit) => {
              const row = vehicleReportRow(visit, asOf);
              return VEHICLE_REPORT_FIELDS.map(({ key }) => row[key]);
            })} />
          {matches.length === 0 && <Text style={styles.description}>Aucun séjour ne correspond aux filtres.</Text>}
          {matches.slice(0, limit).map((visit) => {
            const row = vehicleReportRow(visit, asOf);
            return (
              <View key={visit.id} style={styles.card}>
                <Text style={styles.label}>{row.plate} · {row.status}</Text>
                {VEHICLE_REPORT_FIELDS.map(({ key, label }) => key !== 'plate' && row[key]
                  ? <Text key={key} style={styles.description}>{label} · {row[key]}</Text> : null)}
              </View>
            );
          })}
          {matches.length > limit && <Button title="Afficher plus de séjours" onPress={() => setLimit((value) => value + 25)} />}
        </>
      )}
    </View>
  );
}

function FinanceReport({ vehicles, asOf }: ReportData) {
  const { width } = useWindowDimensions();
  const today = billingDate(asOf);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [requestedRate, setRequestedRate] = useState('');
  const validMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && month <= today.slice(0, 7);
  const finance = validMonth ? calculateDailyFinance(vehicles, month, asOf, parseRate(requestedRate)) : null;
  const money = (value: number | null) => value === null ? 'Tarif à définir' : formatEuros(value);
  const csvMoney = (value: number | null) => value === null ? '' : (value / 100).toFixed(2).replace('.', ',');
  const createRows = (format: (value: number | null) => string) => (finance?.days ?? []).map((day) => [
    day.date, day.entries, day.exits, day.stored, format(day.entryRevenue), format(day.exitRevenue),
    format(day.storageRevenue), format(day.services), format(day.total), format(day.cumulative), day.present,
  ]);
  const rows = createRows(money);

  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.title}>Suivi financier</Text>
      <Text style={styles.description}>{STORAGE_DAY_LABEL} Les montants sont hors taxes.</Text>
      <Text style={styles.label}>Mois</Text>
      <TextInput accessibilityLabel="Mois du suivi financier" value={month} onChangeText={(value) => {
        setMonth(value);
        setRequestedRate('');
      }} placeholder="AAAA-MM" maxLength={7} style={styles.input} />
      {!validMonth && <Text style={styles.error}>Saisis un mois en cours ou passé, au format AAAA-MM.</Text>}
      {finance && (
        <>
          <View style={styles.summary}>
            <Text style={styles.highlight}>CA du mois · {money(finance.statement.total)}</Text>
            <Text style={styles.description}>
              {finance.statement.receipts} entrées · {finance.statement.releases} sorties · {finance.statement.storageDays} jours-véhicules
            </Text>
            {finance.storageRate !== null && (
              <Text style={styles.description}>Stockage · {formatEuros(finance.storageRate)} HT par véhicule et par jour</Text>
            )}
          </View>
          {finance.statement.storageDays > 0 && (finance.statement.receipts === 0 || finance.statement.receipts > 200) && (
            <>
              <Text style={styles.label}>Tarif de stockage convenu pour ce relevé</Text>
              <TextInput accessibilityLabel="Tarif de stockage convenu" keyboardType="decimal-pad"
                placeholder="Ex. 1,80" value={requestedRate} onChangeText={setRequestedRate} style={styles.input} />
            </>
          )}
          <ExportButtons title={`Suivi financier · ${month}`}
            subtitle={`CA du mois HT · ${money(finance.statement.total)} · arrêté au ${today}`}
            filename={`parko-suivi-financier-${month}.csv`} columns={financeColumns}
            getRows={(kind) => kind === 'csv' ? createRows(csvMoney) : rows} disabled={!rows.length || finance.statement.needsRate} />
          {width >= 760 ? (
            <ScrollView horizontal accessibilityLabel="Tableau du suivi financier">
              <View style={styles.table}>
                <View style={styles.tableHeader}>
                  {financeColumns.map((label) => <Text key={label} style={[styles.tableCell, styles.label]}>{label}</Text>)}
                </View>
                {rows.map(([date, ...values]) => (
                  <View key={date} style={styles.tableRow}>
                    <Text style={[styles.tableCell, styles.label]}>{date}</Text>
                    {values.map((value, index) => (
                      <Text key={financeColumns[index + 1]} style={styles.tableCell}>{value}</Text>
                    ))}
                  </View>
                ))}
              </View>
            </ScrollView>
          ) : [...finance.days].reverse().map((day) => (
            <View key={day.date} style={styles.card}>
              <Text style={styles.label}>{day.date} · {money(day.total)} HT</Text>
              <Text style={styles.description}>{day.entries} entrée(s) · {day.exits} sortie(s) · {day.stored} stocké(s) · {day.present} présent(s) fin de jour</Text>
              <Text style={styles.description}>Entrées {money(day.entryRevenue)} · Sorties {money(day.exitRevenue)}</Text>
              <Text style={styles.description}>Stockage {money(day.storageRevenue)} · Prestations {money(day.services)}</Text>
              <Text style={styles.label}>Cumul du mois · {money(day.cumulative)} HT</Text>
            </View>
          ))}
        </>
      )}
    </View>
  );
}

export function Reports({ kind, cloud, vehicles, asOf, localError }: {
  kind: ReportKind; cloud?: CloudRegister; vehicles: Vehicle[]; asOf: number; localError: string | null;
}) {
  const [remote, setRemote] = useState<(ReportsSnapshot & { deviceAsOf: number }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    if (!cloud) return;
    const controller = new AbortController();
    void readCloudReports(cloud, controller.signal).then((snapshot) => {
      if (!controller.signal.aborted) setRemote({ ...snapshot, deviceAsOf: Date.now() });
    }).catch((problem: unknown) => {
      if (!controller.signal.aborted) setError(problem instanceof Error ? problem.message : 'Chargement impossible.');
    }).finally(() => {
      if (!controller.signal.aborted) setRefreshing(false);
    });
    return () => controller.abort();
  }, [cloud, attempt]);

  const data = cloud ? remote && { vehicles: remote.vehicles, asOf: remote.deviceAsOf } : { vehicles, asOf };
  const problem = cloud ? error : localError;
  return (
    <View style={styles.section}>
      {cloud && (
        <Button title={refreshing ? 'Actualisation…' : 'Actualiser les rapports'} disabled={refreshing || (!remote && !error)} onPress={() => {
          setRefreshing(true);
          setError(null);
          setAttempt((value) => value + 1);
        }} />
      )}
      {remote && !problem && <Text style={styles.description}>Données arrêtées au {reportDateTime(remote.asOf)}</Text>}
      {problem ? <Text accessibilityRole="alert" style={styles.error}>{problem}</Text>
        : !data ? <ActivityIndicator accessibilityLabel="Chargement des rapports" color={COLORS.orangeDark} />
          : kind === 'vehicles' ? <VehicleReport {...data} /> : <FinanceReport {...data} />}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 12 },
  title: { color: COLORS.ink, fontSize: 23, fontWeight: '800' },
  label: { color: COLORS.ink, fontWeight: '800' },
  highlight: { color: COLORS.ink, fontSize: 16, fontWeight: '800' },
  description: { color: COLORS.muted },
  error: { color: COLORS.error },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: 8 },
  field: { flex: 1, minWidth: 110, gap: 4 },
  input: { borderColor: COLORS.border, borderWidth: 1, borderRadius: 10, padding: 11, backgroundColor: COLORS.white, color: COLORS.ink },
  button: { borderColor: COLORS.border, borderWidth: 1, borderRadius: 10, padding: 10, backgroundColor: COLORS.white },
  buttonText: { color: COLORS.ink, fontWeight: '700' },
  selected: { backgroundColor: COLORS.orangeTint, borderColor: COLORS.orange },
  disabled: { opacity: 0.5 },
  summary: { padding: 14, gap: 5, backgroundColor: COLORS.orangeTint, borderRadius: 12 },
  card: { padding: 12, gap: 5, backgroundColor: COLORS.white, borderRadius: 12 },
  table: { backgroundColor: COLORS.white, borderRadius: 12 },
  tableHeader: { flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.orangeTint },
  tableRow: { flexDirection: 'row', borderTopColor: COLORS.border, borderTopWidth: 1 },
  tableCell: { width: 102, padding: 9, color: COLORS.ink },
});
