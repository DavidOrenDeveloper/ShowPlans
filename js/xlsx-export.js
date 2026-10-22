// ייצוא מדידות לאקסל (xlsx מינימלי, בלי ספריות): גיליון סיכום לפי כותרת + גיליון פירוט
import { buildZip } from './zip.js';
import { t as tr } from './i18n.js';
import { downloadBlob } from './util.js';

const esc = (s) => String(s ?? '').replace(/[&<>"\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || ''));
const col = (i) => String.fromCharCode(65 + i);
// תא: מספר → מספר, אחרת מחרוזת. s=1 כותרת מודגשת, s=2 מספר עם 2 ספרות
function cell(v, r, c, s) {
  const ref = col(c) + r, st = s ? ` s="${s}"` : '';
  if (v === null || v === undefined || v === '') return `<c r="${ref}"${st}/>`;
  if (typeof v === 'number' && isFinite(v)) return `<c r="${ref}"${st}><v>${v}</v></c>`;
  return `<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
}
function sheet(rows, widths, numCols = []) {
  const body = rows.map((row, ri) => `<row r="${ri + 1}">${row.map((v, ci) => cell(v, ri + 1, ci, ri === 0 || row.bold ? 1 : (numCols.includes(ci) && typeof v === 'number' ? 2 : 0))).join('')}</row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView rightToLeft="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>${body}</sheetData></worksheet>`;
}
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="0.00"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Arial"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1D4E89"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf/><xf fontId="1" fillId="2" applyFont="1" applyFill="1"><alignment horizontal="center"/></xf><xf numFmtId="164" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

// items: [{ title, type, page, plan, value (במטרים / מ"ר), owner }] → Blob
export async function buildMeasurementsXlsx(items) {
  const kind = (t) => (t === 'area' ? tr('שטח') : t === 'polyline' ? tr('תוואי') : tr('אורך'));
  const detail = [[tr('כותרת'), tr('תוכנית'), tr('עמוד'), tr('סוג'), tr('כמות (מ׳ / מ״ר)'), tr('מודד')]];
  const groups = new Map();
  const sorted = [...items].sort((a, b) => String(a.title || '~').localeCompare(String(b.title || '~'), 'he') || String(a.plan).localeCompare(String(b.plan), 'he') || a.page - b.page);
  for (const it of sorted) {
    const title = it.title || tr('ללא כותרת');
    detail.push([title, it.plan, it.page, kind(it.type), it.value == null ? tr('נדרש כיול') : +it.value.toFixed(3), it.owner || '']);
    const g = groups.get(title + '|' + it.type) || { title, type: it.type, n: 0, sum: 0, missing: 0 };
    g.n++; if (it.value == null) g.missing++; else g.sum += it.value;
    groups.set(title + '|' + it.type, g);
  }
  const sum = [[tr('כותרת'), tr('סוג'), tr('מספר מדידות'), tr('סה״כ (מ׳ / מ״ר)'), tr('בלי כיול')]];
  for (const g of groups.values()) sum.push([g.title, kind(g.type), g.n, +g.sum.toFixed(3), g.missing || '']);
  const lenTotal = [...groups.values()].filter((g) => g.type !== 'area').reduce((a, g) => a + g.sum, 0);
  const r = [tr('סה״כ אורכים'), '', sum.slice(1).filter((x, i) => [...groups.values()][i].type !== 'area').reduce((a, x) => a + x[2], 0), +lenTotal.toFixed(3), '']; r.bold = true;
  sum.push(r);
  const files = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(tr('סיכום'))}" sheetId="1" r:id="rId1"/><sheet name="${esc(tr('פירוט'))}" sheetId="2" r:id="rId2"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: 'xl/styles.xml', data: STYLES },
    { name: 'xl/worksheets/sheet1.xml', data: sheet(sum, [28, 12, 14, 18, 12], [3]) },
    { name: 'xl/worksheets/sheet2.xml', data: sheet(detail, [28, 30, 8, 10, 18, 20], [4]) },
  ];
  const zip = await buildZip(files);
  return zip instanceof Blob ? new Blob([zip], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }) : zip;
}
export async function exportMeasurementsXlsx(items, name) {
  const blob = await buildMeasurementsXlsx(items);
  downloadBlob(blob, `${String(name || 'measurements').replace(/[\\/:*?"<>|]+/g, '_')}.xlsx`);
}
