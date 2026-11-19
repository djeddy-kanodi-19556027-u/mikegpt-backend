/* =====================================================
   files.js: turns uploaded files into something Gemini can read.
   No extra npm package needed (it has its own small zip reader).

   Gemini reads natively : images, PDF, video, audio
   We convert to text    : txt/md/csv/json/code, Word (.docx), Excel (.xlsx),
                           PowerPoint (.pptx), OpenDocument (.odt), and ZIP archives
   ===================================================== */
const zlib = require('zlib');

const MAX_TEXT_PER_FILE = 150000;     // characters kept from one document
const MAX_TEXT_TOTAL = 400000;        // characters kept from everything sent in one message
const MAX_ZIP_ENTRIES = 60;
const MAX_ZIP_ENTRY_BYTES = 8 * 1024 * 1024;

const TEXT_EXT = new Set(('txt md markdown csv tsv json xml html htm css js mjs cjs ts tsx jsx py java c cpp h hpp cs go rs php rb sql sh bat ps1 yml yaml ini log toml svg env gitignore vue swift kt dart r lua pl').split(' '));
const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' };
const MEDIA_MIME = {
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', avi: 'video/x-msvideo', mpeg: 'video/mpeg', mpg: 'video/mpeg',
  wmv: 'video/x-ms-wmv', flv: 'video/x-flv', '3gp': 'video/3gpp',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac', m4a: 'audio/mp4',
};

const extOf = (name) => (String(name).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';

/* ---------- tiny ZIP reader (docx / xlsx / pptx / zip are all ZIP files) ---------- */
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This is not a valid ZIP file.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    entries.push({
      name, size: usize, dir: name.endsWith('/'), encrypted: Boolean(flags & 1),
      read(limit = MAX_ZIP_ENTRY_BYTES) {
        const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
        const raw = buf.subarray(start, start + csize);
        if (method === 0) return raw;
        if (method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: limit });
        throw new Error('unsupported zip compression');
      },
    });
    p += 46 + nlen + elen + clen;
  }
  return entries;
}

/* ---------- Office documents -> plain text ---------- */
const decodeEntities = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
  .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(+d); } catch { return ''; } })
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const stripTags = (xml) => decodeEntities(xml.replace(/<[^>]+>/g, ''));
const getEntry = (entries, name) => entries.find((e) => e.name === name);
const entryText = (e) => (e ? e.read().toString('utf8') : '');

function docxText(entries) {
  const xml = entryText(getEntry(entries, 'word/document.xml'));
  return stripTags(xml.replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n').replace(/<\/w:p>/g, '\n'))
    .replace(/\n{3,}/g, '\n\n').trim();
}

function pptxText(entries) {
  const slides = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
    .sort((a, b) => parseInt(a.name.match(/(\d+)\.xml$/)[1]) - parseInt(b.name.match(/(\d+)\.xml$/)[1]));
  return slides.map((e, i) => {
    const xml = e.read().toString('utf8').replace(/<\/a:p>/g, '\n');
    const text = stripTags(xml.replace(/<a:t>/g, '').replace(/<a:t\s[^>]*>/g, '')).replace(/\n{2,}/g, '\n').trim();
    return `--- Slide ${i + 1} ---\n${text}`;
  }).join('\n\n');
}

function colIndex(ref) {
  const letters = (ref.match(/^[A-Z]+/i) || ['A'])[0].toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function xlsxText(entries) {
  const shared = [];
  const sst = entryText(getEntry(entries, 'xl/sharedStrings.xml'));
  for (const m of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(stripTags(m[1]));
  const wb = entryText(getEntry(entries, 'xl/workbook.xml'));
  const names = [...wb.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => decodeEntities(m[1]));
  const sheets = entries
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
    .sort((a, b) => parseInt(a.name.match(/(\d+)\.xml$/)[1]) - parseInt(b.name.match(/(\d+)\.xml$/)[1]));
  return sheets.map((e, i) => {
    const xml = e.read().toString('utf8');
    const lines = [];
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const body = c[2] || '';
        const ref = (attrs.match(/\br="([^"]+)"/) || [])[1] || 'A1';
        const type = (attrs.match(/\bt="([^"]+)"/) || [])[1];
        const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        let val = '';
        if (type === 's') val = shared[parseInt(v)] || '';
        else if (type === 'inlineStr') val = stripTags(body);
        else if (type === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
        else if (v !== undefined) val = decodeEntities(v);
        cells[colIndex(ref)] = val;
      }
      if (cells.some((x) => x)) lines.push(Array.from(cells, (x) => x || '').join('\t'));
      if (lines.length >= 1000) { lines.push('... (more rows not shown)'); break; }
    }
    return `--- Sheet: ${names[i] || 'Sheet' + (i + 1)} ---\n${lines.join('\n')}`;
  }).join('\n\n');
}

function odtText(entries) {
  const xml = entryText(getEntry(entries, 'content.xml'));
  return stripTags(xml.replace(/<\/text:(p|h)>/g, '\n')).replace(/\n{3,}/g, '\n\n').trim();
}

/* ---------- Gemini Files API (for video / audio) ---------- */
async function uploadMedia(ai, buf, mime, name) {
  let f = await ai.files.upload({ file: new Blob([buf], { type: mime }), config: { mimeType: mime, displayName: name } });
  const t0 = Date.now();
  while (f.state && String(f.state) !== 'ACTIVE') {
    if (String(f.state) === 'FAILED') throw new Error('Google could not process this media file.');
    if (Date.now() - t0 > 180000) throw new Error('The media file took too long to process.');
    await new Promise((r) => setTimeout(r, 2000));
    f = await ai.files.get({ name: f.name });
  }
  return { fileData: { fileUri: f.uri, mimeType: f.mimeType || mime } };
}

/* ---------- one file -> Gemini parts ---------- */
async function processOne(ai, file, ctx) {
  const { name, buf } = file;
  const ext = extOf(name);
  const parts = [];
  const textPart = (label, text) => {
    text = String(text || '').trim();
    if (!text) { ctx.notes.push(`${name}: no readable text was found in this file.`); return; }
    if (text.length > MAX_TEXT_PER_FILE) { text = text.slice(0, MAX_TEXT_PER_FILE) + '\n... (file cut: too long)'; }
    if (ctx.textLeft <= 0) { ctx.notes.push(`${name}: skipped (too much text already).`); return; }
    if (text.length > ctx.textLeft) text = text.slice(0, ctx.textLeft) + '\n... (cut)';
    ctx.textLeft -= text.length;
    parts.push({ text: `[${label}: ${name}]\n${text}\n[end of ${name}]` });
  };

  try {
    if (IMAGE_MIME[ext]) {
      if (ctx.imagesLeft <= 0) { ctx.notes.push(`${name}: skipped (too many images).`); return parts; }
      ctx.imagesLeft--;
      ctx.bytes += buf.length;
      parts.push({ text: `[Image: ${name}]` }, { inlineData: { mimeType: IMAGE_MIME[ext], data: buf.toString('base64') } });
    } else if (ext === 'pdf') {
      ctx.bytes += buf.length;
      parts.push({ text: `[PDF: ${name}]` }, { inlineData: { mimeType: 'application/pdf', data: buf.toString('base64') } });
    } else if (MEDIA_MIME[ext]) {
      if (ctx.depth > 0) { ctx.notes.push(`${name}: video/audio inside a ZIP is not read.`); return parts; }
      parts.push({ text: `[${MEDIA_MIME[ext].split('/')[0] === 'video' ? 'Video' : 'Audio'}: ${name}]` }, await uploadMedia(ai, buf, MEDIA_MIME[ext], name));
    } else if (TEXT_EXT.has(ext)) {
      textPart('File', buf.toString('utf8'));
    } else if (ext === 'docx') {
      textPart('Word document', docxText(readZip(buf)));
    } else if (ext === 'pptx') {
      textPart('PowerPoint', pptxText(readZip(buf)));
    } else if (ext === 'xlsx') {
      textPart('Excel workbook', xlsxText(readZip(buf)));
    } else if (ext === 'odt') {
      textPart('OpenDocument text', odtText(readZip(buf)));
    } else if (ext === 'zip') {
      if (ctx.depth >= 1) { ctx.notes.push(`${name}: a ZIP inside a ZIP is not opened.`); return parts; }
      const entries = readZip(buf).filter((e) => !e.dir);
      const listing = entries.slice(0, 200).map((e) => `${e.name} (${e.size} bytes)`).join('\n');
      parts.push({ text: `[ZIP archive: ${name}, ${entries.length} files]\n${listing}` });
      let opened = 0;
      for (const e of entries) {
        if (opened >= MAX_ZIP_ENTRIES) { ctx.notes.push(`${name}: only the first ${MAX_ZIP_ENTRIES} files were read.`); break; }
        const inner = extOf(e.name);
        const known = IMAGE_MIME[inner] || inner === 'pdf' || TEXT_EXT.has(inner) || ['docx', 'pptx', 'xlsx', 'odt'].includes(inner);
        if (!known || e.encrypted || e.size > MAX_ZIP_ENTRY_BYTES) continue;
        if (/(^|\/)(node_modules|\.git|__MACOSX)\//.test(e.name) || /(^|\/)package-lock\.json$/.test(e.name)) continue;
        opened++;
        try {
          parts.push(...await processOne(ai, { name: `${name}/${e.name}`, buf: e.read() }, { ...ctx, depth: ctx.depth + 1, get textLeft() { return ctx.textLeft; }, set textLeft(v) { ctx.textLeft = v; } }));
        } catch (err) { ctx.notes.push(`${e.name}: ${err.message}`); }
      }
    } else {
      ctx.notes.push(`${name}: this file type (.${ext || '?'}) is not supported yet.`);
    }
  } catch (err) {
    ctx.notes.push(`${name}: could not be read (${err.message}).`);
  }
  return parts;
}

/* files = [{ name, mime, data(base64) }]  ->  { parts, notes, bytes } */
async function processFiles(ai, files) {
  const ctx = { notes: [], textLeft: MAX_TEXT_TOTAL, imagesLeft: 12, bytes: 0, depth: 0 };
  const parts = [];
  for (const f of Array.isArray(files) ? files : []) {
    if (!f || !f.name || !f.data) continue;
    parts.push(...await processOne(ai, { name: String(f.name), buf: Buffer.from(f.data, 'base64') }, ctx));
  }
  if (ctx.notes.length) parts.push({ text: '[Notes about the attached files: ' + ctx.notes.join(' | ') + ']' });
  return { parts, notes: ctx.notes, bytes: ctx.bytes };
}

module.exports = { processFiles, readZip, docxText, xlsxText, pptxText };