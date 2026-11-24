import { decodePDFRawStream, PDFArray, PDFDocument, PDFRawStream } from 'pdf-lib/cjs/index';
import { validBillingDate } from './billing';
import type { LoadingNote, LoadingVehicle } from './loadingNote';

type TextLine = { x: number; y: number; text: string };

// The source template uses WinAnsi, with one text object per printed line.
function winAnsiLiteral(value: string) {
  return value.replace(/\\([0-7]{1,3}|\r?\n|.)/gs, (_, token: string) => {
    if (/^[0-7]/.test(token)) return String.fromCharCode(parseInt(token, 8));
    if (token.includes('\n')) return '';
    return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[token] ?? token;
  });
}

function textLines(stream: string, pageWidth: number): TextLine[] {
  const lines: TextLine[] = [];
  for (const [, block] of stream.matchAll(/\bBT\s+([\s\S]*?)\bET\b/g)) {
    const origin = /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+Td\b/.exec(block);
    if (!origin) continue;
    const text = [...block.matchAll(/\(((?:\\[\s\S]|[^\\()])*)\)\s*(?:Tj\b|')/g)]
      .map(([, literal]) => winAnsiLiteral(literal)).join('').replace(/\s+/g, ' ').trim();
    if (text) lines.push({ x: Number(origin[1]) * 842 / pageWidth, y: Number(origin[2]), text });
  }
  return lines;
}

function fieldParts(lines: TextLine[], label: RegExp, gap = 40) {
  const heading = lines.find(({ text }) => label.test(text));
  return heading ? lines
    .filter(({ x, y }) => x >= heading.x + gap && Math.abs(y - heading.y) <= 1.25)
    .sort((left, right) => left.x - right.x).map(({ text }) => text) : [];
}

function field(lines: TextLine[], label: RegExp, gap = 40) {
  return fieldParts(lines, label, gap)[0];
}

function readVehicles(lines: TextLine[]) {
  const vehicles: LoadingVehicle[] = [];
  const identityColumn = lines.filter(({ x }) => x >= 268 && x <= 367);
  for (const reference of identityColumn.filter(({ text }) => /^VEH[A-Z0-9]+$/i.test(text))) {
    const vin = identityColumn.find(({ y, text }) =>
      y < reference.y - 3 && y > reference.y - 14 && /^[A-HJ-NPR-Z0-9]{17}$/i.test(text),
    );
    const plate = vin && identityColumn.find(({ y, text }) =>
      y < vin.y - 3 && y > vin.y - 14 && /^[A-Z0-9][A-Z0-9 .\-]{3,17}$/i.test(text),
    );
    const makeModel = lines.filter(({ x, y }) => x >= 102 && x < 267 && Math.abs(y - reference.y) <= 1.5)
      .sort((a, b) => a.x - b.x).map(({ text }) => text).join(' ');
    if (!plate || !makeModel) throw new Error('Une ligne véhicule du bon est incomplète ou illisible.');
    vehicles.push({ plate: plate.text.normalize('NFKC').toUpperCase().replace(/[\s.-]+/g, ''), makeModel });
  }
  return vehicles;
}

export async function readLoadingNotePdf(bytes: Uint8Array): Promise<LoadingNote> {
  if (!bytes.length || bytes.length > 5_000_000) throw new Error('Choisis un bon PDF de moins de 5 Mo.');
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = pdf.getPages();
  if (pages.length > 12) throw new Error('Le bon comporte trop de pages.');
  const pageLines = pages.map((page) => {
    const content = page.node.Contents();
    const streams = content instanceof PDFArray
      ? Array.from({ length: content.size() }, (_, index) => content.lookup(index))
      : [content];
    const lines: TextLine[] = [];
    for (const stream of streams) {
      if (!(stream instanceof PDFRawStream)) continue;
      const decoded = decodePDFRawStream(stream).getBytes(1_000_001);
      if (decoded.length > 1_000_000) throw new Error('Le contenu du bon est trop volumineux.');
      let source = '';
      for (let index = 0; index < decoded.length; index += 8192) {
        source += String.fromCharCode(...decoded.subarray(index, index + 8192));
      }
      lines.push(...textLines(source, page.getWidth()));
    }
    return lines;
  });

  const first = pageLines[0] ?? [];
  const reference = field(first, /^Bon de chargement n°/i);
  const lot = field(first, /^N° de lot\s*:/i);
  const pickup = field(first, /^Date d['’]enlèvement\s*:/i);
  const transport = field(first, /^Ensemble constitué\s*:/i);
  const pickupLocation = fieldParts(first, /^Lieu d['’]enlèvement\s*:/i).join(' ');
  const count = Number(field(first, /^Nombre de véhicules à transporter\s*:/i, 100));
  const date = pickup && /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(pickup);
  const pickupDate = date ? `${date[3]}-${date[2]}-${date[1]}` : '';
  if (!reference || !/^BOTP\d+$/.test(reference) || !lot || !transport || !validBillingDate(pickupDate) ||
    !Number.isInteger(count) || count < 1 || count > 200) {
    throw new Error('Le PDF doit être un bon de chargement texte au format de l’exemple fourni.');
  }
  const vehicles = pageLines.flatMap(readVehicles);
  if (vehicles.length !== count || new Set(vehicles.map(({ plate }) => plate)).size !== count) {
    throw new Error(`Le bon annonce ${count} véhicule(s). ${vehicles.length} ligne(s) ont été lues. Vérifie le PDF.`);
  }
  return { reference, lot, pickupDate, pickupLocation, transport, vehicles };
}
