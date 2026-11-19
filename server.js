/* =====================================================
   MIKEgpt backend: Express + Google Gemini
   - chat (fast)
   - reads attached files (images, PDF, Word, Excel, PowerPoint, text, code, ZIP, video, audio)
   - generates images

   Run:   npm start     (or press F5 in VS Code)
   Then open  http://localhost:3000   : the SAME server shows the website
   (folder "public") and answers the chat, so nothing else has to be started.
   .env:  GEMINI_API_KEY=your-key
          GEMINI_MODEL=gemini-3.5-flash        (optional)
          GEMINI_IMAGE_MODEL=gemini-3.1-flash-image   (optional)
   Install once:  npm install express cors dotenv @google/genai
   (files.js must be in the same folder as this file)
   ===================================================== */
const path = require('path');
const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');
const { processFiles } = require('./file');

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));      // files travel as base64 inside the JSON
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));   // the website (only this folder is public: .env and server.js stay private)

const API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const ai = new GoogleGenAI({ apiKey: API_KEY });

const CHAT_MODELS = [...new Set([(process.env.GEMINI_MODEL || '').trim(), 'gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-flash'].filter(Boolean))];
const IMAGE_MODELS = [...new Set([(process.env.GEMINI_IMAGE_MODEL || '').trim(), 'gemini-3.1-flash-image', 'gemini-nano-banana-2.1', 'gemini-3.1-flash-lite-image', 'gemini-2.5-flash-image'].filter(Boolean))];
let workingModel = null;
let workingImageModel = null;

const SYSTEM_PROMPT = `You are MIKEgpt, a friendly and capable AI assistant inside a chat website.
- Answer clearly and concisely; go deeper only when asked.
- Reply in the same language the user writes in (English, French, Wolof, ...).
- Use Markdown when it helps (short lists, tables, fenced code blocks).
- When the user attaches files, their content is included in the conversation: read it carefully and answer from it. Say which file you are talking about. If a file could not be read, say so plainly.
- If you are not sure about something, say so instead of inventing facts.`;

function configFor(model, maxOutputTokens) {
  const config = { systemInstruction: SYSTEM_PROMPT, maxOutputTokens };
  if (/^gemini-3/.test(model)) config.thinkingConfig = { thinkingLevel: 'low' };
  else if (/^gemini-2\.5-flash/.test(model)) config.thinkingConfig = { thinkingBudget: 0 };
  return config;
}

/* ---------- files stay available for follow-up questions in the same chat ---------- */
const sessions = new Map();               // chatId -> { items: [{ parts, bytes }], at }
const MAX_SESSION_BYTES = 12 * 1024 * 1024;
function rememberFiles(chatId, parts, bytes) {
  if (!chatId || !parts.length) return;
  const s = sessions.get(chatId) || { items: [], at: 0 };
  s.items.push({ parts, bytes });
  while (s.items.length > 1 && s.items.reduce((n, i) => n + i.bytes, 0) > MAX_SESSION_BYTES) s.items.shift();
  s.at = Date.now();
  sessions.set(chatId, s);
}
function recalledParts(chatId) {
  const s = chatId && sessions.get(chatId);
  return s ? s.items.flatMap((i) => i.parts) : [];
}
setInterval(() => { for (const [k, v] of sessions) if (Date.now() - v.at > 2 * 3600 * 1000) sessions.delete(k); }, 10 * 60 * 1000).unref();

/* ---------- conversation -> Gemini "contents" ---------- */
function buildContents(message, history, extraParts = []) {
  const out = [];
  const add = (role, text) => {
    text = String(text || '').trim();
    if (!text || text.startsWith('⚠️')) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts[0].text += '\n\n' + text;
    else out.push({ role, parts: [{ text }] });
  };
  (Array.isArray(history) ? history.slice(-10) : []).forEach((h) => {
    if (!h) return;
    const text = h.text ?? h.content;
    if (h.role === 'user') add('user', text);
    else if (['model', 'assistant', 'bot'].includes(h.role)) add('model', text);
  });
  while (out.length && out[0].role !== 'user') out.shift();
  const finalParts = [...extraParts, { text: String(message || '').trim() || 'Please read the attached file(s) and tell me what they contain.' }];
  const last = out[out.length - 1];
  if (last && last.role === 'user') last.parts.push(...finalParts);
  else out.push({ role: 'user', parts: finalParts });
  return out;
}

function friendly(err) {
  const m = String((err && err.message) || err || '');
  if (/API key not valid|API_KEY_INVALID/i.test(m)) return 'Your Gemini API key is not valid. Check GEMINI_API_KEY in the .env file and restart the server.';
  if (/quota|RESOURCE_EXHAUSTED|429/i.test(m)) return 'Gemini quota reached (too many requests, or this model needs a billing-enabled key). Wait a moment, or check your Google AI Studio plan.';
  if (/503|UNAVAILABLE|overloaded/i.test(m)) return 'Gemini is busy right now. Please try again in a moment.';
  return m || 'Something went wrong on the server.';
}
const isKeyOrQuota = (e) => /API key not valid|API_KEY_INVALID|quota|RESOURCE_EXHAUSTED/i.test(String((e && e.message) || ''));

/* ---------- chat ---------- */
async function ask(message, history, extraParts) {
  const contents = buildContents(message, history, extraParts);
  const maxTokens = extraParts.length ? 4000 : 1500;
  const order = workingModel ? [workingModel, ...CHAT_MODELS.filter((m) => m !== workingModel)] : CHAT_MODELS;
  let lastErr;
  for (const model of order) {
    try {
      const response = await ai.models.generateContent({ model, contents, config: configFor(model, maxTokens) });
      if (workingModel !== model) { workingModel = model; console.log('Using model:', model); }
      return (response.text || '').trim() || "I didn't get an answer. Please try again.";
    } catch (e) {
      lastErr = e;
      console.log(`${model} failed:`, String(e.message || e).slice(0, 200));
      if (isKeyOrQuota(e)) break;
    }
  }
  throw lastErr || new Error('No model answered.');
}

/* ---------- image generation ---------- */
async function makeImage(prompt, imageParts) {
  const contents = [{ role: 'user', parts: [...imageParts, { text: prompt }] }];
  const order = workingImageModel ? [workingImageModel, ...IMAGE_MODELS.filter((m) => m !== workingImageModel)] : IMAGE_MODELS;
  let lastErr;
  for (const model of order) {
    try {
      const response = await ai.models.generateContent({ model, contents, config: { responseModalities: ['TEXT', 'IMAGE'] } });
      const parts = (response.candidates && response.candidates[0] && response.candidates[0].content && response.candidates[0].content.parts) || [];
      const img = parts.find((p) => p.inlineData && p.inlineData.data);
      const text = parts.filter((p) => p.text).map((p) => p.text).join(' ').trim();
      if (!img) { lastErr = new Error(text || 'The model did not return an image (the request may have been blocked). Try describing it differently.'); continue; }
      if (workingImageModel !== model) { workingImageModel = model; console.log('Using image model:', model); }
      return { image: `data:${img.inlineData.mimeType || 'image/png'};base64,${img.inlineData.data}`, text };
    } catch (e) {
      lastErr = e;
      console.log(`${model} (image) failed:`, String(e.message || e).slice(0, 200));
      if (isKeyOrQuota(e)) break;
    }
  }
  throw lastErr || new Error('No image model answered.');
}

/* ---------- routes ---------- */
app.get('/api/health', (req, res) => res.json({ ok: true, hasKey: Boolean(API_KEY) }));

app.get('/api/test', async (req, res) => {
  if (!API_KEY) return res.status(500).json({ ok: false, error: 'GEMINI_API_KEY is missing in .env' });
  const t = Date.now();
  try { res.json({ ok: true, model: workingModel, reply: await ask('Say hello in one short sentence.', [], []), ms: Date.now() - t }); }
  catch (e) { res.status(500).json({ ok: false, error: friendly(e) }); }
});

app.post('/api/chat', async (req, res) => {
  const body = req.body || {};
  const message = String(body.message || '').trim();
  const hasFiles = Array.isArray(body.files) && body.files.length > 0;
  if (!message && !hasFiles) return res.status(400).json({ error: 'Message is required' });
  if (!API_KEY) return res.status(500).json({ error: 'No Gemini API key yet. Add GEMINI_API_KEY=... to the .env file and restart the server.' });
  try {
    const chatId = String(body.chatId || '');
    if (hasFiles) {
      const { parts, bytes } = await processFiles(ai, body.files);
      rememberFiles(chatId, parts, bytes);
    }
    const reply = await ask(message, body.history, recalledParts(chatId));
    res.json({ reply });
  } catch (e) {
    console.error('Chat error:', e.message);
    res.status(500).json({ error: friendly(e) });
  }
});

app.post('/api/image', async (req, res) => {
  const body = req.body || {};
  const prompt = String(body.prompt || '').trim();
  if (!prompt) return res.status(400).json({ error: 'Describe the image you want.' });
  if (!API_KEY) return res.status(500).json({ error: 'No Gemini API key yet. Add GEMINI_API_KEY=... to the .env file and restart the server.' });
  try {
    // attached pictures (if any) are used as a starting point, so "edit this image" works too
    const { parts } = await processFiles(ai, body.files);
    res.json(await makeImage(prompt, parts.filter((p) => p.inlineData && /^image\//.test(p.inlineData.mimeType))));
  } catch (e) {
    console.error('Image error:', e.message);
    res.status(500).json({ error: friendly(e) });
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
  if (!API_KEY) console.log('⚠  GEMINI_API_KEY is missing in your .env file.');
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n❌ Port ${PORT} is already used by another program (most likely an OLD copy of this server still running).`);
    console.error('   Close the old terminal(s), or on Windows run:  netstat -ano | findstr :' + PORT + '   then   taskkill /PID <number> /F\n');
  } else console.error(e);
  process.exit(1);
});