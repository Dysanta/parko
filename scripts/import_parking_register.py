"""Generate an administrative Supabase SQL preview or import from the REGISTRE sheet."""

import argparse
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
import posixpath
import re
import sys
import unicodedata
from uuid import UUID
from xml.etree import ElementTree
from zipfile import ZipFile

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
COLUMNS = {
    "A": "Date entrée", "B": "Immatriculation", "C": "N° de clé", "D": "Allée",
    "E": "Date sortie", "L": "Marque", "M": "N° bon de chargement pour sortie",
}


def workbook_rows(path):
    with ZipFile(path) as book:
        workbook = ElementTree.fromstring(book.read("xl/workbook.xml"))
        sheet = next((item for item in workbook.findall(".//m:sheet", NS) if item.get("name") == "REGISTRE"), None)
        if sheet is None:
            raise ValueError("L’onglet REGISTRE est absent.")
        props = workbook.find("m:workbookPr", NS)
        epoch = datetime(1904, 1, 1) if props is not None and props.get("date1904") in ("1", "true") else datetime(1899, 12, 30)
        relations = ElementTree.fromstring(book.read("xl/_rels/workbook.xml.rels"))
        targets = {item.get("Id"): item.get("Target") for item in relations}
        target = targets[sheet.get(REL + "id")]
        filename = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join("xl", target))
        strings = []
        if "xl/sharedStrings.xml" in book.namelist():
            strings = [
                "".join(part.text or "" for part in item.findall(".//m:t", NS))
                for item in ElementTree.fromstring(book.read("xl/sharedStrings.xml"))
            ]
        formats = {}
        styles = []
        if "xl/styles.xml" in book.namelist():
            style_sheet = ElementTree.fromstring(book.read("xl/styles.xml"))
            formats = {item.get("numFmtId"): item.get("formatCode") for item in style_sheet.findall("m:numFmts/m:numFmt", NS)}
            styles = [item.get("numFmtId", "0") for item in style_sheet.findall("m:cellXfs/m:xf", NS)]

        def cell_text(cell):
            value = cell.findtext("m:v", "", NS)
            kind = cell.get("t")
            if kind == "s":
                return strings[int(value)].strip()
            if kind == "inlineStr":
                return "".join(part.text or "" for part in cell.findall(".//m:t", NS)).strip()
            if cell.get("r", "").startswith("C") and value.isdigit() and styles:
                pattern = formats.get(styles[int(cell.get("s", "0"))], "")
                if re.fullmatch(r"0+", pattern):
                    return value.zfill(len(pattern))
            return value.strip()

        sheet_xml = ElementTree.fromstring(book.read(filename))
        for row in sheet_xml.findall("m:sheetData/m:row", NS):
            cells = {
                column: cell_text(cell)
                for cell in row.findall("m:c", NS)
                if (column := re.sub(r"\d+$", "", cell.get("r", ""))) in COLUMNS
            }
            yield int(row.get("r")), cells, epoch


def excel_datetime(raw, epoch):
    if not raw:
        return None, False
    try:
        serial = Decimal(raw)
        if not serial.is_finite() or not 0 < serial < 2_958_466:
            raise ValueError(raw)
        seconds = int((serial * 86_400).to_integral_value())
        date = epoch + timedelta(seconds=seconds)
        return date.isoformat(sep=" "), bool(seconds % 86_400)
    except InvalidOperation:
        date = datetime.fromisoformat(raw)
        if date.tzinfo is not None:
            raise ValueError("Utiliser une heure locale de Paris.")
        return date.isoformat(sep=" "), "T" in raw or " " in raw


def read_register(path):
    header_found = False
    for line, cells, epoch in workbook_rows(path):
        if line == 4:
            if any(cells.get(column, "").casefold() != title.casefold() for column, title in COLUMNS.items()):
                raise ValueError("Les en-têtes de la ligne 4 diffèrent du registre Perfect Park.")
            header_found = True
        if line < 5 or not any(cells.values()):
            continue
        normalize = lambda text: unicodedata.normalize("NFKC", text).strip().upper()
        plate = "".join(c for c in normalize(cells.get("B", "")) if not c.isspace() and c != "." and unicodedata.category(c) != "Pd")
        key, aisle, note = (normalize(cells.get(column, "")) for column in ("C", "D", "M"))
        model = cells.get("L", "") or None
        errors = []
        for value, pattern, label in (
            (plate, None, "Immatriculation invalide"),
            (key, r"[A-Z0-9][A-Z0-9-]{0,31}", "Numéro de clé manquant ou invalide"),
            (aisle, r"[A-T]", "Allée manquante ou invalide"),
            (note or "A", r"[A-Z0-9][A-Z0-9./_-]{0,63}", "Numéro de bon invalide"),
        ):
            valid = re.fullmatch(pattern, value) if pattern else 0 < len(value) <= 32 and value.isalnum()
            if not valid:
                errors.append(label)
        if model and len(model) > 100:
            errors.append("Marque / modèle trop long")
        times = []
        for column, required in (("A", True), ("E", False)):
            try:
                date, known = excel_datetime(cells.get(column, ""), epoch)
                if date is None and required:
                    errors.append("Date d’entrée manquante")
                times.extend((date, known))
            except (ValueError, OverflowError):
                errors.append(f"Date colonne {column} invalide")
                times.extend((None, False))
        yield (line, plate, key, aisle, model, note or None, *times, " / ".join(errors) or None)
    if not header_found:
        raise ValueError("En-têtes du registre introuvables.")


def literal(value):
    if value is None:
        return "null"
    if isinstance(value, bool):
        return str(value).lower()
    if isinstance(value, int):
        return str(value)
    return "E'" + value.replace("\x00", "").replace("\\", "\\\\").replace("'", "''") + "'"


def generate(rows, parking, apply):
    fields = [
        ("line", "integer"), ("plate", "text"), ("key_number", "text"), ("aisle", "text"),
        ("make_model", "text"), ("loading_note", "text"), ("entered_on", "timestamp"),
        ("entered_time_known", "boolean"), ("exited_on", "timestamp"),
        ("exited_time_known", "boolean"), ("source_error", "text"),
    ]
    names = ", ".join(name for name, _ in fields)
    values = ",\n".join(
        "(" + ", ".join(f"{literal(value)}::{kind}" for value, (_, kind) in zip(row, fields)) + ")"
        for row in rows
    )
    reconciliation = f"""with source_visits ({names}) as (values
{values}
), candidates as (
  select source.*, match.ids, matched.id as existing_id, matched.exited_at as existing_exit,
    matched.key_number as existing_key, matched.aisle as existing_aisle,
    matched.make_model as existing_model, matched.loading_note as existing_note
  from source_visits source
  cross join lateral (
    select array_agg(v.id order by v.id) as ids
    from public.parking_visits v
    where v.parking_id = '{parking}'::uuid and v.plate = source.plate
      and (v.entered_at at time zone 'Europe/Paris')::date = source.entered_on::date
  ) match
  left join public.parking_visits matched on matched.id = match.ids[1]
)
select source.*,
  case
    when not exists (select 1 from public.parkings where id = '{parking}'::uuid) then 'Parking introuvable'
    when source_error is not null then source_error
    when exited_on < entered_on then 'Sortie antérieure à l’entrée'
    when greatest(entered_on, exited_on) > (now() at time zone 'Europe/Paris') then 'Mouvement à une date future'
    when cardinality(ids) > 1 or exists (
      select 1 from source_visits other where other.line <> source.line and other.plate = source.plate
        and other.entered_on::date = source.entered_on::date
    ) then 'Plusieurs séjours pour la plaque et la date d’entrée'
    when existing_id is not null and
      (existing_exit at time zone 'Europe/Paris')::date is distinct from exited_on::date
      then 'La sortie ne correspond pas au séjour Parko'
    when existing_id is not null and
      (coalesce(existing_key <> key_number, false) or coalesce(existing_aisle <> aisle, false)
      or coalesce(existing_model <> make_model, false) or coalesce(existing_note <> loading_note, false))
      then 'Des informations diffèrent du séjour Parko'
    when exited_on is null and (
      exists (select 1 from source_visits other where other.line <> source.line and other.exited_on is null
        and (other.plate = source.plate or other.key_number = source.key_number))
      or exists (select 1 from public.parking_visits v where v.parking_id = '{parking}'::uuid
        and v.exited_at is null and v.id is distinct from source.existing_id
        and (v.plate = source.plate or v.key_number = source.key_number))
    ) then 'Plaque ou clé déjà présente dans un autre séjour'
  end as obstacle
from candidates source"""
    summary = """select line as ligne_excel, plate as immatriculation, entered_on::date as date_entree,
  case when obstacle is not null then 'À vérifier'
    when existing_id is not null then 'Rapprochement Parko' else 'Nouveau séjour' end as action,
  obstacle, concat_ws(' / ',
    case when make_model is null then 'Marque / modèle à compléter' end,
    case when exited_on is not null and loading_note is null then 'Bon de chargement manquant' end
  ) as observations
from reconciliation order by line;"""
    if not apply:
        return f"-- APERÇU — lecture seule\nwith reconciliation as (\n{reconciliation}\n)\n{summary}\n"
    return f"""-- IMPORT
begin;
lock table public.parking_visits in share row exclusive mode;
create temporary table reconciliation on commit drop as
{reconciliation};
{apply_sql(parking)}
commit;
"""


def apply_sql(parking):
    return f"""
update public.parking_visits v
set key_number = coalesce(v.key_number, source.key_number),
    aisle = coalesce(v.aisle, source.aisle),
    make_model = coalesce(v.make_model, source.make_model),
    loading_note = coalesce(v.loading_note, source.loading_note)
from reconciliation source where source.obstacle is null and v.id = source.existing_id;

insert into public.parking_visits (
  id, parking_id, plate, key_number, aisle, make_model, loading_note,
  entered_at, entered_time_known, entered_by, exited_at, exited_time_known, exited_by
)
select gen_random_uuid(), '{parking}'::uuid, plate, key_number, aisle, make_model, loading_note,
  entered_on at time zone 'Europe/Paris', entered_time_known, null,
  exited_on at time zone 'Europe/Paris', exited_time_known, null
from reconciliation where obstacle is null and existing_id is null;
"""


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workbook", type=Path)
    parser.add_argument("--parking-id", type=UUID, required=True)
    parser.add_argument("--apply-ready-rows", action="store_true", help="Générer un SQL qui applique les lignes prêtes.")
    args = parser.parse_args()
    try:
        rows = list(read_register(args.workbook))
        if not rows:
            raise ValueError("Le registre est vide.")
        sys.stdout.write(generate(rows, args.parking_id, args.apply_ready_rows))
    except (OSError, ValueError, KeyError) as error:
        parser.exit(1, f"{error}\n")
