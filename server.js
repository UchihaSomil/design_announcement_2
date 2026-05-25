import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { startPoller } from './poller.js';

const require = createRequire(import.meta.url);
const PDFParser = require('pdf2json');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env if present — minimal parser, no dotenv dep needed.
// .env is gitignored so the key never leaves the machine.
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    });
    console.log(`[env] Loaded .env from ${envPath}`);
  }
} catch (err) {
  console.warn(`[env] Failed to load .env: ${err.message}`);
}
const app = express();
const upload = multer({ dest: path.join(__dirname, 'uploads/') });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// /new — simplified pipeline page (text-mode classify on first 5 pages → base64 extract).
app.get('/new', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'new.html')));

// /final — focused pipeline. Step 1 enriched (classify + headline + summary + key_facts) for ALL 24.
// Step 2 only for Financial Updates and Order Win. Uses isolated prompts in system_prompts_final/.
app.get('/final', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'final.html')));

// ── SSE ──────────────────────────────────────────────────────────
const clients = new Map();

// Short-lived store so the /retry endpoint can re-use the same PDF contents + cfg
// that the original job used. Kept small (TTL 30 min).
const jobMemory = new Map();
function setJobMemory(requestId, data) {
  jobMemory.set(requestId, { ...data, savedAt: Date.now() });
  // GC entries older than 30 min.
  for (const [k, v] of jobMemory.entries()) {
    if (Date.now() - v.savedAt > 30 * 60 * 1000) jobMemory.delete(k);
  }
}

function sendEvent(requestId, event, data) {
  const safeName = event === 'error' ? 'fail' : event;
  const line = `event: ${safeName}\ndata: ${JSON.stringify(data)}\n\n`;
  const entry = clients.get(requestId);
  if (!entry) return;
  if (entry.res) entry.res.write(line);
  else entry.buffer.push(line);
}

app.get('/stream/:requestId', (req, res) => {
  const { requestId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const entry = clients.get(requestId);
  if (entry) {
    entry.res = res;
    for (const line of entry.buffer) res.write(line);
    entry.buffer = [];
  } else {
    clients.set(requestId, { res, buffer: [] });
  }
  req.on('close', () => { const e = clients.get(requestId); if (e) e.res = null; });
});

// ── Helpers ───────────────────────────────────────────────────────
function extractTextFromPDF(pdfPath) {
  return new Promise((resolve, reject) => {
    const parser = new PDFParser();
    parser.on('pdfParser_dataReady', data => {
      const safe = s => { try { return decodeURIComponent(s); } catch { return s; } };
      resolve(data.Pages.map(pg => pg.Texts.map(t => safe(t.R.map(r => r.T).join(''))).join(' ')).join('\n'));
    });
    parser.on('pdfParser_dataError', err => reject(new Error(err.parserError || String(err))));
    parser.loadPDF(pdfPath);
  });
}

// Extract only the first N pages of a PDF as text.
// Used by the /new pipeline to keep Step-1 classifier input small (~80–90% token saving).
function extractFirstNPagesOfPDF(pdfPath, n = 5) {
  return new Promise((resolve, reject) => {
    const parser = new PDFParser();
    parser.on('pdfParser_dataReady', data => {
      const safe = s => { try { return decodeURIComponent(s); } catch { return s; } };
      const total = data.Pages.length;
      const text = data.Pages.slice(0, n)
        .map(pg => pg.Texts.map(t => safe(t.R.map(r => r.T).join(''))).join(' '))
        .join('\n');
      resolve({ text, totalPages: total, pagesUsed: Math.min(n, total) });
    });
    parser.on('pdfParser_dataError', err => reject(new Error(err.parserError || String(err))));
    parser.loadPDF(pdfPath);
  });
}

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

// ── Prompt loading ────────────────────────────────────────────────
const SYSTEM_INSTRUCTION = fs.readFileSync(path.join(__dirname, 'system_prompt.txt'), 'utf8');

function loadPrompt(name) {
  const safe = name.replace(/[^a-z0-9_]/gi, '');
  try { return fs.readFileSync(path.join(__dirname, 'system_prompts', `${safe}.md`), 'utf8'); }
  catch { return null; }
}

// /final has its own isolated prompt set in system_prompts_final/ — independent of /new and /.
function loadPromptFinal(name) {
  const safe = name.replace(/[^a-z0-9_]/gi, '');
  try { return fs.readFileSync(path.join(__dirname, 'system_prompts_final', `${safe}.md`), 'utf8'); }
  catch { return null; }
}

// Map for /final: only Financial Updates and Order Win get Step 2.
const FINAL_STEP2_PROMPT_FILES = {
  'Financial Updates': 'step2_financial_updates',
  'Order Win':         'step2_order_win',
};

// Serve default prompt files so the UI modal can display them.
app.get('/prompts/:name', (req, res) => {
  const txt = loadPrompt(req.params.name);
  if (txt == null) return res.status(404).send('');
  res.type('text/plain').send(txt);
});

// ── Unit conversion (Step 2 Financial Updates) ────────────────────
// LLM emits raw values + a per-block unit declaration; server converts to ₹ Cr deterministically.
// Per-block declarations live at: smart_subcategory_specific._unit_declaration[blockKey] = "lakhs"|"crores"|"millions"|"billions"|"thousands"|null
//
// Multipliers convert the RAW value into ₹ Cr.
const UNIT_TO_CR = {
  crores:    1,         // already in Cr
  lakhs:     0.01,      // 100 Lakhs = 1 Cr
  millions:  0.1,       // 10 Mn = 1 Cr
  billions:  100,       // 1 Bn = 100 Cr
  thousands: 0.0001,    // very rare but supported
};

// Field names that are NOT monetary — never scale these.
// Per-share ₹ values, ratios, counts, and operational unit measurements (MT, MW, MU, sqft, units, etc.)
// are unit-agnostic and stay as-is. Anything ending in _percent / _pct / _ratio / _bps / _days
// is also skipped via the suffix rules in isNonMonetaryFieldName().
const NON_MONETARY_EXACT = new Set([
  'eps_basic','eps_diluted','face_value','book_value_per_share','dividend_per_share_rs',
  'debt_to_equity','asset_turnover','solvency_ratio','interest_coverage_ratio',
  'number_of_shareholders','number_of_offices','number_of_individual_agents','number_of_policies_issued',
  'units','volume','realisation_per_unit','realisation_per_tonne','grm_usd_per_bbl',
  'production_mt','sales_mt','generation_mu','installed_capacity_mw',
  'ask','rpk','passengers_flown','fleet_size','keys_operational','new_keys_added',
  'arr','revpar',
  'store_count_opening','store_count_closing','new_stores_added','stores_closed',
  'bookings_volume_sqft','new_launches_sqft','sales_volume_sqft',
]);

function isNonMonetaryFieldName(key) {
  if (!key) return false;
  if (NON_MONETARY_EXACT.has(key)) return true;
  // Suffix-based: anything ending in _percent / _pct / _ratio / _bps / _days / _date / _id / _mt / _mw / _bbl / _mu / _ape_pct / _yoy is non-monetary or already in its own unit.
  if (/_percent$|_pct$|_ratio$|_bps$|_days$|_date$|_id$|_mt$|_mw$|_mu$|_pp$|_yoy$|_qoq$/i.test(key)) return true;
  return false;
}

function scaleNumberDeep(val, mult, parentKey) {
  if (val == null) return val;
  if (Array.isArray(val)) return val.map(v => scaleNumberDeep(v, mult, parentKey));
  if (typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      // Skip non-monetary fields entirely.
      if (isNonMonetaryFieldName(k)) { out[k] = v; continue; }
      // Some object-keys hold structured non-monetary data — descend without scaling.
      if (k === 'evidence' || k.startsWith('_')) { out[k] = v; continue; }
      out[k] = scaleNumberDeep(v, mult, k);
    }
    return out;
  }
  if (typeof val === 'number') {
    if (parentKey && isNonMonetaryFieldName(parentKey)) return val;
    return Math.round(val * mult * 100) / 100;
  }
  return val; // strings, booleans — leave as-is
}

// Maps from `_unit_declaration` keys → list of paths in `smart_subcategory_specific` whose monetary numbers should be scaled.
// Each path is an array of { key, isArray? }. Arrays mean: scale every element in the array.
const UNIT_BLOCK_TARGETS = {
  pnl:               [{ key: 'pnl_by_period', isArray: true }],
  balance_sheet:     [{ key: 'balance_sheet_by_period', isArray: true }],
  cash_flow:         [{ key: 'cash_flow_by_period', isArray: true }],
  segment_results:   [{ key: 'segment_results', isArray: true }],
  revenue_mix:       [{ key: 'revenue_mix_by_period', isArray: true }],
  banking_specific:  [{ path: ['banking_nbfc_specific', 'bank_specific', 'entries'], isArray: true }],
  nbfc_hfc_specific: [{ path: ['banking_nbfc_specific', 'nbfc_hfc_specific', 'entries'], isArray: true }],
  insurance_life:    [{ path: ['insurance_specific', 'life_specific', 'entries'], isArray: true }],
  insurance_general: [{ path: ['insurance_specific', 'general_specific', 'entries'], isArray: true }],
  operational_metrics: [{ key: 'operational_metrics' }],
  dividend_embedded:   [{ key: 'dividend_embedded' }],
  other_insights:      [{ key: 'other_insights' }],
};

// Apply conversions in place on `spec` (the smart_subcategory_specific object).
// Returns a `_unit_detection` summary that's safe to surface in the response.
function applyUnitDeclarationConversion(spec) {
  if (!spec || typeof spec !== 'object') return { applied: false, reason: 'no spec' };
  const decl = spec._unit_declaration || {};
  const detection = { applied: true, declaration: {}, conversions: [] };

  for (const [blockKey, targets] of Object.entries(UNIT_BLOCK_TARGETS)) {
    const declaredUnit = (decl[blockKey] || '').toLowerCase();
    if (!declaredUnit || declaredUnit === 'crores') {
      detection.declaration[blockKey] = declaredUnit || null;
      continue; // null or already-Cr → no scaling needed
    }
    const mult = UNIT_TO_CR[declaredUnit];
    if (mult == null) {
      detection.declaration[blockKey] = `${declaredUnit} (UNKNOWN — left unscaled)`;
      continue;
    }
    detection.declaration[blockKey] = declaredUnit;

    for (const t of targets) {
      // Resolve the target object/array.
      const path = t.path || [t.key];
      let parent = spec;
      for (let i = 0; i < path.length - 1; i++) {
        if (!parent || typeof parent !== 'object') { parent = null; break; }
        parent = parent[path[i]];
      }
      if (!parent || typeof parent !== 'object') continue;
      const lastKey = path[path.length - 1];
      const node = parent[lastKey];
      if (node == null) continue;

      if (Array.isArray(node)) {
        parent[lastKey] = node.map(entry => scaleNumberDeep(entry, mult, null));
        detection.conversions.push({ block: blockKey, unit: declaredUnit, mult, target: path.join('.'), entries: node.length });
      } else if (typeof node === 'object') {
        parent[lastKey] = scaleNumberDeep(node, mult, null);
        detection.conversions.push({ block: blockKey, unit: declaredUnit, mult, target: path.join('.') });
      }
    }
  }
  return detection;
}

// Map smart_subcategory -> step2 prompt file slug. Only Financial Updates is wired up for now.
const STEP2_PROMPT_FILES = {
  'Financial Updates':                     'step2_financial_updates',
  'Concall/Presentation':                  'step2_concall_presentation',
  'Dividend':                              'step2_dividend',
  'Buyback':                               'step2_buyback',
  'Bonus/Stock Split':                     'step2_bonus_stock_split',
  'Acquisition':                           'step2_acquisition',
  'Merger/Demerger':                       'step2_merger_demerger',
  'Joint Venture/Strategic Partnership':   'step2_joint_venture',
  'Order Win':                             'step2_order_win',
  'Capacity Expansion/Capex':              'step2_capacity_expansion',
  'Product Launch':                        'step2_product_launch',
  'Fund Raising':                          'step2_fund_raising',
  'Stake Sale/Disinvestment':              'step2_stake_sale',
  'Credit Rating Change':                  'step2_credit_rating_change',
  'Regulatory Action/Penalty':             'step2_regulatory_action',
  'Fraud/Default':                         'step2_fraud_default',
  'Insolvency/CIRP':                       'step2_insolvency_cirp',
  'Open Offer/Takeover':                   'step2_open_offer',
  'Promoter Buy/Sell':                     'step2_promoter_buy_sell',
  'Change in Key Management':              'step2_change_in_key_management',
  'Operational Disruption':                'step2_operational_disruption',
  'Others':                                'step2_others',
  'Routine/Administrative':                'step2_routine_administrative',
  'Regulatory Approval/Licensing':         'step2_regulatory_approval',
};

// ── Context cache manager ─────────────────────────────────────────
// Keyed by apiKey+model+cacheTag so each combination gets its own cache.
const cacheStore = new Map();
const CACHEABLE_MODELS = ['gemini-3.1-flash-lite-preview', 'gemini-2.5-flash', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-3.1-pro-preview'];
const CACHE_TTL_SECS = 23 * 60 * 60;
const CACHE_REFRESH_BEFORE_SECS = 30 * 60;

async function getOrCreateCache(apiKey, modelId, systemText, cacheTag) {
  if (!CACHEABLE_MODELS.includes(modelId)) return null;

  const key = `${apiKey}::${modelId}::${cacheTag || 'default'}`;
  const existing = cacheStore.get(key);

  if (existing) {
    const secsRemaining = (existing.expiresAt - Date.now()) / 1000;
    if (secsRemaining > CACHE_REFRESH_BEFORE_SECS) {
      return existing.cacheName;
    }
    console.log(`[cache] Refreshing cache for ${modelId}/${cacheTag || 'default'} (${Math.round(secsRemaining / 60)}m remaining)`);
  }

  const ai = new GoogleGenAI({ apiKey });
  try {
    const cache = await ai.caches.create({
      model: modelId,
      config: {
        systemInstruction: { parts: [{ text: systemText }] },
        ttl: `${CACHE_TTL_SECS}s`,
      },
    });
    cacheStore.set(key, {
      cacheName: cache.name,
      expiresAt: Date.now() + CACHE_TTL_SECS * 1000,
    });
    console.log(`[cache] Created cache ${cache.name} for ${modelId}/${cacheTag || 'default'}, TTL ${CACHE_TTL_SECS / 3600}h`);
    return cache.name;
  } catch (err) {
    console.warn(`[cache] Failed to create cache for ${modelId}/${cacheTag || 'default'} (${err.message}) — falling back to inline system prompt`);
    return null;
  }
}

// ── Groq call (OpenAI-compatible chat.completions) ────────────────
// Groq is text-only — no PDF/image support. `contents` is converted by extracting any text parts.
async function callGroq(requestId, cfg, contents, systemPromptText, opts = {}) {
  const { stepTag = null, emitDone = true } = opts;
  const apiKey = cfg.groqApiKey || process.env.GROQ_API_KEY;
  if (!apiKey) {
    sendEvent(requestId, 'fail', { message: 'No Groq API key provided. Paste it in the sidebar.', step: stepTag });
    return null;
  }
  const modelId = cfg.groqModel || 'llama-3.3-70b-versatile';

  // Flatten `contents` (Gemini-shaped messages) into plain user text for Groq.
  const userText = (contents || [])
    .flatMap(msg => (msg.parts || []))
    .map(p => p.text || '')
    .filter(Boolean)
    .join('\n\n');

  if (!userText || userText.length < 20) {
    sendEvent(requestId, 'fail', {
      message: 'Groq is text-only and no extractable text was found. Use Text mode (not Base64/Files API) with a text-layer PDF.',
      step: stepTag,
    });
    return null;
  }

  sendEvent(requestId, 'cache', { hit: false, step: stepTag });

  const body = {
    model: modelId,
    messages: [
      { role: 'system', content: systemPromptText },
      { role: 'user',   content: userText },
    ],
    response_format: { type: 'json_object' },
    temperature: cfg.temperature != null ? cfg.temperature : 0,
    max_tokens: cfg.maxTokens || 32768,
  };

  const MAX_RETRIES = 4;
  const RETRYABLE = [429, 500, 502, 503];
  let fullResponse = '';
  let usageMeta = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    fullResponse = '';
    const t0 = Date.now();
    sendEvent(requestId, 'attempt', { attempt, total: MAX_RETRIES, step: stepTag });

    try {
      const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`HTTP ${resp.status} — ${errText.slice(0, 200)}`);
      }
      const json = await resp.json();
      fullResponse = json.choices?.[0]?.message?.content || '';
      if (json.usage) {
        usageMeta = {
          promptTokenCount: json.usage.prompt_tokens,
          candidatesTokenCount: json.usage.completion_tokens,
          totalTokenCount: json.usage.total_tokens,
        };
      }
      sendEvent(requestId, 'chunk', { partial: fullResponse.slice(-300), step: stepTag });
      sendEvent(requestId, 'attempt_done', { attempt, ms: Date.now() - t0, success: true, step: stepTag });
      break;
    } catch (err) {
      const ms = Date.now() - t0;
      const isRetryable = RETRYABLE.some(c => String(err.message).includes(String(c)));
      sendEvent(requestId, 'attempt_done', { attempt, ms, success: false, error: err.message, step: stepTag });
      if (isRetryable && attempt < MAX_RETRIES) {
        const wait = attempt * 8;
        sendEvent(requestId, 'retry', { attempt, nextAttempt: attempt + 1, total: MAX_RETRIES, waitSecs: wait, step: stepTag });
        await new Promise(r => setTimeout(r, wait * 1000));
        continue;
      }
      sendEvent(requestId, 'fail', { message: `Groq API failed after ${attempt} attempt(s): ${err.message}`, step: stepTag });
      return null;
    }
  }

  if (usageMeta) {
    sendEvent(requestId, 'tokens', {
      input: usageMeta.promptTokenCount || 0,
      output: usageMeta.candidatesTokenCount || 0,
      total: usageMeta.totalTokenCount || 0,
      step: stepTag,
    });
  }

  sendEvent(requestId, 'stage', { stage: 'parsing', message: 'Parsing JSON response...', step: stepTag });

  let parsed;
  try {
    const raw = JSON.parse(fullResponse);
    parsed = Array.isArray(raw) ? raw[0] : raw;
  } catch {
    sendEvent(requestId, 'fail', { message: 'Groq response was not valid JSON.', step: stepTag });
    return null;
  }

  if (emitDone) sendEvent(requestId, 'done', { result: parsed });
  return { parsed, usageMeta };
}

// ── OpenAI call (chat.completions) ────────────────────────────────
// Supports text mode (always) and base64 PDF mode (on gpt-4o, gpt-4o-mini, gpt-4.1 family).
// Files API mode is not supported — falls back to text.
async function callOpenAI(requestId, cfg, contents, systemPromptText, opts = {}) {
  const { stepTag = null, emitDone = true } = opts;
  const apiKey = cfg.openaiApiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    sendEvent(requestId, 'fail', { message: 'No OpenAI API key provided. Paste it in the sidebar.', step: stepTag });
    return null;
  }
  const modelId = cfg.openaiModel || 'gpt-4o-mini';

  // Detect whether the contents include a base64 PDF (inlineData with mimeType application/pdf).
  let inlinePdf = null;
  let userText = '';
  for (const msg of contents || []) {
    for (const p of (msg.parts || [])) {
      if (p.text) userText += (userText ? '\n\n' : '') + p.text;
      if (p.inlineData && p.inlineData.mimeType === 'application/pdf' && p.inlineData.data) {
        inlinePdf = p.inlineData.data;
      }
      // fileData (Gemini Files API URI) — OpenAI cannot read this. Fall through to text only.
    }
  }

  if (!inlinePdf && (!userText || userText.length < 20)) {
    sendEvent(requestId, 'fail', {
      message: 'OpenAI received no extractable content. Use Text mode (extracted PDF text) or Base64 mode (raw PDF inline). Files API mode is Gemini-only.',
      step: stepTag,
    });
    return null;
  }

  // Build OpenAI message content. For base64 PDFs use the multi-part `content` array.
  const userContent = inlinePdf
    ? [
        { type: 'text', text: userText || 'Extract structured data from this filing.' },
        { type: 'file', file: { filename: 'filing.pdf', file_data: `data:application/pdf;base64,${inlinePdf}` } },
      ]
    : userText;

  sendEvent(requestId, 'cache', { hit: false, step: stepTag });

  // Reasoning models (o1/o3/o4/gpt-5 family) don't support temperature or `max_tokens`.
  const isReasoning = /^(o1|o3|o4|gpt-5)/i.test(modelId);
  const body = {
    model: modelId,
    messages: [
      { role: 'system', content: systemPromptText },
      { role: 'user',   content: userContent },
    ],
    response_format: { type: 'json_object' },
  };
  if (isReasoning) {
    body.max_completion_tokens = cfg.maxTokens || 32768;
  } else {
    body.max_tokens  = cfg.maxTokens || 32768;
    body.temperature = cfg.temperature != null ? cfg.temperature : 0;
  }

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (cfg.openaiOrg)     headers['OpenAI-Organization'] = cfg.openaiOrg;
  if (cfg.openaiProject) headers['OpenAI-Project']      = cfg.openaiProject;

  const MAX_RETRIES = 4;
  const RETRYABLE = [429, 500, 502, 503, 504];
  let fullResponse = '';
  let usageMeta = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    fullResponse = '';
    const t0 = Date.now();
    sendEvent(requestId, 'attempt', { attempt, total: MAX_RETRIES, step: stepTag });

    try {
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`HTTP ${resp.status} — ${errText.slice(0, 300)}`);
      }
      const json = await resp.json();
      fullResponse = json.choices?.[0]?.message?.content || '';
      if (json.usage) {
        usageMeta = {
          promptTokenCount: json.usage.prompt_tokens,
          candidatesTokenCount: json.usage.completion_tokens,
          totalTokenCount: json.usage.total_tokens,
        };
      }
      sendEvent(requestId, 'chunk', { partial: fullResponse.slice(-300), step: stepTag });
      sendEvent(requestId, 'attempt_done', { attempt, ms: Date.now() - t0, success: true, step: stepTag });
      break;
    } catch (err) {
      const ms = Date.now() - t0;
      const isRetryable = RETRYABLE.some(c => String(err.message).includes(String(c)));
      sendEvent(requestId, 'attempt_done', { attempt, ms, success: false, error: err.message, step: stepTag });
      if (isRetryable && attempt < MAX_RETRIES) {
        const wait = attempt * 8;
        sendEvent(requestId, 'retry', { attempt, nextAttempt: attempt + 1, total: MAX_RETRIES, waitSecs: wait, step: stepTag });
        await new Promise(r => setTimeout(r, wait * 1000));
        continue;
      }
      sendEvent(requestId, 'fail', { message: `OpenAI API failed after ${attempt} attempt(s): ${err.message}`, step: stepTag });
      return null;
    }
  }

  if (usageMeta) {
    sendEvent(requestId, 'tokens', {
      input: usageMeta.promptTokenCount || 0,
      output: usageMeta.candidatesTokenCount || 0,
      total: usageMeta.totalTokenCount || 0,
      step: stepTag,
    });
  }

  sendEvent(requestId, 'stage', { stage: 'parsing', message: 'Parsing JSON response...', step: stepTag });

  let parsed;
  try {
    const raw = JSON.parse(fullResponse);
    parsed = Array.isArray(raw) ? raw[0] : raw;
  } catch {
    sendEvent(requestId, 'fail', { message: 'OpenAI response was not valid JSON.', step: stepTag });
    return null;
  }

  if (emitDone) sendEvent(requestId, 'done', { result: parsed });
  return { parsed, usageMeta };
}

// Provider dispatch — Gemini, Groq, or OpenAI.
async function callProvider(requestId, cfg, contents, systemPromptText, opts = {}) {
  if (cfg.provider === 'groq')   return callGroq(requestId, cfg, contents, systemPromptText, opts);
  if (cfg.provider === 'openai') return callOpenAI(requestId, cfg, contents, systemPromptText, opts);
  return callGemini(requestId, cfg, contents, systemPromptText, opts);
}

// ── Shared Gemini call ────────────────────────────────────────────
async function callGemini(requestId, cfg, contents, systemPromptText, opts = {}) {
  const { stepTag = null, cacheTag = null, emitDone = true } = opts;
  const apiKey = cfg.apiKey || process.env.GEMINI_API_KEY;
  const ai = new GoogleGenAI({ apiKey });
  const modelId = cfg.model || 'gemini-3.1-flash-lite-preview';

  const cacheName = cacheTag ? await getOrCreateCache(apiKey, modelId, systemPromptText, cacheTag) : null;

  const genConfig = {
    responseMimeType: cfg.mime || 'application/json',
  };

  if (cacheName) {
    genConfig.cachedContent = cacheName;
    sendEvent(requestId, 'cache', { hit: true, cacheName, step: stepTag });
  } else {
    genConfig.systemInstruction = [{ text: systemPromptText }];
    sendEvent(requestId, 'cache', { hit: false, step: stepTag });
  }

  const isGemma = modelId.startsWith('gemma-');
  if (isGemma) {
    genConfig.responseMimeType = 'text/plain';
  } else {
    const THINKING_MODELS = ['gemini-2.5', 'gemini-3'];
    const supportsThinking = THINKING_MODELS.some(p => modelId.includes(p));
    if (cfg.thinkingEnabled !== false && supportsThinking)
      genConfig.thinkingConfig = { thinkingLevel: ThinkingLevel[cfg.thinkingLevel] || ThinkingLevel.MINIMAL };
    if (cfg.temperature != null && !supportsThinking) genConfig.temperature = cfg.temperature;
  }
  if (cfg.maxTokens) genConfig.maxOutputTokens = cfg.maxTokens;

  const MAX_RETRIES = 4;
  const RETRYABLE = [429, 503, 502, 500];
  let fullResponse = '';
  let usageMeta = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    fullResponse = '';
    const t0 = Date.now();
    sendEvent(requestId, 'attempt', { attempt, total: MAX_RETRIES, step: stepTag });

    try {
      const stream = await ai.models.generateContentStream({
        model: modelId,
        config: genConfig,
        contents,
      });

      for await (const chunk of stream) {
        if (chunk.text) {
          fullResponse += chunk.text;
          sendEvent(requestId, 'chunk', { partial: fullResponse.slice(-300), step: stepTag });
        }
        if (chunk.usageMetadata) usageMeta = chunk.usageMetadata;
      }

      sendEvent(requestId, 'attempt_done', { attempt, ms: Date.now() - t0, success: true, step: stepTag });
      break;

    } catch (err) {
      const ms = Date.now() - t0;
      const isRetryable = RETRYABLE.some(c => String(err.message).includes(String(c)));
      sendEvent(requestId, 'attempt_done', { attempt, ms, success: false, error: err.message, step: stepTag });

      if (isRetryable && attempt < MAX_RETRIES) {
        const wait = attempt * 8;
        sendEvent(requestId, 'retry', { attempt, nextAttempt: attempt + 1, total: MAX_RETRIES, waitSecs: wait, step: stepTag });
        await new Promise(r => setTimeout(r, wait * 1000));
        continue;
      }
      sendEvent(requestId, 'fail', { message: `API failed after ${attempt} attempt(s): ${err.message}`, step: stepTag });
      return null;
    }
  }

  if (usageMeta) {
    sendEvent(requestId, 'tokens', {
      input: usageMeta.promptTokenCount || 0,
      output: usageMeta.candidatesTokenCount || 0,
      total: usageMeta.totalTokenCount || 0,
      step: stepTag,
    });
  }

  sendEvent(requestId, 'stage', { stage: 'parsing', message: 'Parsing JSON response...', step: stepTag });

  let parsed;
  try {
    const raw = JSON.parse(fullResponse);
    parsed = Array.isArray(raw) ? raw[0] : raw;
  } catch {
    sendEvent(requestId, 'fail', { message: 'Response was not valid JSON.', step: stepTag });
    return null;
  }

  if (emitDone) sendEvent(requestId, 'done', { result: parsed });
  return { parsed, usageMeta };
}

// ── Content preparation shared by Single and Double modes ─────────
async function prepareContents(filePath, filename, uploadMode, requestId, apiKey) {
  if (uploadMode === 'text') {
    sendEvent(requestId, 'stage', { stage: 'extracting', message: 'Parsing text from PDF...' });
    let text;
    try { text = await extractTextFromPDF(filePath); }
    catch (err) { sendEvent(requestId, 'fail', { message: `Text extraction failed: ${err.message}` }); return null; }
    if (!text || text.trim().length < 50) {
      sendEvent(requestId, 'fail', { message: 'Extracted text too short — may be a scanned PDF.' });
      return null;
    }
    sendEvent(requestId, 'stage', { stage: 'extracted', message: `Extracted ${text.length.toLocaleString()} characters` });
    sendEvent(requestId, 'extracted_text', { text, mode: 'text' });
    return [{ role: 'user', parts: [{ text: `filing_text:\n${text}` }] }];
  }

  if (uploadMode === 'base64') {
    sendEvent(requestId, 'stage', { stage: 'extracting', message: 'Encoding PDF as base64...' });
    let base64, sizeKb;
    try {
      const buffer = fs.readFileSync(filePath);
      base64 = buffer.toString('base64');
      sizeKb = (buffer.length / 1024).toFixed(1);
    } catch (err) {
      sendEvent(requestId, 'fail', { message: `Failed to read PDF: ${err.message}` });
      return null;
    }
    sendEvent(requestId, 'stage', { stage: 'extracted', message: `Encoded ${sizeKb} KB — sending inline` });
    sendEvent(requestId, 'extracted_text', { text: `[PDF sent as base64 inline — ${sizeKb} KB]\nThe model reads the raw PDF layout directly, including tables and formatting.`, mode: 'base64' });
    return [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: 'application/pdf', data: base64 } },
        { text: 'Extract structured data from this filing.' },
      ],
    }];
  }

  // filesapi
  sendEvent(requestId, 'stage', { stage: 'extracting', message: 'Uploading PDF to Gemini Files API...' });
  let fileUri;
  try {
    const ai = new GoogleGenAI({ apiKey });
    const buffer = fs.readFileSync(filePath);
    const blob = new Blob([buffer], { type: 'application/pdf' });
    const uploaded = await ai.files.upload({
      file: blob,
      config: { mimeType: 'application/pdf', displayName: filename },
    });
    fileUri = uploaded.uri;
  } catch (err) {
    sendEvent(requestId, 'fail', { message: `Files API upload failed: ${err.message}` });
    return null;
  }
  sendEvent(requestId, 'stage', { stage: 'extracted', message: 'Upload complete — file URI ready' });
  sendEvent(requestId, 'extracted_text', { text: `[PDF uploaded to Gemini Files API]\nFile URI: ${fileUri}\n\nGemini reads the PDF directly from its storage. File auto-deletes after 48 hours.`, mode: 'filesapi' });
  return [{
    role: 'user',
    parts: [
      { fileData: { mimeType: 'application/pdf', fileUri } },
      { text: 'Extract structured data from this filing.' },
    ],
  }];
}

// ── Single mode — one call with the existing ~7.8k-token prompt ───
async function runMode_single(filePath, filename, uploadMode, requestId, cfg) {
  const apiKey = cfg.apiKey || process.env.GEMINI_API_KEY;
  // Groq is text-only. OpenAI supports text + base64 (no Files API). Force compatible modes.
  let effectiveUploadMode = uploadMode;
  if (cfg.provider === 'groq') effectiveUploadMode = 'text';
  if (cfg.provider === 'openai' && uploadMode === 'filesapi') effectiveUploadMode = 'base64';
  const contents = await prepareContents(filePath, filename, effectiveUploadMode, requestId, apiKey);
  if (!contents) return;

  const providerLabel = cfg.provider === 'groq' ? 'Groq' : cfg.provider === 'openai' ? 'OpenAI' : 'Gemini';
  sendEvent(requestId, 'stage', { stage: 'calling_api', message: `Sending to ${providerLabel}...` });

  const systemText = cfg.systemPromptOverride
    ? cfg.systemPromptOverride + '\n\n' + SYSTEM_INSTRUCTION
    : SYSTEM_INSTRUCTION;

  await callProvider(requestId, cfg, contents, systemText, {
    cacheTag: cfg.systemPromptOverride ? null : 'default',
    emitDone: true,
  });
}

// ── Double mode — Step 1 classifier → Step 2 category extractor ───
async function runMode_double(filePath, filename, uploadMode, requestId, cfg) {
  const apiKey = cfg.apiKey || process.env.GEMINI_API_KEY;
  // Groq is text-only. OpenAI supports text + base64 (no Files API). Force compatible modes.
  let effectiveUploadMode = uploadMode;
  if (cfg.provider === 'groq') effectiveUploadMode = 'text';
  if (cfg.provider === 'openai' && uploadMode === 'filesapi') effectiveUploadMode = 'base64';
  const contents = await prepareContents(filePath, filename, effectiveUploadMode, requestId, apiKey);
  if (!contents) return;

  let classification;

  if (cfg.preChosenSubcategory) {
    if (!STEP2_PROMPT_FILES[cfg.preChosenSubcategory]) {
      sendEvent(requestId, 'fail', {
        message: `Step 2 extractor not yet built for "${cfg.preChosenSubcategory}". Currently supported: ${Object.keys(STEP2_PROMPT_FILES).map(s => `"${s}"`).join(', ')}. This is a valid smart_subcategory — just no extractor schema written for it yet.`,
      });
      return;
    }
    classification = {
      smart_subcategory: cfg.preChosenSubcategory,
      confidence: 100,
      rationale: 'User pre-selected subcategory; Step 1 skipped.',
      secondary_events: [],
    };
    sendEvent(requestId, 'classification', { ...classification, userPicked: true });
  } else {
    sendEvent(requestId, 'step', { step: 'step1', label: 'Classifying filing' });
    sendEvent(requestId, 'stage', { stage: 'calling_api', message: 'Step 1: classifying filing...', step: 'step1' });

    const step1Default = loadPrompt('step1_classifier');
    if (!step1Default && !cfg.step1PromptOverride) {
      sendEvent(requestId, 'fail', { message: 'Step 1 classifier prompt not found on server.' });
      return;
    }
    const step1Text = cfg.step1PromptOverride || step1Default;

    const s1 = await callProvider(requestId, cfg, contents, step1Text, {
      stepTag: 'step1',
      cacheTag: cfg.step1PromptOverride ? null : 'step1',
      emitDone: false,
    });
    if (!s1) return;
    classification = s1.parsed;
    sendEvent(requestId, 'classification', classification);

    if (!STEP2_PROMPT_FILES[classification.smart_subcategory]) {
      sendEvent(requestId, 'fail', {
        message: `Filing classified as "${classification.smart_subcategory}" (confidence ${classification.confidence}) — this IS a valid smart_subcategory per Step 1, but the Step 2 extractor hasn't been built for it yet. Currently built: ${Object.keys(STEP2_PROMPT_FILES).map(s => `"${s}"`).join(', ')}.`,
        classification,
      });
      return;
    }
  }

  const step2Slug = STEP2_PROMPT_FILES[classification.smart_subcategory];
  const step2Default = loadPrompt(step2Slug);
  const userOverride = cfg.step2PromptOverrides?.[classification.smart_subcategory];
  if (!step2Default && !userOverride) {
    sendEvent(requestId, 'fail', { message: `Step 2 prompt for "${classification.smart_subcategory}" not found on server.` });
    return;
  }
  const step2Text = userOverride || step2Default;

  sendEvent(requestId, 'step', { step: 'step2', label: `Extracting structured data (${classification.smart_subcategory})` });
  sendEvent(requestId, 'stage', { stage: 'calling_api', message: `Step 2: extracting ${classification.smart_subcategory}...`, step: 'step2' });

  const s2 = await callProvider(requestId, cfg, contents, step2Text, {
    stepTag: 'step2',
    cacheTag: userOverride ? null : `step2_${step2Slug}`,
    emitDone: false,
  });
  if (!s2) return;

  let unitDetectionDouble = null;
  if (s2.parsed?.smart_subcategory_specific && classification.smart_subcategory === 'Financial Updates') {
    unitDetectionDouble = applyUnitDeclarationConversion(s2.parsed.smart_subcategory_specific);
  }

  const merged = {
    smart_subcategory: classification.smart_subcategory,
    _classifier_confidence: classification.confidence,
    _classifier_rationale: classification.rationale,
    _secondary_events: classification.secondary_events || [],
    _unit_detection: unitDetectionDouble,
    ...s2.parsed,
  };

  // Remember enough to power a user-triggered retry call (e.g. "fetch missing standalone BS").
  setJobMemory(requestId, { contents, cfg });

  sendEvent(requestId, 'done', { result: merged });
}

// ── /new pipeline — text-mode classify on first 5 pages → base64 extract ──
// Provider chosen by user (Gemini or OpenAI). No other toggles.
async function runMode_simplified(filePath, filename, requestId, cfg) {

  // ── Step 1: classify using only the first 5 pages of text ──
  sendEvent(requestId, 'step', { step: 'step1', label: 'Classifying filing (first 5 pages, text mode)' });
  sendEvent(requestId, 'stage', { stage: 'extracting', message: 'Extracting first 5 pages as text...', step: 'step1' });

  let firstPagesText, totalPages, pagesUsed;
  try {
    const result = await extractFirstNPagesOfPDF(filePath, 5);
    firstPagesText = result.text;
    totalPages = result.totalPages;
    pagesUsed = result.pagesUsed;
  } catch (err) {
    sendEvent(requestId, 'fail', { message: `Step 1 text extraction failed: ${err.message}`, step: 'step1' });
    return;
  }

  if (!firstPagesText || firstPagesText.trim().length < 200) {
    sendEvent(requestId, 'fail', {
      message: `Step 1 found only ${firstPagesText?.trim().length || 0} chars in the first ${pagesUsed} pages — likely a scanned/image PDF. The /new pipeline requires a text-layer cover page.`,
      step: 'step1',
    });
    return;
  }

  sendEvent(requestId, 'stage', {
    stage: 'extracted',
    message: `Pulled ${firstPagesText.length.toLocaleString()} chars from ${pagesUsed} of ${totalPages} pages`,
    step: 'step1',
  });
  sendEvent(requestId, 'extracted_text', { text: firstPagesText, mode: 'text', step: 'step1' });

  const step1Contents = [{ role: 'user', parts: [{ text: `filing_text:\n${firstPagesText}` }] }];

  const step1Default = loadPrompt('step1_classifier');
  if (!step1Default && !cfg.step1PromptOverride) {
    sendEvent(requestId, 'fail', { message: 'Step 1 classifier prompt not found on server.' });
    return;
  }
  const step1Text = cfg.step1PromptOverride || step1Default;

  sendEvent(requestId, 'stage', { stage: 'calling_api', message: 'Step 1: classifying...', step: 'step1' });
  const s1 = await callProvider(requestId, cfg, step1Contents, step1Text, {
    stepTag: 'step1',
    cacheTag: cfg.step1PromptOverride ? null : 'step1',
    emitDone: false,
  });
  if (!s1) return;
  const classification = s1.parsed;
  sendEvent(requestId, 'classification', classification);

  if (!STEP2_PROMPT_FILES[classification.smart_subcategory]) {
    sendEvent(requestId, 'fail', {
      message: `Filing classified as "${classification.smart_subcategory}" (confidence ${classification.confidence}) — Step 2 extractor not yet built. Currently built: ${Object.keys(STEP2_PROMPT_FILES).map(s => `"${s}"`).join(', ')}.`,
      classification,
    });
    return;
  }

  // ── Step 2: extract structured data using base64 of full PDF ──
  sendEvent(requestId, 'step', { step: 'step2', label: `Extracting ${classification.smart_subcategory} (base64, full PDF)` });
  sendEvent(requestId, 'stage', { stage: 'extracting', message: 'Encoding PDF as base64...', step: 'step2' });

  let base64, sizeKb;
  try {
    const buffer = fs.readFileSync(filePath);
    base64 = buffer.toString('base64');
    sizeKb = (buffer.length / 1024).toFixed(1);
  } catch (err) {
    sendEvent(requestId, 'fail', { message: `Failed to read PDF for Step 2: ${err.message}`, step: 'step2' });
    return;
  }
  sendEvent(requestId, 'stage', { stage: 'extracted', message: `Encoded ${sizeKb} KB`, step: 'step2' });

  const step2Contents = [{
    role: 'user',
    parts: [
      { inlineData: { mimeType: 'application/pdf', data: base64 } },
      { text: 'Extract structured data from this filing.' },
    ],
  }];

  const step2Slug = STEP2_PROMPT_FILES[classification.smart_subcategory];
  const step2Default = loadPrompt(step2Slug);
  const userOverride = cfg.step2PromptOverrides?.[classification.smart_subcategory];
  if (!step2Default && !userOverride) {
    sendEvent(requestId, 'fail', { message: `Step 2 prompt for "${classification.smart_subcategory}" not found on server.`, step: 'step2' });
    return;
  }
  const step2Text = userOverride || step2Default;

  sendEvent(requestId, 'stage', { stage: 'calling_api', message: `Step 2: extracting ${classification.smart_subcategory}...`, step: 'step2' });
  const s2 = await callProvider(requestId, cfg, step2Contents, step2Text, {
    stepTag: 'step2',
    cacheTag: userOverride ? null : `step2_${step2Slug}`,
    emitDone: false,
  });
  if (!s2) return;

  // Apply server-side unit conversion based on the LLM's _unit_declaration block.
  // Only Financial Updates emits this block today; for other categories applyUnit... is a no-op.
  let unitDetection = null;
  if (s2.parsed?.smart_subcategory_specific && classification.smart_subcategory === 'Financial Updates') {
    unitDetection = applyUnitDeclarationConversion(s2.parsed.smart_subcategory_specific);
  }

  const merged = {
    smart_subcategory: classification.smart_subcategory,
    _classifier_confidence: classification.confidence,
    _classifier_rationale: classification.rationale,
    _secondary_events: classification.secondary_events || [],
    _pipeline: 'simplified',
    _step1_pages_used: pagesUsed,
    _step1_total_pages: totalPages,
    _unit_detection: unitDetection,
    ...s2.parsed,
  };

  setJobMemory(requestId, { contents: step2Contents, cfg });
  sendEvent(requestId, 'done', { result: merged });
}

// ── /final pipeline — enriched Step 1 for all 24, Step 2 only for Financial Updates + Order Win ──
async function runMode_final(filePath, filename, requestId, cfg) {
  // ── Step 1: enriched classifier on first 5 pages of text ──
  sendEvent(requestId, 'step', { step: 'step1', label: 'Classifying + summarising (first 5 pages, text)' });
  sendEvent(requestId, 'stage', { stage: 'extracting', message: 'Extracting first 5 pages as text...', step: 'step1' });

  let firstPagesText, totalPages, pagesUsed;
  try {
    const r = await extractFirstNPagesOfPDF(filePath, 5);
    firstPagesText = r.text; totalPages = r.totalPages; pagesUsed = r.pagesUsed;
  } catch (err) {
    sendEvent(requestId, 'fail', { message: `Step 1 text extraction failed: ${err.message}`, step: 'step1' });
    return;
  }
  if (!firstPagesText || firstPagesText.trim().length < 200) {
    sendEvent(requestId, 'fail', {
      message: `Step 1 found only ${firstPagesText?.trim().length || 0} chars in the first ${pagesUsed} pages — likely a scanned/image PDF.`,
      step: 'step1',
    });
    return;
  }
  sendEvent(requestId, 'stage', {
    stage: 'extracted',
    message: `Pulled ${firstPagesText.length.toLocaleString()} chars from ${pagesUsed} of ${totalPages} pages`,
    step: 'step1',
  });
  sendEvent(requestId, 'extracted_text', { text: firstPagesText, mode: 'text', step: 'step1' });

  const step1Contents = [{ role: 'user', parts: [{ text: `filing_text:\n${firstPagesText}` }] }];

  const step1Text = loadPromptFinal('step1_classifier_enriched');
  if (!step1Text) {
    sendEvent(requestId, 'fail', { message: 'Step 1 enriched prompt not found in system_prompts_final/.' });
    return;
  }

  sendEvent(requestId, 'stage', { stage: 'calling_api', message: 'Step 1: classify + headline + summary + key_facts...', step: 'step1' });
  const s1 = await callProvider(requestId, cfg, step1Contents, step1Text, {
    stepTag: 'step1',
    cacheTag: 'final_step1',
    emitDone: false,
  });
  if (!s1) return;
  const classification = s1.parsed;
  sendEvent(requestId, 'classification', classification);

  // For 22 of 24 categories, Step 1 is the final output.
  const step2Slug = FINAL_STEP2_PROMPT_FILES[classification.smart_subcategory];
  if (!step2Slug) {
    // Step 1 output IS the final result.
    const merged = {
      smart_subcategory: classification.smart_subcategory,
      _classifier_confidence: classification.confidence,
      _classifier_rationale: classification.rationale,
      _secondary_events: classification.secondary_events || [],
      _pipeline: 'final',
      _step2_skipped: true,
      _step2_skipped_reason: `No Step 2 extractor for "${classification.smart_subcategory}" — Step 1 output is final.`,
      _step1_pages_used: pagesUsed,
      _step1_total_pages: totalPages,
      headline: classification.headline,
      summary: classification.summary,
      sentiment: classification.sentiment,
      key_facts: classification.key_facts || {},
    };
    sendEvent(requestId, 'done', { result: merged });
    return;
  }

  // ── Step 2: full PDF base64, only for Financial Updates / Order Win ──
  sendEvent(requestId, 'step', { step: 'step2', label: `Extracting ${classification.smart_subcategory} (base64, full PDF)` });
  sendEvent(requestId, 'stage', { stage: 'extracting', message: 'Encoding PDF as base64...', step: 'step2' });

  let base64, sizeKb;
  try {
    const buffer = fs.readFileSync(filePath);
    base64 = buffer.toString('base64');
    sizeKb = (buffer.length / 1024).toFixed(1);
  } catch (err) {
    sendEvent(requestId, 'fail', { message: `Failed to read PDF for Step 2: ${err.message}`, step: 'step2' });
    return;
  }
  sendEvent(requestId, 'stage', { stage: 'extracted', message: `Encoded ${sizeKb} KB`, step: 'step2' });

  const step2Contents = [{
    role: 'user',
    parts: [
      { inlineData: { mimeType: 'application/pdf', data: base64 } },
      { text: 'Extract structured data from this filing.' },
    ],
  }];

  const step2Text = loadPromptFinal(step2Slug);
  if (!step2Text) {
    sendEvent(requestId, 'fail', { message: `Step 2 prompt "${step2Slug}" not found in system_prompts_final/.`, step: 'step2' });
    return;
  }

  sendEvent(requestId, 'stage', { stage: 'calling_api', message: `Step 2: extracting ${classification.smart_subcategory}...`, step: 'step2' });
  const s2 = await callProvider(requestId, cfg, step2Contents, step2Text, {
    stepTag: 'step2',
    cacheTag: `final_step2_${step2Slug}`,
    emitDone: false,
  });
  if (!s2) return;

  // Server-side unit conversion (Financial Updates only — Order Win has its own simpler unit handling below).
  let unitDetection = null;
  if (s2.parsed?.smart_subcategory_specific) {
    if (classification.smart_subcategory === 'Financial Updates') {
      unitDetection = applyUnitDeclarationConversion(s2.parsed.smart_subcategory_specific);
    } else if (classification.smart_subcategory === 'Order Win') {
      unitDetection = applyOrderWinUnitConversion(s2.parsed.smart_subcategory_specific);
    }
  }

  const merged = {
    smart_subcategory: classification.smart_subcategory,
    _classifier_confidence: classification.confidence,
    _classifier_rationale: classification.rationale,
    _secondary_events: classification.secondary_events || [],
    _pipeline: 'final',
    _step2_skipped: false,
    _step1_pages_used: pagesUsed,
    _step1_total_pages: totalPages,
    _unit_detection: unitDetection,
    // Prefer Step 2's headline/summary/sentiment when present (they're sharper for #1 / #9).
    headline: s2.parsed?.headline || classification.headline,
    summary:  s2.parsed?.summary  || classification.summary,
    sentiment: s2.parsed?.sentiment || classification.sentiment,
    key_facts: classification.key_facts || {},
    ...s2.parsed,
  };

  setJobMemory(requestId, { contents: step2Contents, cfg });
  sendEvent(requestId, 'done', { result: merged });
}

// Order Win unit conversion — simpler than Financial Updates. Just one declared unit on the order_value field.
function applyOrderWinUnitConversion(spec) {
  if (!spec || typeof spec !== 'object') return { applied: false };
  const decl = spec._unit_declaration || {};
  const unit = (decl.order_value_unit || '').toLowerCase();
  const detection = { applied: true, declaration: { order_value: unit || null }, conversions: [] };

  // Currency-to-Cr is left for the LLM to handle (it has the FX context). Only scale magnitude units.
  const mult = UNIT_TO_CR[unit];
  if (mult == null) return detection;

  if (spec.order && typeof spec.order.order_value_cr === 'number') {
    spec.order.order_value_cr = Math.round(spec.order.order_value_cr * mult * 100) / 100;
    detection.conversions.push({ block: 'order', unit, mult, target: 'order.order_value_cr' });
  }
  if (Array.isArray(spec.context?.secondary_orders_in_filing)) {
    spec.context.secondary_orders_in_filing.forEach(o => {
      if (typeof o.value_cr === 'number') o.value_cr = Math.round(o.value_cr * mult * 100) / 100;
    });
  }
  return detection;
}

// ── POST /process-final — entry point for /final page ──
app.post('/process-final', upload.single('file'), async (req, res) => {
  const requestId = Date.now().toString() + Math.random().toString(36).slice(2);
  let cfg = {};
  try { cfg = JSON.parse(req.body.config || '{}'); } catch {}

  const provider = cfg.provider === 'openai' ? 'openai' : 'gemini';
  cfg.provider = provider;

  if (provider === 'gemini') {
    if (!cfg.apiKey) cfg.apiKey = process.env.GEMINI_API_KEY;
    if (!cfg.apiKey) return res.status(400).json({ error: 'No Gemini API key provided.' });
  } else {
    if (!cfg.openaiApiKey) cfg.openaiApiKey = process.env.OPENAI_API_KEY;
    if (!cfg.openaiApiKey) return res.status(400).json({ error: 'No OpenAI API key provided.' });
  }

  let filePath = req.file?.path;
  const filename = req.file?.originalname || 'document.pdf';
  const url = req.body.url;
  if (!filePath && !url) return res.status(400).json({ error: 'No file or URL provided.' });

  clients.set(requestId, { res: null, buffer: [] });
  res.json({ requestId });

  (async () => {
    if (url) {
      sendEvent(requestId, 'stage', { stage: 'downloading', message: 'Downloading PDF from URL...' });
      filePath = path.join(__dirname, 'uploads', `${requestId}.pdf`);
      try {
        await downloadFile(url, filePath);
        sendEvent(requestId, 'stage', { stage: 'downloading', message: 'Download complete' });
      } catch (err) {
        sendEvent(requestId, 'fail', { message: `Download failed: ${err.message}` });
        return;
      }
    }
    await runMode_final(filePath, filename, requestId, cfg);
    fs.unlink(filePath, () => {});
  })();
});

// ── POST /process-simplified ─ /new page entry point ─
// Step 1 = text + first 5 pages, Step 2 = base64 + full PDF. Provider is gemini or openai (user pick).
app.post('/process-simplified', upload.single('file'), async (req, res) => {
  const requestId = Date.now().toString() + Math.random().toString(36).slice(2);
  let cfg = {};
  try { cfg = JSON.parse(req.body.config || '{}'); } catch {}

  const provider = cfg.provider === 'openai' ? 'openai' : 'gemini';
  cfg.provider = provider;

  if (provider === 'gemini') {
    if (!cfg.apiKey) cfg.apiKey = process.env.GEMINI_API_KEY;
    if (!cfg.apiKey) return res.status(400).json({ error: 'No Gemini API key provided.' });
  } else {
    if (!cfg.openaiApiKey) cfg.openaiApiKey = process.env.OPENAI_API_KEY;
    if (!cfg.openaiApiKey) return res.status(400).json({ error: 'No OpenAI API key provided.' });
  }

  let filePath = req.file?.path;
  const filename = req.file?.originalname || 'document.pdf';
  const url = req.body.url;
  if (!filePath && !url) return res.status(400).json({ error: 'No file or URL provided.' });

  clients.set(requestId, { res: null, buffer: [] });
  res.json({ requestId });

  (async () => {
    if (url) {
      sendEvent(requestId, 'stage', { stage: 'downloading', message: 'Downloading PDF from URL...' });
      filePath = path.join(__dirname, 'uploads', `${requestId}.pdf`);
      try {
        await downloadFile(url, filePath);
        sendEvent(requestId, 'stage', { stage: 'downloading', message: 'Download complete' });
      } catch (err) {
        sendEvent(requestId, 'fail', { message: `Download failed: ${err.message}` });
        return;
      }
    }
    await runMode_simplified(filePath, filename, requestId, cfg);
    fs.unlink(filePath, () => {});
  })();
});

// ── POST /retry ─ Targeted re-fetch of a specific missing block ──
// Body: { requestId, target: 'balance_sheet' | 'cash_flow', scope: 'standalone' | 'consolidated', periodLabel? }
// Response: { ok: true, target, scope, data: {...} } or { ok: false, error }
app.post('/retry', async (req, res) => {
  const { requestId, target, scope, periodLabel } = req.body || {};
  const mem = jobMemory.get(requestId);
  if (!mem) return res.status(404).json({ ok: false, error: 'Job expired or not found. Re-run the file.' });
  if (!['balance_sheet','cash_flow'].includes(target)) return res.status(400).json({ ok: false, error: 'target must be balance_sheet or cash_flow' });
  if (!['standalone','consolidated'].includes(scope))  return res.status(400).json({ ok: false, error: 'scope must be standalone or consolidated' });

  const { contents, cfg } = mem;
  const retryId = `${requestId}-retry-${Date.now()}`;

  const blockName = target === 'balance_sheet' ? 'Balance Sheet' : 'Cash Flow Statement';
  const labelHint = periodLabel ? `The target period is "${periodLabel}".` : '';

  const balanceSheetSchema = `{
  "${target}": {
    "period_label": "<FY label>",
    "as_of_date": "<YYYY-MM-DD>",
    "scope": "${scope}",
    "equity_share_capital": <₹ Cr>,
    "reserves_and_surplus": <₹ Cr>,
    "total_borrowings": <₹ Cr>,
    "other_liabilities": <₹ Cr>,
    "total_liabilities": <₹ Cr>,
    "borrowings_breakdown": {
      "long_term_borrowings": <₹ Cr | null>,
      "short_term_borrowings": <₹ Cr | null>,
      "lease_liabilities": <₹ Cr | null>,
      "other_borrowings": <₹ Cr | null>
    },
    "other_liabilities_breakdown": {
      "trade_payables": <₹ Cr | null>,
      "provisions": <₹ Cr | null>,
      "deferred_tax_liability": <₹ Cr | null>,
      "other_current_liabilities": <₹ Cr | null>,
      "other_non_current_liabilities": <₹ Cr | null>
    },
    "fixed_assets_net": <₹ Cr>,
    "capital_work_in_progress": <₹ Cr>,
    "investments": <₹ Cr>,
    "other_assets": <₹ Cr>,
    "total_assets": <₹ Cr>,
    "fixed_assets_breakdown": {
      "land": <₹ Cr | null>,
      "buildings": <₹ Cr | null>,
      "plant_and_machinery": <₹ Cr | null>,
      "equipment": <₹ Cr | null>,
      "computers": <₹ Cr | null>,
      "furniture_and_fittings": <₹ Cr | null>,
      "vehicles": <₹ Cr | null>,
      "intangible_assets": <₹ Cr | null>,
      "other_fixed_assets": <₹ Cr | null>
    },
    "other_assets_breakdown": {
      "inventories": <₹ Cr | null>,
      "trade_receivables": <₹ Cr | null>,
      "cash_and_equivalents": <₹ Cr | null>,
      "loans_and_advances": <₹ Cr | null>,
      "other_current_assets": <₹ Cr | null>,
      "deferred_tax_asset": <₹ Cr | null>,
      "goodwill": <₹ Cr | null>
    },
    "book_value_per_share": <₹ | null>,
    "net_debt": <₹ Cr | null>,
    "debt_to_equity": <ratio | null>
  }
}`;

  const cashFlowSchema = `{
  "${target}": {
    "period_label": "<FY label>",
    "scope": "${scope}",
    "cash_from_operating": <₹ Cr>,
    "cash_from_investing": <₹ Cr>,
    "cash_from_financing": <₹ Cr>,
    "net_cash_flow": <₹ Cr>,
    "opening_cash_balance": <₹ Cr>,
    "closing_cash_balance": <₹ Cr>,
    "operating_breakdown": {
      "profit_from_operations": <₹ Cr | null>,
      "change_in_receivables": <₹ Cr | null>,
      "change_in_inventory": <₹ Cr | null>,
      "change_in_payables": <₹ Cr | null>,
      "operating_deposits_change": <₹ Cr | null>,
      "other_working_capital_items": <₹ Cr | null>,
      "total_working_capital_changes": <₹ Cr | null>,
      "direct_taxes_paid": <₹ Cr | null>,
      "interest_paid_in_operating": <₹ Cr | null>
    },
    "investing_breakdown": {
      "fixed_assets_purchased": <₹ Cr | null>,
      "fixed_assets_sold": <₹ Cr | null>,
      "capital_work_in_progress_addition": <₹ Cr | null>,
      "investments_purchased": <₹ Cr | null>,
      "investments_sold": <₹ Cr | null>,
      "interest_received": <₹ Cr | null>,
      "dividend_received": <₹ Cr | null>,
      "acquisitions": <₹ Cr | null>,
      "redemption_or_cancellation_of_shares": <₹ Cr | null>,
      "other_investing_items": <₹ Cr | null>
    },
    "financing_breakdown": {
      "proceeds_from_share_issue": <₹ Cr | null>,
      "proceeds_from_borrowings": <₹ Cr | null>,
      "repayment_of_borrowings": <₹ Cr | null>,
      "interest_paid_in_financing": <₹ Cr | null>,
      "dividend_paid": <₹ Cr | null>,
      "change_in_financial_liabilities": <₹ Cr | null>,
      "lease_payments": <₹ Cr | null>,
      "other_financing_items": <₹ Cr | null>
    },
    "free_cash_flow": <₹ Cr | null>
  }
}`;

  const schema = target === 'balance_sheet' ? balanceSheetSchema : cashFlowSchema;

  const retryPrompt = `You previously processed this Indian stock exchange filing but MISSED the ${scope.toUpperCase()} ${blockName}. It IS in this filing — SEBI LODR Reg 33(3) mandates it for Q2/Q4/H1/FY filings, and Indian filings pair standalone + consolidated statements on adjacent pages.

${labelHint}

Find the ${scope.toUpperCase()} ${blockName} and emit EXACTLY this JSON object, nothing else. No markdown, no code fences, no prose:

${schema}

Rules:
- scope MUST be "${scope}".
- All monetary values in ₹ Cr. If the filing uses Lakhs, divide by 100. If Millions, multiply by 0.1.
- For balance_sheet: total_assets MUST equal total_liabilities (within ₹1 Cr).
- If the ${scope} ${blockName} genuinely is not in this filing (very rare), emit {"${target}": null} and nothing else.`;

  try {
    const result = await callProvider(retryId, cfg, contents, retryPrompt, {
      stepTag: null,
      cacheTag: null,
      emitDone: false,
    });
    if (!result?.parsed) return res.status(500).json({ ok: false, error: 'Retry returned no parseable result.' });
    const data = result.parsed[target];
    return res.json({ ok: true, target, scope, data });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /process ─────────────────────────────────────────────────
app.post('/process', upload.single('file'), async (req, res) => {
  const requestId = Date.now().toString() + Math.random().toString(36).slice(2);
  let cfg = {};
  try { cfg = JSON.parse(req.body.config || '{}'); } catch {}
  if (!cfg.apiKey)       cfg.apiKey       = process.env.GEMINI_API_KEY;
  if (!cfg.groqApiKey)   cfg.groqApiKey   = process.env.GROQ_API_KEY;
  if (!cfg.openaiApiKey) cfg.openaiApiKey = process.env.OPENAI_API_KEY;
  if (!cfg.openaiOrg)    cfg.openaiOrg    = process.env.OPENAI_ORG_ID || '';
  if (!cfg.openaiProject) cfg.openaiProject = process.env.OPENAI_PROJECT || '';

  const provider = cfg.provider || 'gemini';
  if (provider === 'groq' && !cfg.groqApiKey)     return res.status(400).json({ error: 'No Groq API key provided.' });
  if (provider === 'openai' && !cfg.openaiApiKey) return res.status(400).json({ error: 'No OpenAI API key provided.' });
  if (provider === 'gemini' && !cfg.apiKey)       return res.status(400).json({ error: 'No Gemini API key provided.' });

  let filePath = req.file?.path;
  const filename = req.file?.originalname || 'document.pdf';
  const url = req.body.url;

  if (!filePath && !url) return res.status(400).json({ error: 'No file or URL provided.' });

  clients.set(requestId, { res: null, buffer: [] });
  res.json({ requestId });

  (async () => {
    if (url) {
      sendEvent(requestId, 'stage', { stage: 'downloading', message: 'Downloading PDF from URL...' });
      filePath = path.join(__dirname, 'uploads', `${requestId}.pdf`);
      try {
        await downloadFile(url, filePath);
        sendEvent(requestId, 'stage', { stage: 'downloading', message: 'Download complete' });
      } catch (err) {
        sendEvent(requestId, 'fail', { message: `Download failed: ${err.message}` });
        return;
      }
    }

    const pipeline   = cfg.pipeline || 'single';
    const uploadMode = cfg.mode     || 'text';

    if (pipeline === 'double') {
      await runMode_double(filePath, filename, uploadMode, requestId, cfg);
    } else {
      await runMode_single(filePath, filename, uploadMode, requestId, cfg);
    }

    fs.unlink(filePath, () => {});
  })();
});

fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });
fs.mkdirSync(path.join(__dirname, 'public'), { recursive: true });

function getDefaultCfg() {
  return {
    apiKey:          process.env.GEMINI_API_KEY || '',
    model:           process.env.GEMINI_MODEL   || 'gemini-3.1-flash-lite-preview',
    maxTokens:       parseInt(process.env.GEMINI_MAX_TOKENS, 10) || 32768,
    thinkingEnabled: process.env.GEMINI_THINKING !== 'false',
  };
}

startPoller(app, getDefaultCfg);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
