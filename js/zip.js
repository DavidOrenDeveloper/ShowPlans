// כתיבה וקריאה של קבצי ZIP (ללא דחיסה – קבצי PDF כבר דחוסים). תואם ZIP סטנדרטי, שמות בקידוד UTF-8.

const T = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, prev = 0) {
  let c = ~prev >>> 0;
  for (let i = 0; i < bytes.length; i++) c = T[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8');
const LIM = 0xffffffff;

function dosDT(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return [time & 0xffff, date & 0xffff];
}

// entries: [{ name, data: Blob | string | Uint8Array }]
export async function buildZip(entries, onProgress) {
  const parts = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const [dt, dd] = dosDT(now);
  let i = 0;
  for (const e of entries) {
    onProgress?.(i++, entries.length, e.name);
    let data = e.data;
    if (typeof data === 'string') data = enc.encode(data);
    let bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
    const size = bytes.length;
    const crc = crc32(bytes);
    bytes = null;
    if (size > LIM || offset > LIM) throw new Error('הגיבוי גדול מדי (מעל 4GB). אפשר לגבות בחלקים – לייצא תיקיות נפרדות.');
    const nameBytes = enc.encode(e.name);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, 0, true);
    lh.setUint16(10, dt, true);
    lh.setUint16(12, dd, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true);
    lh.setUint32(22, size, true);
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0, true);
    parts.push(lh.buffer, nameBytes, data);
    central.push({ nameBytes, crc, size, offset });
    offset += 30 + nameBytes.length + size;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) {
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, dt, true);
    ch.setUint16(14, dd, true);
    ch.setUint32(16, c.crc, true);
    ch.setUint32(20, c.size, true);
    ch.setUint32(24, c.size, true);
    ch.setUint16(28, c.nameBytes.length, true);
    ch.setUint16(30, 0, true);
    ch.setUint16(32, 0, true);
    ch.setUint16(34, 0, true);
    ch.setUint16(36, 0, true);
    ch.setUint32(38, 0, true);
    ch.setUint32(42, c.offset, true);
    parts.push(ch.buffer, c.nameBytes);
    cdSize += 46 + c.nameBytes.length;
  }
  if (cdStart + cdSize > LIM) throw new Error('הגיבוי גדול מדי (מעל 4GB).');
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, central.length, true);
  end.setUint16(10, central.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, cdStart, true);
  parts.push(end.buffer);
  return new Blob(parts, { type: 'application/zip' });
}

export async function readZip(blob) {
  const size = blob.size;
  if (size < 22) throw new Error('הקובץ אינו ZIP תקין');
  const tailLen = Math.min(size, 65557);
  const tail = new DataView(await blob.slice(size - tailLen, size).arrayBuffer());
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('הקובץ אינו ZIP תקין (לא נמצא סוף הארכיון)');
  const count = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdOff = tail.getUint32(eocd + 16, true);
  if (cdSize === LIM || cdOff === LIM || count === 0xffff) throw new Error('ארכיוני ZIP64 אינם נתמכים');
  const cd = new DataView(await blob.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const entries = new Map();
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (cd.getUint32(p, true) !== 0x02014b50) throw new Error('ספריית ה-ZIP פגומה');
    const method = cd.getUint16(p + 10, true);
    const crc = cd.getUint32(p + 16, true);
    const csize = cd.getUint32(p + 20, true);
    const usize = cd.getUint32(p + 24, true);
    const nlen = cd.getUint16(p + 28, true);
    const elen = cd.getUint16(p + 30, true);
    const clen = cd.getUint16(p + 32, true);
    const off = cd.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, p + 46, nlen));
    entries.set(name, { name, method, crc, csize, usize, offset: off });
    p += 46 + nlen + elen + clen;
  }
  async function dataStart(e) {
    const lh = new DataView(await blob.slice(e.offset, e.offset + 30).arrayBuffer());
    if (lh.getUint32(0, true) !== 0x04034b50) throw new Error('כותרת קובץ פגומה ב-ZIP');
    return e.offset + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
  }
  async function getBlob(name) {
    const e = entries.get(name);
    if (!e) throw new Error('חסר קובץ בארכיון: ' + name);
    const s = await dataStart(e);
    const raw = blob.slice(s, s + e.csize);
    if (e.method === 0) return raw;
    if (e.method === 8 && typeof DecompressionStream !== 'undefined') {
      return new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
    }
    throw new Error('שיטת דחיסה לא נתמכת בקובץ: ' + name);
  }
  async function getText(name) { return dec.decode(await (await getBlob(name)).arrayBuffer()); }
  async function checkCRC(name) {
    const b = await getBlob(name);
    const e = entries.get(name);
    return crc32(new Uint8Array(await b.arrayBuffer())) === e.crc && b.size === e.usize;
  }
  return { entries, getBlob, getText, checkCRC };
}
