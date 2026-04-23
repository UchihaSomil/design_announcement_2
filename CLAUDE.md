# BSE Filing Extractor — Project Notes

Extracts structured data from BSE/NSE corporate-announcement PDFs using Gemini. Three PDF-upload modes (text / base64 / files-API) × two pipelines (single / double).

## Architecture

### Single pipeline (default, untouched legacy path)
One API call. Uses `system_prompt.txt` (~7,872 tokens) — the original monolithic extractor prompt for all 24 smart_subcategories in one shot.

### Double pipeline (built, Financial Updates only so far)
Two API calls:
1. **Step 1 — Classifier** (`system_prompts/step1_classifier.md`). Picks ONE of 24 smart_subcategories. Emits `{smart_subcategory, confidence, rationale, secondary_events}` only. No extraction.
2. **Step 2 — Category extractor** (`system_prompts/step2_financial_updates.md` is the only one written). Full structured extraction specific to that category.

Server merges Step 1 + Step 2 into a single result shape:
```
{ smart_subcategory, _classifier_confidence, _classifier_rationale, _secondary_events,
  headline, summary, sentiment, key_entities, filing_meta, smart_subcategory_specific }
```

**Auto-classify vs pre-chosen:** The UI dropdown lets the user pick a subcategory directly (skips Step 1). If classifier returns — or user picks — anything other than "Financial Updates", the job fails with *"Not a financial result — Step 2 not built yet for X"* and no Step 2 call is made.

**STEP2_PROMPT_FILES map in server.js** — only entry is `"Financial Updates" → "step2_financial_updates"`. Add new entries as new Step 2 prompts are written.

## File layout

```
server.js                        Express + SSE + retry + context caching + pipeline dispatch
system_prompt.txt                Legacy single-mode prompt — DO NOT touch without Somil's OK
system_prompts/
  step1_classifier.md            Step 1 prompt
  step2_financial_updates.md     Step 2 for Financial Updates (the only Step 2 built)
public/index.html                Whole UI — pipeline tabs, config sidebar, prompt modal, job cards, financial tables
```

## Step 2 Financial Updates — how it handles the 24-page messy results PDF

Schema blocks (one entry per period × scope):
- `pnl_by_period` — P&L. Atomic fields: sales, total_expenses, other_income, interest, depreciation, PBT, tax, PAT, EPS, face value + `expense_breakdown` (material, purchases, Δinv, employee, manufacturing, power & fuel, other, finance_costs, depreciation_amortisation, `additional_line_items` for unnamed buckets).
- `balance_sheet_by_period` — nested under Total Liabilities and Total Assets in the UI.
- `cash_flow_by_period` — three sections each collapsible.
- `ratios_by_period` — **LLM's values ignored**; browser computes them from atomic P&L + BS numbers. See `ratiosRows()` in `public/index.html`.
- `revenue_mix_by_period` — domestic/exports, product-wise, geography-wise, channel-wise, customer-concentration.
- `banking_nbfc_specific` — banks/NBFCs use this instead of standard P&L (they have no OPM / material_cost).
- `segment_results`, `shareholding_pattern`, `dividend_embedded`, `auditor`, `other_insights`, `data_integrity_flags`.

### Key design decision: LLM extracts, browser computes

Any field that's a formula over other fields is **recomputed in the browser** because Gemini's arithmetic is unreliable. Don't trust LLM-derived fields. Derived in `pnlRows()`:
```
operating_expenses = total_expenses − interest − depreciation
operating_profit   = sales − operating_expenses
opm_percent        = operating_profit / sales × 100
tax_percent        = tax_amount / PBT × 100
```
Derived in `ratiosRows()`:
```
EBIT = PBT + interest
Equity = equity_share_capital + reserves_and_surplus
Capital Employed = Equity + total_borrowings

Debtor days  = trade_receivables / sales × 365
Inventory days = inventories / material_cost × 365
Payable days = trade_payables / material_cost × 365
CCC = Debtor + Inventory − Payable
ROCE % = EBIT / Capital Employed × 100
ROE % = PAT / Equity × 100
ROA % = PAT / total_assets × 100
Asset turnover = sales / total_assets
Interest coverage = EBIT / interest   (null when interest < 0.5 Cr)
```
Ratios fall back to the LLM's `ratios_by_period` only when an atomic input is missing.

### Schedule III expense convention

Total Expenses = all buckets **including finance_costs and depreciation** (per Ind AS Schedule III, this is what the PDF shows). The prompt makes the LLM return `interest` and `depreciation` both as top-level fields AND inside `expense_breakdown` — same values, mirrored. Operating expenses is then derived as total_expenses − interest − depreciation. Children of the "Operating expenses" parent in the UI always sum to the parent because they exclude interest & depreciation.

### Finance costs vs interest

Same thing. The prompt's `interest` field maps to the PDF's "Finance costs" row. Finance costs is technically broader (includes lease interest, bank charges, forex on borrowings), but interest-on-borrowings dominates.

## Gotchas and root-cause history

### "Only standalone detected" on consolidated filings
Two causes seen:
1. **Text mode on image-PDFs:** pdf2json returns 0 chars for pages 8+ on some filings (e.g. `Havells.pdf`). Text mode silently extracts only the cover letter. Fix: use Base64 or Files API mode.
2. **LLM under-extraction even in Base64 mode:** model emits one entry per array instead of `periods × scopes`. The Step 2 prompt now has a PRE-OUTPUT CHECKLIST section spelling out the 5 ways this goes wrong. If it still under-extracts, bump Max tokens higher or switch to Gemini 2.5 Pro / 3.1 Pro.

### Ratios showing absurd values
Unit mismatch between P&L and balance sheet (Lakhs vs ₹ Cr). Look for ROCE like 0.88% or 8820% — that's always a unit mix-up at the extraction stage, not the formula.

### Default Max tokens
32,768 (bumped from 8,192). Havells-class filings with 5 periods × 2 scopes × full breakdowns need the headroom; 8K truncates silently.

### Prompt modal semantics
User sees the `.md` file verbatim, read-only. Clicking "Create override" copies the default into an editable textarea — this is Option B: sticky localStorage edits per job, `.md` on disk never touched. Reset wipes the override.

## Context caching

`CACHEABLE_MODELS` whitelist (flash-lite-preview, 2.5-flash, 3-flash-preview, 2.5-pro, 3.1-pro-preview). TTL 23h, refresh-before-expiry 30m. Each cache is keyed by `apiKey::modelId::cacheTag` so Step 1 and Step 2 prompts each get their own cache. User prompt overrides skip caching for that call (`cacheTag: null`).

## UI anatomy

- **Topbar**: Pipeline tabs (Single / Double). Double mode toggles sidebar system-prompt section.
- **Sidebar**: API key, model, thinking level, MIME, temperature, max tokens, concurrency. Single mode has a system-prompt prefix-override textarea. Double mode has a "View / Edit System Prompts" button opening a two-tab modal.
- **Mode section**: 3 upload mode cards (text/base64/files-API) + subcategory dropdown (double mode only; only "Financial Updates" is enabled, rest are disabled with "Not yet built" label).
- **Job card**: stages pipeline → token bar (per-step in Double) → classification chip + confidence + rationale tooltip → headline/summary/sentiment tags → Scope toggle (standalone/consolidated) → 7 financial tables (Quarterly, P&L, Balance sheet, Cash flow, Ratios, Shareholding, Revenue mix) → insights cards (dividend, auditor, order book, capacity, guidance, quotes) → data integrity flags (amber box) → raw JSON expander.

Tables support arbitrary-depth collapsible rows via `children` arrays (see `buildTable()`, `flattenRowTree()`). P&L groups expenses under "Operating expenses"; Balance Sheet nests everything under Total Liabilities and Total Assets; Cash Flow collapses Operating/Investing/Financing sections.

## Pending — Step 2 prompts not yet written (23 of 24)

Concall/Presentation, Dividend, Buyback, Bonus/Stock Split, Acquisition, Merger/Demerger, JV/Strategic Partnership, Order Win, Capacity Expansion/Capex, Product Launch, Fund Raising, Stake Sale/Disinvestment, Credit Rating Change, Regulatory Action/Penalty, Fraud/Default, Insolvency/CIRP, Open Offer/Takeover, Promoter Buy/Sell, Change in Key Management, Operational Disruption, Others, Routine/Administrative, Regulatory Approval/Licensing.

When writing each: follow the Step 2 Financial Updates structure as the template (wrapper fields `headline / summary / sentiment / key_entities / filing_meta` are identical across all 24 categories; only `smart_subcategory_specific` changes shape).

Once a new prompt is written: add to `STEP2_PROMPT_FILES` map in `server.js` and enable the dropdown option in `public/index.html`.
