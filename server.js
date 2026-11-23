/* =====================================================
   MIKEgpt: website + OpenRouter backend, in one server
   - chat (any OpenRouter model)
   - reads attached files (images, PDF, Word, Excel, PowerPoint, text, code, ZIP, video, audio)
   - generates images

   Run:   npm start      (or press F5 in VS Code)
   Then open  http://localhost:3000

   .env needs:   OPENROUTER_API_KEY=sk-or-v1-...
   optional:     OPENROUTER_MODEL=google/gemini-2.5-flash        (the chat model)
                 OPENROUTER_IMAGE_MODEL=google/gemini-2.5-flash-image
                 PORT=3000
   Install once: npm install express cors dotenv
   (files.js must be in the same folder as this file)
   ===================================================== */
const path = require('path');
const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { processFiles } = require('./files');

// never let one bad request stop the whole server
process.on('uncaughtException', (e) => console.error('Unexpected error (server kept running):', e));
process.on('unhandledRejection', (e) => console.error('Unexpected error (server kept running):', e));

const app = express();
app.use(cors());
app.use(express.json({ limit: '80mb' }));                      // files travel as base64 inside the JSON
app.use(express.static(path.join(__dirname, 'public')));       // the website (only this folder is public: .env and server.js stay private)

const API_KEY = (process.env.OPENROUTER_API_KEY || '').trim();
const BASE = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');

// The first one that works is remembered. If a name is retired, the next one is tried.
const CHAT_MODELS = [...new Set([
  (process.env.OPENROUTER_MODEL || '').trim(),
  'google/gemini-2.5-flash',
  'google/gemini-2.5-flash-lite',
  'openai/gpt-4o-mini',
  'openrouter/auto',
].filter(Boolean))];
const IMAGE_MODELS = [...new Set([
  (process.env.OPENROUTER_IMAGE_MODEL || '').trim(),
  'google/gemini-2.5-flash-image',
  'openai/gpt-image-1',
  'bytedance-seed/seedream-4.5',
  'black-forest-labs/flux.2-pro',
].filter(Boolean))];
let workingModel = null;
let workingImageModel = null;

const SYSTEM_PROMPT = `You are MIKEgpt, a friendly and capable AI assistant inside a chat website.
- Answer clearly and concisely; go deeper only when asked.
- Reply in the same language the user writes in (English, French, Wolof, ...).
- Use Markdown when it helps (short lists, tables, fenced code blocks).
- When the user attaches files, their content is included in the conversation: read it carefully and answer from it. Say which file you are talking about. If a file could not be read, say so plainly.
- If you are not sure about something, say so instead of inventing facts.`;

/* ---------- friendly errors ---------- */
function makeError(status, err) {
  const msg = String((err && err.message) || '');
  let text;
  let fatal = false;
  if (status === 401) {
    text = 'Your OpenRouter API key is not valid. Check OPENROUTER_API_KEY in the .env file (no quotes, no spaces), then restart the server.';
    fatal = true;
  } else if (status === 402) {
    text = 'Your OpenRouter account has no credit left for this request. Add credits at https://openrouter.ai/credits and try again.';
    fatal = true;
  } else if (status === 429) {
    text = 'Too many requests, or this model is busy right now. Wait a few seconds and try again.';
  } else if (status === 413) {
    text = 'The files are too big for this model. Send smaller files.';
  } else if (status === 403) {
    text = 'OpenRouter refused this request. ' + msg;
  } else if (status === 404 || /no endpoints found/i.test(msg)) {
    text = 'This model is not available or cannot read this kind of file. ' + msg;
  } else if (status >= 500) {
    text = 'The AI service is busy right now. Please try again in a moment.';
  } else {
    text = msg || `OpenRouter returned an error (${status}).`;
  }
  const e = new Error(text);
  e.status = status;
  e.fatal = fatal;
  return e;
}

async function callOpenRouter(route, body, timeoutMs) {
  let r;
  try {
    r = await fetch(`${BASE}${route}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
        'HTTP-Referer': 'http://localhost:3000',
        'X-Title': 'MIKEgpt',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e.name === 'TimeoutError') { const t = new Error('The AI took too long to answer. Try again, or send a smaller file.'); t.status = 504; throw t; }
    const t = new Error('Cannot reach OpenRouter. Check your internet connection.'); t.status = 503; throw t;
  }
  const data = await r.json().catch(() => ({}));
  // OpenRouter sometimes answers 200 with an "error" inside
  if (!r.ok || data.error) throw makeError(r.ok ? Number(data.error.code) || 500 : r.status, data.error);
  return data;
}

/* ---------- files stay available for follow-up questions in the same chat ---------- */
const sessions = new Map();               // chatId -> { items: [{ parts, bytes }], at }
const MAX_SESSION_BYTES = 12 * 1024 * 1024;
function rememberFiles(chatId, parts, bytes) {
  if (!chatId || !parts.length) return;
  // big video/audio is NOT kept for later questions (it would be sent again every time)
  const kept = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i + 1] && parts[i + 1].big) { i++; continue; }
    if (!parts[i].big) kept.push(parts[i]);
  }
  if (!kept.length) return;
  const s = sessions.get(chatId) || { items: [], at: 0 };
  s.items.push({ parts: kept, bytes });
  while (s.items.length > 1 && s.items.reduce((n, i) => n + i.bytes, 0) > MAX_SESSION_BYTES) s.items.shift();
  s.at = Date.now();
  sessions.set(chatId, s);
}
function recalledParts(chatId) {
  const s = chatId && sessions.get(chatId);
  return s ? s.items.flatMap((i) => i.parts) : [];
}
setInterval(() => { for (const [k, v] of sessions) if (Date.now() - v.at > 2 * 3600 * 1000) sessions.delete(k); }, 10 * 60 * 1000).unref();

/* ---------- our parts -> OpenRouter message content ---------- */
function toContent(parts) {
  const out = [];
  for (const p of parts) {
    if (typeof p.text === 'string') { out.push({ type: 'text', text: p.text }); continue; }
    const d = p.inlineData;
    if (!d) continue;
    const url = `data:${d.mimeType};base64,${d.data}`;
    if (d.mimeType.startsWith('image/')) out.push({ type: 'image_url', image_url: { url } });
    else if (d.mimeType === 'application/pdf') out.push({ type: 'file', file: { filename: p.filename || 'document.pdf', file_data: url } });
    else if (d.mimeType.startsWith('video/')) out.push({ type: 'video_url', video_url: { url } });
    else if (d.mimeType.startsWith('audio/')) out.push({ type: 'input_audio', input_audio: { data: d.data, format: p.ext === 'mp3' || d.mimeType === 'audio/mpeg' ? 'mp3' : (p.ext || 'wav') } });
  }
  return out;
}

function buildMessages(message, history, extraParts) {
  const turns = [];
  const add = (role, text) => {
    text = String(text || '').trim();
    if (!text || text.startsWith('⚠️')) return;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content += '\n\n' + text;
    else turns.push({ role, content: text });
  };
  (Array.isArray(history) ? history.slice(-10) : []).forEach((h) => {
    if (!h) return;
    const text = h.text ?? h.content;
    if (h.role === 'user') add('user', text);
    else if (['model', 'assistant', 'bot'].includes(h.role)) add('assistant', text);
  });
  while (turns.length && turns[0].role !== 'user') turns.shift();
  const question = String(message || '').trim() || 'Please read the attached file(s) and tell me what they contain.';
  const last = turns[turns.length - 1];
  if (last && last.role === 'user') { last.content += '\n\n' + question; }    // two user turns in a row: merge
  else turns.push({ role: 'user', content: question });
  if (extraParts.length) {                                                  // files go with the newest question
    const lastTurn = turns[turns.length - 1];
    lastTurn.content = toContent([...extraParts, { text: lastTurn.content }]);
  }
  return [{ role: 'system', content: SYSTEM_PROMPT }, ...turns];
}

/* ---------- chat ---------- */
async function ask(message, history, extraParts) {
  const messages = buildMessages(message, history, extraParts);
  const max_tokens = extraParts.length ? 4000 : 1500;
  const order = workingModel ? [workingModel, ...CHAT_MODELS.filter((m) => m !== workingModel)] : CHAT_MODELS;
  let lastErr;
  for (const model of order) {
    // Google models: ask for little "thinking" so answers come faster. If the model refuses that setting, retry without it.
    const attempts = /^google\/gemini/.test(model) ? [{ reasoning: { effort: 'low' } }, {}] : [{}];
    for (const extra of attempts) {
      try {
        const data = await callOpenRouter('/chat/completions', { model, messages, max_tokens, ...extra }, 180000);
        const m = data.choices && data.choices[0] && data.choices[0].message;
        const text = String((m && (m.content || m.refusal)) || '').trim();
        if (workingModel !== model) { workingModel = model; console.log('Using model:', model); }
        return text || "I didn't get an answer. Please try again.";
      } catch (e) {
        lastErr = e;
        console.log(`${model} failed ${e.status}:`, String(e.message).slice(0, 200));
        if (e.fatal) throw e;                       // bad key / no credit: stop right away
        if (e.status !== 400) break;                // only a 400 is worth retrying without the extra setting
      }
    }
  }
  throw lastErr || new Error('No model answered.');
}

/* ---------- image generation ---------- */
async function makeImage(prompt, imageParts) {
  const refs = imageParts.map((p) => ({ type: 'image_url', image_url: { url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}` } }));
  const order = workingImageModel ? [workingImageModel, ...IMAGE_MODELS.filter((m) => m !== workingImageModel)] : IMAGE_MODELS;
  let lastErr;
  for (const model of order) {
    try {
      const body = { model, prompt };
      if (refs.length) body.input_references = refs;      // a picture the user attached = "edit this image"
      const data = await callOpenRouter('/images', body, 240000);
      const img = data.data && data.data[0];
      if (!img || !img.b64_json) { lastErr = new Error('The model did not return an image. Try describing it differently.'); continue; }
      if (workingImageModel !== model) { workingImageModel = model; console.log('Using image model:', model); }
      return { image: `data:${img.media_type || 'image/png'};base64,${img.b64_json}`, text: '' };
    } catch (e) {
      lastErr = e;
      console.log(`${model} (image) failed ${e.status}:`, String(e.message).slice(0, 200));
      if (e.fatal) throw e;
    }
  }
  throw lastErr || new Error('No image model answered.');
}

/* ---------- routes ---------- */
app.get('/api/health', (req, res) => res.json({ ok: true, hasKey: Boolean(API_KEY), model: workingModel }));

// Real test: open http://localhost:3000/api/test
app.get('/api/test', async (req, res) => {
  if (!API_KEY) return res.status(500).json({ ok: false, error: 'OPENROUTER_API_KEY is missing in .env' });
  const t = Date.now();
  try { res.json({ ok: true, model: workingModel, reply: await ask('Say hello in one short sentence.', [], []), ms: Date.now() - t }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/chat', async (req, res) => {
  const body = req.body || {};
  const message = String(body.message || '').trim();
  const hasFiles = Array.isArray(body.files) && body.files.length > 0;
  if (!message && !hasFiles) return res.status(400).json({ error: 'Message is required' });
  if (!API_KEY) return res.status(500).json({ error: 'No OpenRouter key yet. Add OPENROUTER_API_KEY=sk-or-v1-... to the .env file and restart the server.' });
  try {
    const chatId = String(body.chatId || '');
    console.log(`Chat message received, files: ${hasFiles ? body.files.map((f) => f.name).join(', ') : 'none'}`);
    if (hasFiles) {
      const earlier = recalledParts(chatId);                       // files sent before in this chat
      const { parts, bytes } = await processFiles(body.files);
      rememberFiles(chatId, parts, bytes);
      return res.json({ reply: await ask(message, body.history, [...earlier, ...parts]) });
    }
    res.json({ reply: await ask(message, body.history, recalledParts(chatId)) });
  } catch (e) {
    console.error('Chat error:', e.message);
    res.status(e.status >= 400 && e.status < 600 ? e.status : 500).json({ error: e.message || 'Something went wrong on the server.' });
  }
});

app.post('/api/image', async (req, res) => {
  const body = req.body || {};
  const prompt = String(body.prompt || '').trim();
  if (!prompt) return res.status(400).json({ error: 'Describe the image you want.' });
  if (!API_KEY) return res.status(500).json({ error: 'No OpenRouter key yet. Add OPENROUTER_API_KEY=sk-or-v1-... to the .env file and restart the server.' });
  try {
    const { parts } = await processFiles(body.files);
    res.json(await makeImage(prompt, parts.filter((p) => p.inlineData && /^image\//.test(p.inlineData.mimeType))));
  } catch (e) {
    console.error('Image error:', e.message);
    res.status(e.status >= 400 && e.status < 600 ? e.status : 500).json({ error: e.message });
  }
});

// too-big uploads etc.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'The files are too big. Send smaller files (under about 25 MB each).' });
  console.error(err);
  res.status(500).json({ error: 'Server error: ' + (err.message || err) });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, (err) => {
  if (err) return;                       // Express 5 also calls this on errors; handled below
  console.log(`MIKEgpt running at http://localhost:${PORT}`);
  console.log('Chat model:', CHAT_MODELS[0]);
  if (!API_KEY) console.log('⚠  OPENROUTER_API_KEY is missing in your .env file.');
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n❌ Port ${PORT} is already used by another program (most likely an OLD copy of this server still running).`);
    console.error('   Close the old terminal(s), or on Windows run:  netstat -ano | findstr :' + PORT + '   then   taskkill /PID <number> /F\n');
  } else console.error(e);
  process.exit(1);
});