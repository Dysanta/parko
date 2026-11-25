import { printToFileAsync } from 'expo-print';
import { isAvailableAsync, shareAsync } from 'expo-sharing';
import { Platform } from 'react-native';
import { File, Paths } from 'expo-file-system';
import { PROVIDER, SERVICES, STORAGE_DAY_LABEL, formatEuros, type Statement } from './billing';
import type { Vehicle } from './cloudRegister';
import { formatReleaseNumber, type ReleaseDocument } from './loadingNote';
import { serializeReportCsv } from './reportData';
import { COLORS } from './theme';

function escapeHtml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function tableRow(values: (string | number)[]) {
  return '<tr>' + values.map((value) => '<td>' + escapeHtml(String(value)) + '</td>').join('') + '</tr>';
}

export function statementHtml(statement: Statement) {
  if (statement.total === null) throw new Error('Renseigne le tarif de stockage avant l’export.');
  const summary = statement.rows.filter((row) => row.quantity).map((row) => tableRow([
    row.label, `${row.quantity} ${row.unit}`, formatEuros(row.rate ?? 0), formatEuros(row.quantity * (row.rate ?? 0)),
  ])).join('');
  const detail = statement.visits.map((visit) => tableRow([
    visit.plate, visit.entryDay, visit.exitDay ?? 'En cours', visit.days, visit.received, visit.released,
    visit.services.map(({ kind, performedOn }) => `${performedOn} · ${SERVICES[kind].label}`).join(' / '),
    formatEuros(visit.cents ?? 0),
  ])).join('');
  const dated = new Date(statement.asOf).toLocaleString('fr-FR');
  return printableHtml(`Relevé HT ${statement.month}`, `
    <h1>Relevé mensuel HT · ${statement.month}</h1>
    <p>${PROVIDER} · Relevé du parking</p>
    <p>Brouillon établi le ${dated} (heure locale)</p>
    <p>${STORAGE_DAY_LABEL} ${statement.receipts} entrées effectives dans le mois.</p>
    <table><thead><tr><th>Libellé</th><th>Quantité</th><th>Prix unitaire HT</th><th>Montant HT</th></tr></thead>
    <tbody>${summary || tableRow(['Aucune prestation facturable', '—', '—', '—'])}</tbody></table>
    <h2>Total HT · ${formatEuros(statement.total)}</h2>
    <h2>Détail des séjours</h2>
    <table><thead><tr><th>Plaque</th><th>Entrée</th><th>Sortie</th><th>Jours</th><th>Entrées</th><th>Sorties</th>
    <th>Prestations réalisées</th><th>Total HT</th></tr></thead><tbody>${detail}</tbody></table>`);
}

function printableHtml(title: string, content: string, landscape = false) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
    <style>
      @page { size: A4${landscape ? ' landscape' : ''}; margin: 14mm; }
      body { font: 12px system-ui, sans-serif; color: ${COLORS.ink}; }
      h1 { color: ${COLORS.ink}; border-bottom: 2px solid ${COLORS.orange}; padding-bottom: 7px; }
      table { border-collapse: collapse; width: 100%; margin-bottom: 16px; }
      th, td { padding: 7px 5px; text-align: left; border-bottom: 1px solid ${COLORS.border}; overflow-wrap: anywhere; }
      thead { display: table-header-group; } tr { break-inside: avoid; }
      @media print { .print { display: none; } }
    </style></head><body>
    ${content}
    <button class="print" type="button">Imprimer ou enregistrer en PDF</button>
    </body></html>`;
}

export function exportReportPdf(title: string, subtitle: string, columns: readonly string[], rows: (string | number)[][]) {
  const headers = columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('');
  return exportPrintable(printableHtml(title, `
    <h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p>
    <table><thead><tr>${headers}</tr></thead><tbody>${rows.map(tableRow).join('')}</tbody></table>
  `, true));
}

export async function exportReportCsv(filename: string, columns: readonly string[], rows: (string | number)[][]) {
  const csv = '\uFEFF' + serializeReportCsv(columns, rows);
  if (Platform.OS === 'web') {
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
    return;
  }
  if (!await isAvailableAsync()) throw new Error('Le partage du CSV est indisponible sur cet appareil.');
  const file = new File(Paths.cache, filename);
  file.create({ overwrite: true });
  file.write(csv);
  await shareAsync(file.uri, { mimeType: 'text/csv', UTI: 'public.comma-separated-values-text' });
}

export function exportStatement(statement: Statement) {
  return exportPrintable(statementHtml(statement));
}

export function exportExitReport(day: string, vehicles: Vehicle[]) {
  const rows = vehicles.map((visit) => tableRow([
    visit.loadingNote ?? '—', visit.plate, visit.makeModel ?? '—', visit.aisle ?? '—', visit.keyNumber ?? '—',
  ])).join('');
  return exportPrintable(printableHtml(`Rapport des sorties · ${day}`, `
    <h1>Rapport des sorties</h1>
    <p>${PROVIDER} · ${escapeHtml(day)} · ${vehicles.length} véhicule(s)</p>
    <table><thead><tr><th>N° bon de chargement</th><th>Immatriculation</th><th>Marque / modèle</th>
    <th>Allée / zone</th><th>N° de clé</th></tr></thead><tbody>${rows}</tbody></table>`));
}

export function exportLoadingRelease(document: ReleaseDocument) {
  const number = formatReleaseNumber(document.number);
  const date = document.pickupDate.split('-').reverse().join('/');
  const rows = document.rows.map((vehicle) => tableRow([
    document.reference, vehicle.plate, vehicle.makeModel, vehicle.aisle, vehicle.keyNumber,
  ])).join('');
  return exportPrintable(printableHtml(`Bon de sortie n° ${number}`, `
    <style>
      .release h1, .release th { color: ${COLORS.white}; background: ${COLORS.ink}; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
      .release h1 { font-size: 19px; padding: 12px; }
      .release th { text-align: center; }
      .release th, .release td { padding: 9px 6px; }
      .release table { margin-top: 22px; }
      .release td:nth-last-child(-n+2) { text-align: center; }
      .release .reference, .release .transport { color: ${COLORS.muted}; font-style: italic; }
      .release dl { display: grid; grid-template-columns: 190px auto; gap: 5px 10px; }
      .release dd { margin: 0; color: ${COLORS.orangeDark}; font-weight: bold; }
    </style>
    <section class="release">
      <h1>${PROVIDER} | BON DE SORTIE N° ${number}</h1>
      <p class="reference">Bon de chargement n° ${escapeHtml(document.reference)}</p>
      <dl>
        <dt>N° de lot</dt><dd>${escapeHtml(document.lot)}</dd>
        <dt>Ensemble constitué</dt><dd class="transport">${escapeHtml(document.transport)}</dd>
        <dt>Nombre de véhicules à transporter</dt><dd>${document.rows.length}</dd>
        <dt>Lieu d’enlèvement</dt><dd>${escapeHtml(document.pickupLocation ?? '—')}</dd>
        <dt>Date de sortie</dt><dd>${escapeHtml(date)}</dd>
      </dl>
      <table><thead><tr><th>N° BON DE CHARGEMENT</th><th>IMMATRICULATION</th><th>MARQUE</th>
      <th>ALLÉE / ZONE</th><th>N° DE CLÉ</th></tr></thead><tbody>${rows}</tbody></table>
    </section>`));
}

async function exportPrintable(html: string) {
  if (Platform.OS === 'web') {
    const tab = window.open('', '_blank');
    if (!tab) {
      throw new Error('Autorise l’ouverture d’un onglet pour afficher le relevé.');
    }
    tab.opener = null;
    // The generated document escapes register data. Bind printing without an inline script.
    tab.document.open();
    tab.document.write(html);
    tab.document.close();
    tab.document.querySelector('.print')?.addEventListener('click', () => tab.print());
    return;
  }
  if (!await isAvailableAsync()) throw new Error('Le partage de PDF est indisponible sur cet appareil.');
  const { uri } = await printToFileAsync({ html });
  await shareAsync(uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf' });
}
