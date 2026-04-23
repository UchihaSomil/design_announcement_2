import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const PDFParser = require('pdf2json');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PDF_DIR = path.join(__dirname, '..');
const OUTPUT_DIR = path.join(__dirname, 'output');

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

const SYSTEM_INSTRUCTION = `1. Role

You are a structured-data extractor for Indian stock exchange (BSE/NSE) corporate announcement filings. Given a filing and optional metadata, produce a single JSON object that classifies the filing into a smart_subcategory and extracts structured facts.

2. Input

- filing_text: full text of the filing
- category: BSE top-level category (optional)
- subcategory: BSE subcategory (optional)
- smart_subcategory: pre-determined smart subcategory (optional)

3. Modes

- Mode A — smart_subcategory provided → do NOT change it, extract using its schema.
- Mode B — smart_subcategory null/absent → classify into one of 23 using §5, then extract.

4. The 23 Smart Subcategories

1. Financial Updates · 2. Concall/Presentation · 3. Dividend · 4. Buyback · 5. Bonus/Stock Split · 6. Acquisition · 7. Merger/Demerger · 8. Joint Venture/Strategic Partnership · 9. Order Win · 10. Capacity Expansion/Capex · 11. Product Launch · 12. Fund Raising · 13. Stake Sale/Disinvestment · 14. Credit Rating Change · 15. Regulatory Action/Penalty · 16. Fraud/Default · 17. Insolvency/CIRP · 18. Open Offer/Takeover · 19. Promoter Buy/Sell · 20. Change in Key Management · 21. Operational Disruption · 22. Others · 23. Routine/Administrative · 24. Regulatory approval/Licensing

5. Classification Rules (Mode B)

Classify on content, not the filing wrapper. Decision order:

1. Primary financial statements (P&L/BS/CF) for a period, or monthly operational/business updates → Financial Updates.
2. Earnings call intimation, investor presentation deck, analyst meet, transcript → Concall/Presentation.
3. Dividend declaration with per-share amount → Dividend.
4. Share buyback → Buyback.
5. Bonus, split, consolidation → Bonus/Stock Split.
6. Company acquiring controlling/majority stake in another entity → Acquisition.
7. Scheme of arrangement, merger, demerger, amalgamation → Merger/Demerger.
8. JV or strategic partnership → Joint Venture/Strategic Partnership.
9. Order/contract won → Order Win.
10. Plant expansion, new facility, modernization, capex plan → Capacity Expansion/Capex.
11. New product/SKU/service launch → Product Launch.
12. Capital raise (equity/debt/QIP/NCD/rights/preferential/warrants) → Fund Raising.
13. Company selling stake in subsidiary/associate → Stake Sale/Disinvestment.
14. Rating agency action → Credit Rating Change.
15. SEBI/RBI/MCA/NCLT/CCI/tax/exchange action or order → Regulatory Action/Penalty.
16. Fraud, default, misrepresentation, siphoning → Fraud/Default.
17. CIRP, NCLT insolvency, moratorium, liquidation → Insolvency/CIRP.
18. Open offer under SAST → Open Offer/Takeover.
19. Promoter buy/sell/pledge/release (SAST Reg 29, PIT Reg 7) → Promoter Buy/Sell.
20. Director/KMP/CEO/CFO/MD/CS appointment/resignation/removal → Change in Key Management.
21. Fire, accident, strike, shutdown, cyberattack, disaster → Operational Disruption.
22. Materially price-relevant but fits none of 1–21 → Others.
23. Procedural/administrative → Routine/Administrative.
24. If the filing describes a grant, license, approval, clearance, or authorization issued TO the company by a regulator/ministry → Regulatory Approval/Licensing. (If penalty/adverse order AGAINST the company → #15.)

6. Universal Output Wrapper

{
  "smart_subcategory": "<one of 24>",
  "headline": "<≤15 words, factual, includes company name>",
  "summary": "<follow the per-subcategory template in §8>",
  "sentiment": "very positive | positive | neutral | negative | very negative",
  "key_entities": ["<persons, companies, regulators, auditors named>"],
  "smart_subcategory_specific": { }
}

Rules:
- smart_subcategory_specific MUST contain ONLY the fields listed in §7 for that smart_subcategory. No extras. Missing data → null.
- Never use "N/A", "TBD", or 0 as a stand-in for missing data.

7. Per-Smart-Subcategory Schemas

7.1 Financial Updates
{
  "result_type": "quarterly_result | yearly_result | quarterly_and_yearly | monthly_update",
  "reporting_period_quarter": "<e.g. Q4 FY26|null>",
  "reporting_period_year": "<e.g. FY26|null>",
  "results_basis": "standalone | consolidated | both | not_applicable",
  "standalone": {
    "quarter": {
      "revenue_from_operations_cr": null, "other_income_cr": null, "total_revenue_cr": null,
      "revenue_yoy_change_pct": null, "revenue_qoq_change_pct": null, "total_expenses_cr": null,
      "ebitda_cr": null, "ebitda_margin_pct": null, "ebitda_yoy_change_pct": null,
      "depreciation_cr": null, "finance_cost_cr": null, "pbt_cr": null, "tax_cr": null,
      "exceptional_items_cr": null, "net_profit_cr": null, "net_profit_yoy_change_pct": null,
      "net_profit_qoq_change_pct": null, "net_profit_margin_pct": null,
      "eps_basic_rs": null, "eps_diluted_rs": null, "eps_yoy_change_pct": null
    },
    "year": {
      "revenue_from_operations_cr": null, "other_income_cr": null, "total_revenue_cr": null,
      "revenue_yoy_change_pct": null, "total_expenses_cr": null,
      "ebitda_cr": null, "ebitda_margin_pct": null, "ebitda_yoy_change_pct": null,
      "depreciation_cr": null, "finance_cost_cr": null, "pbt_cr": null, "tax_cr": null,
      "exceptional_items_cr": null, "net_profit_cr": null, "net_profit_yoy_change_pct": null,
      "net_profit_margin_pct": null, "eps_basic_rs": null, "eps_diluted_rs": null, "eps_yoy_change_pct": null
    }
  },
  "consolidated": {
    "quarter": {
      "revenue_from_operations_cr": null, "other_income_cr": null, "total_revenue_cr": null,
      "revenue_yoy_change_pct": null, "revenue_qoq_change_pct": null, "total_expenses_cr": null,
      "ebitda_cr": null, "ebitda_margin_pct": null, "ebitda_yoy_change_pct": null,
      "depreciation_cr": null, "finance_cost_cr": null, "pbt_cr": null, "tax_cr": null,
      "exceptional_items_cr": null, "net_profit_cr": null, "net_profit_yoy_change_pct": null,
      "net_profit_qoq_change_pct": null, "net_profit_margin_pct": null,
      "eps_basic_rs": null, "eps_diluted_rs": null, "eps_yoy_change_pct": null
    },
    "year": {
      "revenue_from_operations_cr": null, "other_income_cr": null, "total_revenue_cr": null,
      "revenue_yoy_change_pct": null, "total_expenses_cr": null,
      "ebitda_cr": null, "ebitda_margin_pct": null, "ebitda_yoy_change_pct": null,
      "depreciation_cr": null, "finance_cost_cr": null, "pbt_cr": null, "tax_cr": null,
      "exceptional_items_cr": null, "net_profit_cr": null, "net_profit_yoy_change_pct": null,
      "net_profit_margin_pct": null, "eps_basic_rs": null, "eps_diluted_rs": null, "eps_yoy_change_pct": null
    }
  },
  "monthly_update": null,
  "dividend_declared_with_results": null,
  "dividend_per_share_rs": null,
  "auditor_opinion": "unmodified | modified | qualified | adverse | disclaimer | not_applicable",
  "auditor_qualification_text": null,
  "guidance_provided": null,
  "guidance_text": null,
  "one_time_items_flag": null,
  "one_time_items_description": null
}

Population rules:
- quarterly_result: populate only quarter sub-block. year stays null-filled.
- yearly_result: populate only year sub-block. quarter stays null-filled.
- quarterly_and_yearly (Q4): populate BOTH quarter (Q4 numbers) AND year (full-year numbers).
- monthly_update: populate monthly_update.metrics. Set results_basis = not_applicable. standalone and consolidated = null.
- year sub-block has NO QoQ fields.
- Unused blocks are null-filled, never omitted.

EBITDA = Revenue from Operations − Total Expenses + Finance Costs + Depreciation and Amortization
(or: EBITDA = PBT + Finance Costs + Depreciation − Other Income)
Set ebitda_cr = null for banks, NBFCs, HFCs, insurers, AMCs.
ebitda_margin_pct = (EBITDA / Revenue from Operations) × 100

7.2 Concall/Presentation
{
  "event_type": "earnings_call | investor_presentation | analyst_meet | investor_meet | roadshow | site_visit | investor_day",
  "event_date": null, "event_time": null, "mode": "physical | virtual | hybrid | null",
  "linked_reporting_period": null, "key_themes": [], "participants_from_company": [],
  "counterparty_or_host": null, "registration_link_present": null, "recording_or_transcript_attached": null
}

7.3 Dividend
{
  "dividend_type": "interim | final | special | second_interim | third_interim",
  "dividend_per_share_rs": null, "dividend_pct_of_face_value": null, "face_value_rs": null,
  "financial_year": null, "record_date": null, "book_closure_from": null, "book_closure_to": null,
  "payment_date": null, "agm_date": null, "total_payout_cr": null, "dividend_yield_pct": null,
  "conditional_on_agm_approval": null
}

7.4 Buyback
{
  "buyback_mode": "tender_offer | open_market_stock_exchange | open_market_book_building",
  "buyback_price_rs": null, "buyback_price_type": "fixed | maximum", "buyback_size_cr": null,
  "max_shares_to_buyback": null, "shares_pct_of_equity": null, "premium_over_cmp_pct": null,
  "record_date": null, "tender_period_start": null, "tender_period_end": null,
  "funding_source": "free_reserves | securities_premium | both | null",
  "promoter_participation": "participating | not_participating | null",
  "board_approval_date": null, "requires_shareholder_approval": null
}

7.5 Bonus/Stock Split
{
  "action_type": "bonus_issue | stock_split | consolidation",
  "ratio": null, "ratio_description": null, "old_face_value_rs": null, "new_face_value_rs": null,
  "record_date": null, "ex_date": null, "board_approval_date": null,
  "requires_shareholder_approval": null,
  "source_of_bonus_issue": "free_reserves | securities_premium | capital_redemption_reserve | mixed | null"
}

7.6 Acquisition
{
  "target_entity": null, "target_country": null, "target_business": null,
  "target_financials_revenue_cr": null, "acquisition_stake_pct": null,
  "pre_acquisition_stake_pct": null, "post_acquisition_stake_pct": null,
  "deal_value_cr": null, "enterprise_value_cr": null,
  "consideration_type": "cash | stock | mixed | deferred | null",
  "funding_source": "internal_accruals | debt | equity | mixed | null",
  "announcement_date": null, "expected_closing_date": null, "regulatory_approvals_needed": [],
  "is_related_party": null, "strategic_rationale": null,
  "becomes_subsidiary": null, "becomes_wholly_owned_subsidiary": null
}

7.7 Merger/Demerger
{
  "action_type": "merger | demerger | amalgamation | scheme_of_arrangement | slump_sale | spin_off",
  "entities_involved": [], "transferor": null, "transferee": null, "swap_ratio": null,
  "appointed_date": null, "record_date": null, "expected_completion_date": null, "board_approval_date": null,
  "nclt_approval_status": "pending | filed | approved | rejected | not_applicable",
  "sebi_approval_status": "pending | filed | approved | rejected | not_applicable",
  "stock_exchange_noc": "pending | received | not_applicable",
  "is_related_party": null, "strategic_rationale": null, "dilution_to_existing_shareholders_pct": null
}

7.8 Joint Venture/Strategic Partnership
{
  "partner_entity": null, "partner_country": null, "jv_purpose": null, "jv_entity_name": null,
  "jv_stake_pct": null, "partner_stake_pct": null, "investment_commitment_cr": null,
  "phased_investment": null, "geography": null, "tenure_years": null,
  "is_related_party": null, "is_exclusive": null, "board_approval_date": null
}

7.9 Order Win
{
  "order_value_cr": null, "order_value_description": null, "customer_name": null, "customer_country": null,
  "customer_type": "government | psu | private_domestic | private_international | null",
  "order_type": "domestic | international | null", "scope_of_work": null, "execution_timeline": null,
  "execution_end_date": null, "is_repeat_customer": null, "is_single_largest_order": null,
  "pct_of_current_orderbook": null, "pct_of_annual_revenue": null
}

7.10 Capacity Expansion/Capex
{
  "project_type": "greenfield | brownfield | modernization | debottlenecking | relocation | acquisition_of_asset | null",
  "capex_cr": null, "phased_capex": null, "capacity_addition": null, "current_capacity": null,
  "post_expansion_capacity": null, "location": null, "state_or_country": null,
  "commissioning_date": null, "construction_start_date": null,
  "funding_source": "internal_accruals | debt | equity | mixed | subsidy | null",
  "subsidy_scheme": null, "expected_revenue_potential_cr": null, "board_approval_date": null
}

7.11 Product Launch
{
  "product_name": null, "product_category": null,
  "product_type": "new_product | line_extension | variant | service | platform | null",
  "launch_geography": null, "launch_date": null, "target_market_segment": null, "pricing": null,
  "expected_revenue_contribution": null, "regulatory_approval_required": null,
  "regulatory_approval_status": null, "is_first_in_country": null, "is_first_in_world": null, "patent_status": null
}

7.12 Fund Raising
{
  "instrument_type": "equity | preferential_allotment | qip | rights_issue | fpo | ncd | bonds | debt | ecb | warrants | convertible | gdr | adr",
  "amount_cr": null, "amount_upper_limit_cr": null, "issue_price_rs": null, "face_value_rs": null,
  "premium_rs": null, "coupon_rate_pct": null, "tenure": null, "maturity_date": null, "purpose": null,
  "investors": [], "is_anchor_investor_present": null, "listing_exchange": null, "credit_rating": null,
  "dilution_pct": null, "promoter_participation": "participating | not_participating | null",
  "shareholder_approval_status": "pending | received | not_required | null",
  "board_approval_date": null, "record_date": null, "issue_open_date": null, "issue_close_date": null
}

7.13 Stake Sale/Disinvestment
{
  "entity_divested": null, "entity_type": "subsidiary | associate | joint_venture | investment | null",
  "stake_sold_pct": null, "pre_sale_stake_pct": null, "post_sale_stake_pct": null,
  "buyer": null, "buyer_country": null, "consideration_cr": null,
  "consideration_type": "cash | stock | mixed | null", "gain_loss_on_sale_cr": null,
  "announcement_date": null, "expected_closing_date": null, "use_of_proceeds": null,
  "is_related_party": null, "becomes_non_subsidiary": null
}

7.14 Credit Rating Change
{
  "rating_agency": "CRISIL | ICRA | CARE | India Ratings | Brickworks | Acuite | Fitch | Moody's | S&P | other",
  "instrument": null, "instrument_size_cr": null,
  "old_long_term_rating": null, "new_long_term_rating": null,
  "old_short_term_rating": null, "new_short_term_rating": null,
  "old_outlook": null,
  "new_outlook": "positive | stable | negative | developing | rating_watch_positive | rating_watch_negative | not_applicable",
  "rating_action": "upgrade | downgrade | reaffirmed | placed_on_watch | removed_from_watch | withdrawn | assigned_initial",
  "notches_changed": null, "rationale": null, "is_investment_grade_post_action": null, "rating_date": null
}

7.15 Regulatory Action/Penalty
{
  "regulator": "SEBI | RBI | MCA | NCLT | NCLAT | CCI | Income Tax | GST | Customs | Stock Exchange | SAT | High Court | Supreme Court | other",
  "action_type": "penalty | show_cause_notice | investigation | final_order | interim_order | warning | suspension | debarment | approval | direction | settlement",
  "penalty_amount_cr": null, "violation": null, "regulation_breached": null, "affected_entity": null,
  "affected_persons": [], "order_date": null, "compliance_deadline": null,
  "appeal_status": "not_appealed | appeal_filed | appeal_pending | appeal_disposed | null",
  "appellate_forum": null, "is_material_under_reg30": null, "financial_impact_disclosed": null
}

7.16 Fraud/Default
{
  "event_type": "payment_default | fraud_detected | misrepresentation | siphoning | related_party_irregularity | forensic_audit_findings | whistleblower_matter",
  "amount_involved_cr": null, "parties_involved": [], "nature_of_default": null,
  "instrument_defaulted": null, "days_of_default": null, "first_default_date": null,
  "disclosure_trigger": "regulation_30 | regulation_51 | regulation_74 | auditor_flag | whistleblower | rbi_direction | other",
  "company_response": null, "remedial_actions": null,
  "forensic_auditor_appointed": null, "forensic_auditor_name": null
}

7.17 Insolvency/CIRP
{
  "proceeding_type": "cirp_initiation_by_company | cirp_initiation_by_creditor | cirp_admission | irp_appointed | rp_appointed | coc_formed | resolution_plan_submitted | resolution_plan_approved | resolution_plan_rejected | liquidation_order | moratorium | nclt_order | nclat_order | withdrawal_under_12a",
  "petitioner": null, "petitioner_type": "financial_creditor | operational_creditor | corporate_debtor_self | null",
  "amount_claimed_cr": null, "nclt_bench": null, "case_number": null,
  "filing_date": null, "admission_date": null, "next_hearing_date": null,
  "irp_or_rp_name": null, "resolution_applicant": null,
  "resolution_plan_value_cr": null, "haircut_pct": null
}

7.18 Open Offer/Takeover
{
  "acquirer": null, "persons_acting_in_concert": [], "target_company": null,
  "offer_size_shares": null, "offer_size_pct": null, "offer_price_rs": null, "offer_size_cr": null,
  "premium_over_cmp_pct": null,
  "trigger": "voluntary | mandatory_reg3 | mandatory_reg4 | mandatory_reg5 | indirect",
  "acquirer_pre_offer_stake_pct": null, "acquirer_post_offer_max_stake_pct": null,
  "public_announcement_date": null, "detailed_public_statement_date": null,
  "letter_of_offer_date": null, "opens_on": null, "closes_on": null, "manager_to_offer": null
}

7.19 Promoter Buy/Sell
{
  "action": "buy | sell | pledge | release_of_pledge | invocation | inter_se_transfer | gift | inheritance",
  "promoter_name": null, "promoter_group_entity": null, "shares_transacted": null,
  "value_cr": null, "price_per_share_rs": null,
  "transaction_date_from": null, "transaction_date_to": null,
  "pre_transaction_stake_pct": null, "post_transaction_stake_pct": null,
  "mode": "open_market | off_market | block_deal | bulk_deal | creeping_acquisition | preferential_allotment | null",
  "regulation": "SAST_reg29_1 | SAST_reg29_2 | PIT_reg7_1 | PIT_reg7_2 | other",
  "pledgee": null, "purpose_of_pledge": null, "pct_of_promoter_holding_pledged": null
}

7.20 Change in Key Management
{
  "action": "appointment | resignation | removal | retirement | re-designation | additional_charge | cessation_due_to_demise",
  "person_name": null, "role": null,
  "role_category": "chairman | md | ceo | cfo | cs | whole_time_director | independent_director | executive_director | non_executive_director | kmp_other",
  "effective_date": null, "tenure_years": null, "reason": null,
  "reason_category": "personal_reasons | health | retirement | better_opportunity | end_of_term | regulatory | undisclosed | other",
  "successor": null, "successor_effective_date": null, "is_promoter": null,
  "previous_organization": null, "remuneration_disclosed_cr": null
}

7.21 Operational Disruption
{
  "disruption_type": "fire | accident | explosion | strike | lockout | natural_disaster | cyberattack | data_breach | plant_shutdown | supply_chain_disruption | power_failure | raw_material_shortage",
  "disruption_date": null, "location": null, "facility_affected": null,
  "pct_of_total_capacity_affected": null, "casualties": null,
  "estimated_financial_impact_cr": null, "estimated_production_loss": null,
  "expected_resolution_date": null, "insurance_cover": null, "insurance_claim_cr": null,
  "regulatory_notifications_made": null, "force_majeure_invoked": null
}

7.22 Others
{}

7.23 Routine/Administrative
{}

7.24 Regulatory Approval/Licensing
{
  "approval_type": null, "issuing_authority": null, "governing_law": null,
  "approval_date": null, "announcement_date": null, "validity": null,
  "applicant_category": null, "scope_summary": null, "products_or_activities": [],
  "geography": null, "approved_capacity": null, "manufacturing_locations": [],
  "conditions_or_restrictions": null, "financial_impact_disclosed": null,
  "expected_revenue_impact_cr": null, "expected_capex_cr": null,
  "commercialization_timeline": null, "related_party_involvement": null, "disclosure_regulation": null
}

8. Summary Templates (per subcategory — skip lines where all fields are null, max 5 lines)

8.1 Financial Updates: 1) Company + period + basis + auditor opinion. 2) Quarter revenue YoY/QoQ. 3) Quarter EBITDA/net profit YoY/QoQ. 4) Full-year revenue + net profit + EPS YoY. 5) Dividend or guidance.
8.2 Concall/Presentation: 1) Company + event_type + period. 2) Date + time + mode. 3) Participants + host. 4) Registration/transcript. 5) Key themes.
8.3 Dividend: 1) Company + type + ₹/share + % face value + FY. 2) Record date + book closure + payment date. 3) Total payout + yield. 4) Conditional on AGM (if true).
8.4 Buyback: 1) Mode + size + shares + % equity. 2) Price + premium. 3) Record/tender dates. 4) Funding + promoter participation. 5) Shareholder approval (if needed).
8.5 Bonus/Split: 1) Action + ratio. 2) Face value change. 3) Record + ex date. 4) Board approval + shareholder approval. 5) Source (bonus only).
8.6 Acquisition: 1) Target + business + country. 2) Stake + deal value. 3) Consideration + funding. 4) Closing date + approvals needed. 5) Rationale + subsidiary status.
8.7 Merger/Demerger: 1) Action + entities. 2) Swap ratio + appointed date. 3) Approval statuses. 4) Completion + record date. 5) Rationale + dilution.
8.8 JV/Partnership: 1) Partner + country + purpose. 2) Entity name + stake split. 3) Investment + phased. 4) Geography + tenure + exclusivity. 5) Board approval.
8.9 Order Win: 1) Customer + type + country. 2) Value + scope. 3) Timeline. 4) Repeat/largest flags. 5) % orderbook/revenue.
8.10 Capex: 1) Project type + capacity + location. 2) Current → post capacity. 3) Capex + funding. 4) Start + commissioning. 5) Revenue potential.
8.11 Product Launch: 1) Product + category + type. 2) Geography + date + segment. 3) Pricing + revenue contribution. 4) Regulatory status. 5) First-in-country/world/patent.
8.12 Fund Raising: 1) Instrument + amount + purpose. 2) Price/coupon + tenure. 3) Investors + anchor. 4) Dilution + promoter participation. 5) Approvals + dates.
8.13 Stake Sale: 1) Entity + type + buyer. 2) Stake sold + pre→post. 3) Consideration + gain/loss. 4) Closing + proceeds. 5) Non-subsidiary + related party.
8.14 Credit Rating: 1) Agency + action + instrument + size. 2) LT old → new. 3) ST old → new. 4) Outlook + investment grade. 5) Rationale.
8.15 Regulatory Action: 1) Regulator + action + entity. 2) Violation + regulation. 3) Penalty + impact. 4) Order date + deadline. 5) Appeal + materiality.
8.16 Fraud/Default: 1) Event + parties. 2) Nature + instrument + amount. 3) Days + first date. 4) Trigger + forensic auditor. 5) Response + remedial.
8.17 Insolvency: 1) Proceeding + bench + case. 2) Petitioner + amount. 3) Dates. 4) IRP/RP + applicant. 5) Plan value + haircut.
8.18 Open Offer: 1) Acquirer + PAC + target. 2) Trigger + size. 3) Price + premium. 4) Pre→post stake. 5) Dates + manager.
8.19 Promoter Buy/Sell: 1) Promoter + action. 2) Shares + value + price. 3) Dates + mode. 4) Pre→post stake. 5) Regulation + pledge details.
8.20 Key Management: 1) Action + person + role. 2) Date + tenure/reason. 3) Successor. 4) Promoter + previous org. 5) Remuneration.
8.21 Disruption: 1) Type + facility + location + date. 2) Capacity % + production loss. 3) Casualties + notifications. 4) Financial impact + insurance. 5) Resolution + force majeure.
8.22 Others: 1) What filing is about. 2) Key parties. 3) Key numbers. 4) Impact/rationale. 5) Next steps.
8.23 Routine/Administrative: 1) Nature of filing + key date. Max 2 lines.
8.24 Regulatory Approval: 1) What approved + authority + law. 2) Date + validity + scope. 3) Locations + geography + capacity. 4) Strategic context. 5) Financial impact.

9. Headline & key_entities Rules

Headline (≤15 words): factual, active voice, includes company name + key number + counterparty where applicable. No adjectives like "major", "huge", "stellar". Reflects primary event only.

key_entities: include counterparties, regulators, rating agencies, auditors, named persons. NEVER include the announcing company itself. Return [] if nothing qualifies.

10. Guardrails

Currency: ALL monetary values in ₹ Crores. 1 Lakh = 0.01 Cr · 1 Million INR = 0.1 Cr · 1 Billion INR = 100 Cr. Foreign: USD 1 ≈ ₹83, EUR 1 ≈ ₹90, GBP 1 ≈ ₹105.
Percentages: always numeric. YoY/QoQ = ((new-old)/abs(old))*100 rounded to 1 decimal. Loss→profit: set _yoy_change_pct = null, write "turned profitable" in summary.
Dates: YYYY-MM-DD. FY26 = Apr 2025–Mar 2026. Q1=Apr-Jun, Q2=Jul-Sep, Q3=Oct-Dec, Q4=Jan-Mar.
Null handling: not stated → null. NEVER guess, fabricate, or use 0/"N/A"/"TBD" as stand-ins.
Enums: must match exact allowed values. Never invent new values.
Sentiment: very positive (transformational), positive (dividend/upgrade/buyback/growth), neutral (informational), negative (downgrade/resignation/penalty), very negative (fraud/insolvency/disaster).
Output: single valid JSON object. No markdown, no code fences, no prose outside the JSON.`;

function extractTextFromPDF(pdfPath) {
  return new Promise((resolve, reject) => {
    const parser = new PDFParser();
    parser.on('pdfParser_dataReady', data => {
      const safeDecode = s => { try { return decodeURIComponent(s); } catch { return s; } };
      const text = data.Pages
        .map(pg => pg.Texts.map(t => safeDecode(t.R.map(r => r.T).join(''))).join(' '))
        .join('\n');
      resolve(text);
    });
    parser.on('pdfParser_dataError', err => reject(new Error(err.parserError || String(err))));
    parser.loadPDF(pdfPath);
  });
}

async function processFile(ai, pdfPath) {
  const filename = path.basename(pdfPath);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Processing: ${filename}`);
  console.log('='.repeat(60));

  let text;
  try {
    text = await extractTextFromPDF(pdfPath);
  } catch (err) {
    console.error(`  Failed to extract text: ${err.message}`);
    return;
  }

  if (!text || text.trim().length < 50) {
    console.error(`  Skipping — extracted text too short (possibly scanned PDF)`);
    return;
  }

  console.log(`  Extracted ${text.length} characters of text`);

  const config = {
    thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
    responseMimeType: 'application/json',
    systemInstruction: [{ text: SYSTEM_INSTRUCTION }],
  };

  const contents = [
    {
      role: 'user',
      parts: [{ text: `filing_text: ${text}` }],
    },
  ];

  try {
    const response = await ai.models.generateContentStream({
      model: 'gemini-3.1-flash-lite-preview',
      config,
      contents,
    });

    let fullResponse = '';
    process.stdout.write('  Response: ');
    for await (const chunk of response) {
      if (chunk.text) {
        fullResponse += chunk.text;
        process.stdout.write('.');
      }
    }
    console.log(' done');

    // Parse and pretty-print
    let parsed;
    try {
      parsed = JSON.parse(fullResponse);
    } catch {
      console.error('  Warning: response is not valid JSON, saving raw');
      parsed = fullResponse;
    }

    const outputName = filename.replace(/\.pdf$/i, '.json');
    const outputPath = path.join(OUTPUT_DIR, outputName);
    fs.writeFileSync(outputPath, JSON.stringify(parsed, null, 2));
    console.log(`  Saved → output/${outputName}`);

    if (parsed && parsed.smart_subcategory) {
      console.log(`  Category : ${parsed.smart_subcategory}`);
      console.log(`  Headline : ${parsed.headline}`);
      console.log(`  Sentiment: ${parsed.sentiment}`);
    }
  } catch (err) {
    console.error(`  API error: ${err.message}`);
  }
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('Error: GEMINI_API_KEY environment variable not set');
    process.exit(1);
  }

  const ai = new GoogleGenAI({ apiKey });

  const pdfs = fs
    .readdirSync(PDF_DIR)
    .filter(f => f.toLowerCase().endsWith('.pdf'))
    .map(f => path.join(PDF_DIR, f));

  if (pdfs.length === 0) {
    console.error('No PDF files found in', PDF_DIR);
    process.exit(1);
  }

  console.log(`Found ${pdfs.length} PDF(s) to process`);

  for (const pdf of pdfs) {
    await processFile(ai, pdf);
    await new Promise(r => setTimeout(r, 4000)); // 4s gap to respect free-tier rate limits
  }

  console.log(`\nDone. Results saved to: ${OUTPUT_DIR}`);
}

main();
