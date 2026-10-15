"""Read an .xlsx with the Python standard library only, for the import-people
skill. Writes one JSON file, {sheet name: [{"row": n, "cells": {"A": value}}]},
and prints each sheet's row count. Date-formatted numbers become YYYY-MM-DD.

Usage: python3 -I read_xlsx.py <downloaded.xlsx> <out.json>

The JSON holds every cell of the sheet, minors' personal data included: write
it only to the session scratchpad, never into the repo, and delete it when the
import is done."""
import json, re, sys, zipfile, datetime
import xml.etree.ElementTree as ET

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
      "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}
REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"
DATE_IDS = set(range(14, 23)) | {45, 46, 47}

def text(el):
    return "".join(t.text or "" for t in el.iter("{%s}t" % NS["m"]))

def main(src, out):
    z = zipfile.ZipFile(src)
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
            shared.append(text(si))
    date_styles = set()
    st = ET.fromstring(z.read("xl/styles.xml"))
    custom = {}
    for nf in st.findall("m:numFmts/m:numFmt", NS):
        custom[int(nf.get("numFmtId"))] = nf.get("formatCode", "")
    for i, xf in enumerate(st.findall("m:cellXfs/m:xf", NS)):
        fid = int(xf.get("numFmtId", "0"))
        code = custom.get(fid, "")
        if fid in DATE_IDS or (code and re.search(r"[yd]", re.sub(r'"[^"]*"', "", code), re.I)):
            date_styles.add(i)
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels")).iter(REL + "Relationship")}
    result = {}
    for sh in wb.findall("m:sheets/m:sheet", NS):
        target = rels[sh.get("{%s}id" % NS["r"])].lstrip("/")
        path = target if target.startswith("xl/") else "xl/" + target
        rows = []
        for r in ET.fromstring(z.read(path)).iter("{%s}row" % NS["m"]):
            cells = {}
            for c in r.findall("m:c", NS):
                col = re.match(r"[A-Z]+", c.get("r")).group(0)
                t, s = c.get("t"), int(c.get("s", "0"))
                v = c.find("m:v", NS)
                if t == "s" and v is not None:
                    val = shared[int(v.text)]
                elif t == "inlineStr":
                    val = text(c)
                elif v is None:
                    continue
                elif t in ("str", "b", "e"):
                    val = v.text or ""
                elif s in date_styles:
                    val = (datetime.date(1899, 12, 30) + datetime.timedelta(days=float(v.text))).isoformat()
                else:
                    n = float(v.text)
                    val = str(int(n)) if n.is_integer() else v.text
                if val != "":
                    cells[col] = val
            if cells:
                rows.append({"row": int(r.get("r")), "cells": cells})
        result[sh.get("name")] = rows
    json.dump(result, open(out, "w"), ensure_ascii=False, indent=1)
    for name, rows in result.items():
        last = rows[-1]["row"] if rows else 0
        print(f"{name}: {len(rows)} non-empty rows, last row {last}")

main(sys.argv[1], sys.argv[2])
