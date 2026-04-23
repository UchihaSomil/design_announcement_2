// poller.js
// Background poller: fetches BSE announcements, routes them, runs Gemini extraction.
// Exports: startPoller(app, getDefaultCfg)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { resolveRoute } from './bse_routing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Persistence paths ────────────────────────────────────────────────
const DATA_DIR       = path.join(__dirname, 'data');
const SEEN_IDS_FILE  = path.join(DATA_DIR, 'seen_ids.json');
const ANN_FILE       = path.join(DATA_DIR, 'announcements.json');

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadSeenIds() {
  try { return new Set(JSON.parse(fs.readFileSync(SEEN_IDS_FILE, 'utf8'))); }
  catch { return new Set(); }
}

function saveSeenIds(set) {
  try { fs.writeFileSync(SEEN_IDS_FILE, JSON.stringify([...set]), 'utf8'); }
  catch (e) { console.warn('[poller] Could not save seen_ids:', e.message); }
}

function loadAnnouncements() {
  try { return JSON.parse(fs.readFileSync(ANN_FILE, 'utf8')); }
  catch { return []; }
}

let _persistTimer = null;
function saveAnnouncements(arr) {
  fs.writeFile(ANN_FILE, JSON.stringify(arr, null, 2), 'utf8', (err) => {
    if (err) console.warn('[poller] Could not save announcements:', err.message);
  });
}

// ── In-memory announcement store (shared with server.js via export) ──
export const announcementStore = new Map(); // id → record

// Broadcast callbacks registered by server.js
const broadcastCallbacks = [];
export function onBroadcast(fn) { broadcastCallbacks.push(fn); }

export function broadcastDashboard(record) {
  for (const fn of broadcastCallbacks) {
    try { fn(record); }
    catch (e) { console.error('[poller] Broadcast error:', e.message); }
  }
}

// ── BSE categories to poll ───────────────────────────────────────────
const BSE_CATEGORIES = [
  'Result',
  'Integrated Filing',
  'Insider Trading / SAST',
  'Company Update',
  'Others',
  'Board Meeting',
  'Corp. Action',
  'AGM/EGM',
];

// ── BSE API fetch ────────────────────────────────────────────────────
function bseDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

async function fetchBseCategory(cat) {
  const now    = new Date();
  const toDate   = bseDateStr(now);
  const fromDate = bseDateStr(now);

  const url = `https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w` +
    `?pageno=1&strCat=${encodeURIComponent(cat)}&strPrevDate=${fromDate}` +
    `&strScrip=&strSearch=P&strToDate=${toDate}&strType=C`;

  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://www.bseindia.com/',
      'Accept': 'application/json',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`BSE API HTTP ${resp.status} for "${cat}"`);
  const text = await resp.text();
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`JSON parse failed for "${cat}": ${e.message} — raw: ${text.slice(0, 200)}`); }
}

// ── Download file helper (uses fetch to tolerate BSE's non-standard headers) ──
async function downloadFile(url, dest) {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://www.bseindia.com/',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(60000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} downloading ${url}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(dest, buffer);
}

// ── Prompt loader ────────────────────────────────────────────────────
function loadPrompt(name) {
  const safe = name.replace(/[^a-z0-9_]/gi, '');
  try { return fs.readFileSync(path.join(__dirname, 'system_prompts', `${safe}.md`), 'utf8'); }
  catch { return null; }
}

// ── STEP2 map (mirrors server.js) ────────────────────────────────────
const STEP2_PROMPT_FILES = {
  'Financial Updates':                     'step2_financial_updates',
  'Concall / Presentation':               'step2_concall_presentation',
  'Dividend':                              'step2_dividend',
  'Buyback':                              'step2_buyback',
  'Bonus / Stock Split':                  'step2_bonus_stock_split',
  'Acquisition':                          'step2_acquisition',
  'Merger / Demerger':                    'step2_merger_demerger',
  'Joint Venture / Strategic Partnership': 'step2_joint_venture',
  'Order Win':                            'step2_order_win',
  'Capacity Expansion / Capex':           'step2_capacity_expansion',
  'Product Launch':                       'step2_product_launch',
  'Fund Raising':                         'step2_fund_raising',
  'Stake Sale / Disinvestment':           'step2_stake_sale',
  'Credit Rating Change':                 'step2_credit_rating_change',
  'Regulatory Action / Penalty':          'step2_regulatory_action',
  'Fraud / Default':                      'step2_fraud_default',
  'Insolvency / CIRP':                    'step2_insolvency_cirp',
  'Open Offer / Takeover':               'step2_open_offer',
  'Promoter Buy / Sell':                  'step2_promoter_buy_sell',
  'Change in Key Management':             'step2_change_in_key_management',
  'Operational Disruption':              'step2_operational_disruption',
  'Others':                               'step2_others',
  'Routine / Administrative':             'step2_routine_administrative',
  'Regulatory Approval / Licensing':      'step2_regulatory_approval',
};

// ── Direct Gemini call (no SSE) ──────────────────────────────────────
// opts: { apiKey, model, contents, systemPrompt, maxTokens, thinking, temperature, mime, onProgress }
async function callGeminiDirect(opts) {
  const { apiKey, model: modelId, contents, systemPrompt, maxTokens, thinking, temperature, mime, onProgress } = opts;
  const log = onProgress || (() => {});
  const ai = new GoogleGenAI({ apiKey });

  const genConfig = {
    responseMimeType: mime || 'application/json',
    systemInstruction: [{ text: systemPrompt }],
    maxOutputTokens: maxTokens || 65536,
  };

  const THINKING_MODELS = ['gemini-2.5', 'gemini-3'];
  const supportsThinking = THINKING_MODELS.some(p => modelId.includes(p));
  if (thinking && thinking !== 'off' && supportsThinking) {
    genConfig.thinkingConfig = { thinkingLevel: ThinkingLevel[thinking] || ThinkingLevel.MINIMAL };
  }
  if (temperature != null && !supportsThinking) genConfig.temperature = temperature;

  const MAX_RETRIES = 4;
  const RETRYABLE = [429, 503, 502, 500];
  const CALL_TIMEOUT_MS = 120000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const t0 = Date.now();
    let timer;
    try {
      log(`Calling ${modelId} — attempt ${attempt}/${MAX_RETRIES}...`);
      const resultPromise = ai.models.generateContent({
        model: modelId,
        config: genConfig,
        contents,
      });
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out after 120s')), CALL_TIMEOUT_MS);
      });
      const result = await Promise.race([resultPromise, timeoutPromise]);
      clearTimeout(timer);
      const elapsed = Date.now() - t0;
      log(`Attempt ${attempt} succeeded in ${(elapsed / 1000).toFixed(1)}s`);

      let text = '';
      try {
        text = result.text || '';
      } catch {
        text = result.candidates?.[0]?.content?.parts?.[0]?.text || '';
      }
      const usage = result.usageMetadata || {};

      log(`Parsing JSON (${text.length} chars)...`);
      let raw;
      try {
        let cleaned = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
        try {
          raw = JSON.parse(cleaned);
        } catch {
          // Model may append trailing text after the JSON — find the outermost {} or []
          const firstBrace = cleaned.indexOf('{');
          const firstBracket = cleaned.indexOf('[');
          const start = firstBrace >= 0 && (firstBracket < 0 || firstBrace < firstBracket) ? firstBrace : firstBracket;
          if (start < 0) throw new Error('No JSON object found in response');
          const open = cleaned[start];
          const close = open === '{' ? '}' : ']';
          let depth = 0, end = -1, inStr = false, esc = false;
          for (let i = start; i < cleaned.length; i++) {
            const ch = cleaned[i];
            if (esc) { esc = false; continue; }
            if (ch === '\\' && inStr) { esc = true; continue; }
            if (ch === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (ch === open) depth++;
            else if (ch === close) { depth--; if (depth === 0) { end = i; break; } }
          }
          if (end < 0) throw new Error('Unbalanced JSON braces');
          raw = JSON.parse(cleaned.slice(start, end + 1));
          log(`Extracted JSON from position ${start}-${end} (trimmed trailing garbage)`);
        }
      } catch (parseErr) {
        log(`JSON parse failed — ${parseErr.message}`);
        log(`Raw response (first 500 chars): ${text.slice(0, 500)}`);
        log(`Raw response (last 300 chars): ...${text.slice(-300)}`);
        if (attempt < MAX_RETRIES) {
          const wait = attempt * 8;
          log(`Retrying in ${wait}s → attempt ${attempt + 1}/${MAX_RETRIES}...`);
          await new Promise(r => setTimeout(r, wait * 1000));
          continue;
        }
        throw new Error(`JSON parse failed after ${attempt} attempts: ${parseErr.message}. Response start: ${text.slice(0, 200)}`);
      }

      const parsed = Array.isArray(raw) ? raw[0] : raw;
      return {
        parsed,
        ms: elapsed,
        attempts: attempt,
        tokens: {
          input:  usage.promptTokenCount     || 0,
          output: usage.candidatesTokenCount || 0,
          total:  usage.totalTokenCount      || 0,
        },
      };
    } catch (err) {
      clearTimeout(timer);
      const elapsed = Date.now() - t0;
      const isRetryable = RETRYABLE.some(c => String(err.message).includes(String(c))) || err.message.includes('Timed out');
      if (isRetryable && attempt < MAX_RETRIES) {
        const wait = attempt * 8;
        log(`Attempt ${attempt} failed after ${(elapsed / 1000).toFixed(1)}s — ${err.message.slice(0, 100)}`);
        log(`Retrying in ${wait}s → attempt ${attempt + 1}/${MAX_RETRIES}...`);
        console.log(`[poller] Gemini retry ${attempt}/${MAX_RETRIES} in ${wait}s: ${err.message.slice(0, 120)}`);
        await new Promise(r => setTimeout(r, wait * 1000));
        continue;
      }
      log(`Failed after ${attempt} attempts: ${err.message.slice(0, 120)}`);
      throw err;
    }
  }
}

// ── Normalize smart_subcategory to match STEP2_PROMPT_FILES keys ────
const _step2KeysNorm = new Map();
for (const key of Object.keys(STEP2_PROMPT_FILES)) {
  _step2KeysNorm.set(key.toLowerCase().replace(/\s+/g, ''), key);
}
function normalizeSubcategory(raw) {
  if (!raw) return raw;
  if (STEP2_PROMPT_FILES[raw]) return raw;
  const norm = raw.toLowerCase().replace(/\s+/g, '');
  return _step2KeysNorm.get(norm) || raw;
}

// ── Build contents for base64 PDF ───────────────────────────────────
function buildBase64Contents(filePath) {
  const buffer = fs.readFileSync(filePath);
  const base64 = buffer.toString('base64');
  return [{
    role: 'user',
    parts: [
      { inlineData: { mimeType: 'application/pdf', data: base64 } },
      { text: 'Extract structured data from this filing.' },
    ],
  }];
}

const QUICK_SUMMARY_PROMPT = `You are analyzing an Indian stock-exchange corporate filing (BSE/NSE).
Read the PDF and return ONLY this JSON — no markdown, no commentary:
{
  "headline": "<one-line headline, max 120 chars>",
  "summary": "<2-3 sentence summary of what this filing says>",
  "sentiment": "Positive" | "Negative" | "Neutral",
  "key_entities": ["<company>", "<person if relevant>"]
}`;

async function processAnnouncement(record, cfg) {
  const { id, pdf_url, bse_category, bse_subcategory } = record;

  if (!record.log) record.log = [];
  function setSubstatus(msg) {
    record.substatus = msg;
    record.log.push({ t: Date.now(), msg });
    updateRecord(record);
  }

  const routing = resolveRoute(bse_category, bse_subcategory);
  record.smart_subcategory = routing.smart_subcategory;
  record.route = routing.route;
  record.status = 'processing';
  record.steps = {};
  setSubstatus('Downloading PDF...');

  const dlStart = Date.now();
  const filePath = path.join(__dirname, 'uploads', `poller_${id}.pdf`);
  try {
    await downloadFile(pdf_url, filePath);
    record.steps.download = { ms: Date.now() - dlStart };
    setSubstatus(`PDF downloaded (${((Date.now() - dlStart) / 1000).toFixed(1)}s)`);
  } catch (err) {
    record.status = 'error';
    record.error = `PDF download failed: ${err.message}`;
    record.steps.download = { ms: Date.now() - dlStart, error: err.message };
    record.substatus = null;
    record.processed_at = new Date().toISOString();
    updateRecord(record);
    return;
  }

  try {
    const apiKey = cfg.apiKey || process.env.GEMINI_API_KEY;
    setSubstatus('Encoding PDF as base64...');
    const contents = buildBase64Contents(filePath);

    let smartSubcategory = normalizeSubcategory(routing.smart_subcategory);

    // ── Step 1: classify ONLY when route is "llm" (smart_subcategory unknown) ──
    if (routing.route === 'llm') {
      const step1Text = loadPrompt('step1_classifier');
      if (!step1Text) {
        record.status = 'error';
        record.error = 'step1_classifier prompt not found';
        record.substatus = null;
        record.processed_at = new Date().toISOString();
        updateRecord(record);
        return;
      }
      setSubstatus(`Step 1 — Classifying (${cfg.modelStep1 || 'gemini-3.1-flash-lite-preview'})...`);
      let s1;
      try {
        s1 = await callGeminiDirect({
          apiKey, model: cfg.modelStep1 || 'gemini-3.1-flash-lite-preview', contents, systemPrompt: step1Text,
          maxTokens: cfg.maxTokensStep1 || 8192, thinking: cfg.thinkingStep1 || 'MINIMAL',
          temperature: cfg.temperature, mime: cfg.mime,
          onProgress: msg => setSubstatus(`[Step 1] ${msg}`),
        });
      } catch (err) {
        record.status = 'error';
        record.error = `Step 1 failed: ${err.message}`;
        record.steps.step1 = { error: err.message };
        record.substatus = null;
        record.processed_at = new Date().toISOString();
        updateRecord(record);
        return;
      }
      record.steps.step1 = { ms: s1.ms, tokens: s1.tokens, model: cfg.modelStep1 || 'gemini-3.1-flash-lite-preview' };
      smartSubcategory = normalizeSubcategory(s1.parsed?.smart_subcategory) || null;
      record.smart_subcategory = smartSubcategory;
      record._classifier_confidence = s1.parsed?.confidence || null;
      record._classifier_rationale = s1.parsed?.rationale || null;
      record._secondary_events = s1.parsed?.secondary_events || [];
      setSubstatus(`Step 1 done → ${smartSubcategory || 'unknown'} (${(s1.ms / 1000).toFixed(1)}s)`);
    } else {
      record.steps.step1 = { skipped: true, reason: 'Definite route' };
    }

    // ── Step 2: deep extraction if prompt exists for this category ──
    const step2Slug = smartSubcategory ? STEP2_PROMPT_FILES[smartSubcategory] : null;
    const step2Text = step2Slug ? loadPrompt(step2Slug) : null;

    if (step2Text) {
      setSubstatus(`Step 2 — Extracting with ${cfg.modelStep2 || 'gemini-3.1-flash-lite-preview'} (${step2Slug}.md)...`);
      let s2;
      try {
        s2 = await callGeminiDirect({
          apiKey, model: cfg.modelStep2 || 'gemini-3.1-flash-lite-preview', contents, systemPrompt: step2Text,
          maxTokens: cfg.maxTokensStep2 || 65536, thinking: cfg.thinkingStep2 || 'MINIMAL',
          temperature: cfg.temperature, mime: cfg.mime,
          onProgress: msg => setSubstatus(`[Step 2] ${msg}`),
        });
      } catch (err) {
        record.status = 'error';
        record.error = `Step 2 failed: ${err.message}`;
        record.steps.step2 = { error: err.message };
        record.substatus = null;
        record.processed_at = new Date().toISOString();
        updateRecord(record);
        return;
      }
      record.steps.step2 = { ms: s2.ms, tokens: s2.tokens, model: cfg.modelStep2 || 'gemini-3.1-flash-lite-preview' };
      record.extracted_headline = s2.parsed?.headline || null;
      record.extracted_summary  = s2.parsed?.summary  || null;
      record.sentiment          = s2.parsed?.sentiment || null;
      record.extracted          = {
        smart_subcategory: smartSubcategory,
        _classifier_confidence: record._classifier_confidence || (routing.route === 'definite' ? 100 : null),
        _classifier_rationale:  record._classifier_rationale  || (routing.route === 'definite' ? 'Definite route — Step 1 skipped' : null),
        _secondary_events:      record._secondary_events || [],
        ...s2.parsed,
      };
      record.status       = 'done';
      record.substatus    = null;
      record.processed_at = new Date().toISOString();
      record.log.push({ t: Date.now(), msg: `Completed (${(s2.ms / 1000).toFixed(1)}s, ${s2.tokens.total.toLocaleString()} tokens)` });
      updateRecord(record);
      return;
    }

    // ── No Step 2 prompt → quick summary call for headline/summary/sentiment ──
    record.steps.step2 = { skipped: true, reason: `No prompt for "${smartSubcategory}"` };
    setSubstatus(`Quick summary — ${cfg.modelStep2 || 'gemini-3.1-flash-lite-preview'}...`);
    try {
      const qs = await callGeminiDirect({
        apiKey, model: cfg.modelStep2 || 'gemini-3.1-flash-lite-preview', contents, systemPrompt: QUICK_SUMMARY_PROMPT,
        maxTokens: 4096, thinking: cfg.thinkingStep2 || 'MINIMAL',
        temperature: cfg.temperature, mime: cfg.mime,
        onProgress: msg => setSubstatus(`[Summary] ${msg}`),
      });
      record.steps.quick_summary = { ms: qs.ms, tokens: qs.tokens };
      record.extracted_headline = qs.parsed?.headline || null;
      record.extracted_summary  = qs.parsed?.summary  || null;
      record.sentiment          = qs.parsed?.sentiment || null;
    } catch (err) {
      console.warn(`[poller] Quick summary failed for ${id}: ${err.message}`);
      record.steps.quick_summary = { error: err.message };
    }
    record.status       = 'done';
    record.substatus    = null;
    record.processed_at = new Date().toISOString();
    record.log.push({ t: Date.now(), msg: 'Completed' });
    updateRecord(record);

  } finally {
    fs.unlink(filePath, () => {});
  }
}

// ── Update record in store + persist + broadcast ────────────────────
function updateRecord(record) {
  announcementStore.set(record.id, record);
  broadcastDashboard(record);
  debouncedPersist();
}

function debouncedPersist() {
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    persistAnnouncements();
  }, 2000);
}

function persistAnnouncements() {
  const arr = [...announcementStore.values()].sort(
    (a, b) => new Date(b.bse_time) - new Date(a.bse_time)
  );
  saveAnnouncements(arr);
}

// ── Simple semaphore ─────────────────────────────────────────────────
function createSemaphore(concurrency) {
  let running = 0;
  const queue = [];
  return function acquire() {
    return new Promise(resolve => {
      const tryRun = () => {
        if (running < concurrency) {
          running++;
          resolve(() => {
            running--;
            if (queue.length) queue.shift()();
          });
        } else {
          queue.push(tryRun);
        }
      };
      tryRun();
    });
  };
}

// ── Poller state ─────────────────────────────────────────────────────
let pollerRunning  = false;
let pollerTimer    = null;
let lastPollTime   = null;
let nextPollTime   = null;
let totalSeen      = 0;
let totalProcessed = 0;
let seenIds        = new Set();
let pollerCfgGetter = null;
let pollIntervalMs  = parseInt(process.env.POLL_INTERVAL_MS, 10) || 90000;
let pollerStartedAt    = null;
let isFirstPoll        = true;
let pollerCfgOverrides = {};
let pollerConcurrency  = 2;
const SEED_COUNT       = 5;

// ── Main poll function ───────────────────────────────────────────────
async function doPoll() {
  if (!pollerRunning) return;
  lastPollTime = new Date().toISOString();
  console.log(`[poller] Poll started at ${lastPollTime}`);

  const baseCfg = pollerCfgGetter ? pollerCfgGetter() : {};
  const cfg = { ...baseCfg, ...pollerCfgOverrides };

  const seedMode = isFirstPoll;
  if (isFirstPoll) isFirstPoll = false;

  const candidateItems = [];

  for (const cat of BSE_CATEGORIES) {
    try {
      const resp = await fetchBseCategory(cat);
      const items = resp?.Table || [];
      console.log(`[poller] Category "${cat}": ${items.length} items`);

      for (const item of items) {
        const newsId = item.NEWSID;
        if (!newsId || seenIds.has(newsId)) continue;

        const itemTime = new Date(item.DT_TM || item.News_submission_dt || 0);

        if (!seedMode && pollerStartedAt && itemTime < pollerStartedAt) {
          seenIds.add(newsId);
          continue;
        }

        candidateItems.push({ item, cat, itemTime });
      }
    } catch (err) {
      console.error(`[poller] Error fetching category "${cat}": ${err.message}`);
    }
  }

  let toIngest = candidateItems;
  if (seedMode && candidateItems.length > SEED_COUNT) {
    candidateItems.sort((a, b) => b.itemTime - a.itemTime);
    const skipped = candidateItems.slice(SEED_COUNT);
    for (const { item } of skipped) seenIds.add(item.NEWSID);
    toIngest = candidateItems.slice(0, SEED_COUNT);
    console.log(`[poller] Seed mode: picked ${SEED_COUNT} most recent out of ${candidateItems.length}`);
  }

  const newItems = [];

  for (const { item, cat } of toIngest) {
    const newsId = item.NEWSID;
    seenIds.add(newsId);
    totalSeen++;

    const pdfUrl = item.ATTACHMENTNAME
      ? `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${item.ATTACHMENTNAME}`
      : null;

    const record = {
      id:               newsId,
      scrip_cd:         item.SCRIP_CD || null,
      company:          item.SLONGNAME || '',
      headline:         item.HEADLINE || item.NEWSSUB || '',
      bse_time:         item.DT_TM || item.News_submission_dt || new Date().toISOString(),
      bse_category:     item.CATEGORYNAME || cat,
      bse_subcategory:  item.SUBCATNAME || '',
      pdf_url:          pdfUrl,
      bse_url:          item.NSURL || null,
      attachment_name:  item.ATTACHMENTNAME || null,
      smart_subcategory: null,
      route:            null,
      status:           'pending',
      error:            null,
      extracted_headline: null,
      extracted_summary:  null,
      sentiment:          null,
      extracted:          null,
      _classifier_confidence: null,
      _classifier_rationale:  null,
      _secondary_events:      [],
      processed_at: null,
    };

    announcementStore.set(newsId, record);
    newItems.push(record);
    broadcastDashboard(record);
  }

  saveSeenIds(seenIds);
  persistAnnouncements();

  console.log(`[poller] ${newItems.length} new announcements to process`);

  // Sort oldest first → FIFO
  newItems.sort((a, b) => new Date(a.bse_time) - new Date(b.bse_time));

  // Mark items without PDF first
  for (const record of newItems.filter(r => !r.pdf_url)) {
    record.status = 'error';
    record.error  = 'No PDF attachment';
    record.processed_at = new Date().toISOString();
    updateRecord(record);
  }

  // Process with configurable concurrency (semaphore)
  const processable = newItems.filter(r => r.pdf_url);
  // Mark items beyond concurrency limit as queued
  for (let i = 0; i < processable.length; i++) {
    if (i >= pollerConcurrency) {
      processable[i].status = 'queued';
      processable[i].substatus = `Waiting (position ${i - pollerConcurrency + 1} in queue)`;
      updateRecord(processable[i]);
    }
  }
  const sem = createSemaphore(pollerConcurrency);
  await Promise.all(processable.map(async (record) => {
    const release = await sem();
    try {
      console.log(`[poller] Processing ${record.id} — ${record.company} — ${record.bse_subcategory}`);
      await processAnnouncement(record, cfg);
      totalProcessed++;
      console.log(`[poller] Done ${record.id} → status: ${record.status}`);
    } catch (err) {
      console.error(`[poller] Unhandled error for ${record.id}: ${err.message}`);
      record.status = 'error';
      record.error  = err.message;
      record.processed_at = new Date().toISOString();
      updateRecord(record);
    } finally {
      release();
    }
  }));

  console.log(`[poller] Poll complete. totalSeen=${totalSeen}, totalProcessed=${totalProcessed}`);

  if (pollerRunning) {
    nextPollTime = new Date(Date.now() + pollIntervalMs).toISOString();
    pollerTimer = setTimeout(doPoll, pollIntervalMs);
  }
}

// ── Public API ───────────────────────────────────────────────────────
export function startPoller(app, getDefaultCfg) {
  ensureDataDir();

  // Load persisted data
  seenIds = loadSeenIds();
  const existing = loadAnnouncements();
  for (const rec of existing) {
    announcementStore.set(rec.id, rec);
  }
  totalSeen = seenIds.size;
  totalProcessed = existing.filter(r => r.status === 'done').length;

  pollerCfgGetter = getDefaultCfg;

  // Wire up Express endpoints
  app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
  });

  // SSE stream for dashboard
  app.get('/dashboard-stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Send all existing records immediately
    const all = [...announcementStore.values()].sort(
      (a, b) => new Date(b.bse_time) - new Date(a.bse_time)
    );
    for (const record of all) {
      const light = { ...record };
      delete light.extracted;
      delete light.log;
      res.write(`event: update\ndata: ${JSON.stringify(light)}\n\n`);
    }

    // Send heartbeat so client knows it's alive
    res.write(`event: connected\ndata: ${JSON.stringify({ count: all.length })}\n\n`);

    // Register for future broadcasts — send lightweight version (no huge extracted/log)
    const cb = (record) => {
      try {
        const light = { ...record };
        delete light.extracted;
        delete light.log;
        res.write(`event: update\ndata: ${JSON.stringify(light)}\n\n`);
      }
      catch (e) { console.error('[poller] SSE write error:', e.message); }
    };
    onBroadcast(cb);

    // Heartbeat every 25s to keep connection alive
    const heartbeat = setInterval(() => {
      try { res.write(': heartbeat\n\n'); }
      catch { clearInterval(heartbeat); }
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      const idx = broadcastCallbacks.indexOf(cb);
      if (idx !== -1) broadcastCallbacks.splice(idx, 1);
    });
  });

  app.get('/api/announcements', (req, res) => {
    const all = [...announcementStore.values()].sort(
      (a, b) => new Date(b.bse_time) - new Date(a.bse_time)
    );
    res.json(all);
  });

  app.get('/api/announcements/:id', (req, res) => {
    const record = announcementStore.get(req.params.id);
    if (!record) return res.status(404).json({ error: 'Not found' });
    res.json(record);
  });

  app.post('/api/poller/start', (req, res) => {
    if (pollerRunning) return res.json({ ok: true, message: 'Poller already running' });

    const body = req.body || {};
    if (body.intervalMs)     pollIntervalMs = parseInt(body.intervalMs, 10) || pollIntervalMs;
    if (body.concurrency)    { const n = parseInt(body.concurrency, 10); if (n >= 1 && n <= 4) pollerConcurrency = n; }
    pollerCfgOverrides = {
      apiKey:          body.apiKey          || pollerCfgOverrides.apiKey,
      modelStep1:      body.modelStep1      || 'gemini-3.1-flash-lite-preview',
      modelStep2:      body.modelStep2      || 'gemini-3.1-flash-lite-preview',
      maxTokensStep1:  parseInt(body.maxTokensStep1, 10) || 8192,
      maxTokensStep2:  parseInt(body.maxTokensStep2, 10) || 65536,
      thinkingStep1:   body.thinkingStep1   || 'MINIMAL',
      thinkingStep2:   body.thinkingStep2   || 'MINIMAL',
      temperature:     body.temperature != null ? parseFloat(body.temperature) : 1,
      mime:            body.mime             || 'application/json',
    };

    pollerRunning   = true;
    pollerStartedAt = new Date();
    isFirstPoll     = true;
    nextPollTime    = new Date(Date.now() + 500).toISOString();
    pollerTimer     = setTimeout(doPoll, 500);
    console.log(`[poller] Started — seeding ${SEED_COUNT} most recent, then live only`);
    res.json({ ok: true, message: 'Poller started' });
  });

  app.post('/api/poller/stop', (req, res) => {
    pollerRunning   = false;
    pollerStartedAt = null;
    if (pollerTimer) { clearTimeout(pollerTimer); pollerTimer = null; }
    nextPollTime = null;
    console.log('[poller] Stopped');
    res.json({ ok: true, message: 'Poller stopped' });
  });

  app.post('/api/poller/clear', (req, res) => {
    if (pollerRunning) return res.status(400).json({ ok: false, error: 'Stop the poller first' });
    announcementStore.clear();
    seenIds = new Set();
    totalSeen = 0;
    totalProcessed = 0;
    saveSeenIds(seenIds);
    persistAnnouncements();
    console.log('[poller] Data cleared');
    res.json({ ok: true, message: 'All data cleared' });
  });

  app.get('/api/poller/status', (req, res) => {
    res.json({
      running:        pollerRunning,
      lastPoll:       lastPollTime,
      nextPoll:       nextPollTime,
      totalSeen:      totalSeen,
      totalProcessed: totalProcessed,
      intervalMs:     pollIntervalMs,
    });
  });

  console.log('[poller] Initialized. Endpoints registered. Use POST /api/poller/start to begin polling.');
}
