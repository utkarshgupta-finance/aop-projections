# MRR Commit Dashboard — Handoff Spec (Zoho CRM → Supabase → Dashboard)

Context for whoever (or whichever Claude session) builds this: this replaces a manual weekly Excel tracker. The business logic below is locked — don't re-derive it, it was worked out deal-by-deal against a real export.

## Source of truth
Zoho CRM, module `Deals`. Deal type split via field `Deal_Type_New_or_Existing` (values: `Farming`, `Hunting`). MRR field is `MRR_Amount` (stored in deal's own currency, not always INR).

## Universe definition (applies to both Farming and Hunting)
A deal is "in" for a given snapshot if, at that snapshot date:
- `Closing_Date` falls in the target month (currently: July 2026, i.e. `> 2026-06-30` and `<= 2026-07-31`)
- `Probability >= 70`
- `MRR_Amount != 0` after currency conversion (0, blank, or negative-that-nets-to-zero all excluded — but genuine negative/churn deals with nonzero magnitude ARE included, e.g. a -₹9,03,000 degrowth deal counts)

## Currency conversion
`MRR_Amount` is in the deal's native currency. Convert to INR using **fixed rates**, not the CRM's own `Exchange_Rate` field (which drifts):
- USD → INR: **90.23**
- GBP → INR: **120.83**
- IDR → INR: **0.00543909**
- INR → INR: 1 (no-op)

Currency lives on field `Currency` (INR/USD/GBP on Deals; confirm no others exist before assuming full coverage).

## Business Unit — NOT the Region field
Region (`Region` field on Deals) is granular sales-territory data (~25 values like "MEA Apex Tribe", "India ENT North 1") — **do not use this as Business Unit.**

The real Business Unit taxonomy lives in a separate custom module chain:
- `Deals` → junction module `BU_Deal_Map` (fields: `Deal` lookup, `Business_Unit` lookup) → module `Business_Unit` (field `Name` = the BU display name)
- Query path: get `BU_Deal_Map` records where `Deal in (...)`, read `Business_Unit.name`.
- **Some deals map to two Business Units simultaneously** with no split-amount field. Resolved with these override rules (confirmed with the business owner, apply as-is, don't re-litigate):
  - If a deal is tagged to both `SEA BU` and `BAT BU`, and the deal name contains "BAT" → assign **BAT BU**.
  - If a deal is tagged to both `SEA BU` and `KAM BU` (this pattern = Godrej Indonesia / "GCPL Indo" deals) → assign **SEA BU**.
  - Any other multi-tag case: flag, don't silently pick one — ask.
- If a deal has **zero** BU_Deal_Map records (no tag at all): mark as `UNMAPPED`, do not guess. Surface these visibly in the dashboard (e.g. red badge) rather than dropping them.

Known BU values seen so far: `KAM BU`, `MEA BU`, `SEA BU`, `BAT BU`, `India MM BU`, `India ENT BU`, `SME BU`. Treat this list as provisional, not exhaustive — new BUs may appear.

## Account Name
`Account_Name` lookup field on the Deal → its `name` is the customer name.

## Suggested Supabase schema (normalized, not wide-format like the Excel version)

```sql
create table deals (
  deal_id text primary key,           -- Zoho record id, permanent, never changes
  deal_type text not null,            -- 'Farming' | 'Hunting'
  current_name text not null,         -- latest known deal name
  name_history text[],                -- append old names here on rename, don't overwrite
  business_unit text,                 -- null/'UNMAPPED' allowed
  account_name text
);

create table mrr_snapshots (
  id bigserial primary key,
  deal_id text references deals(deal_id),
  snapshot_date date not null,
  mrr_amount numeric not null,        -- INR, post-conversion
  probability numeric,                -- capture at time of snapshot, for context/debugging
  unique(deal_id, snapshot_date)
);
```

This normalizes the "wide" Excel format (one column per week) into "long" format (one row per deal per week) — much easier for a dashboard to query trends from (`select * from mrr_snapshots where deal_id = ... order by snapshot_date`) than parsing spreadsheet columns.

## Snapshot/refresh behavior (what "weekly pull" means)
- Each pull is a new `snapshot_date`.
- A deal already in `deals` just gets a new row in `mrr_snapshots` for the new date.
- A deal newly crossing the ≥70%-and-nonzero bar gets inserted into `deals`, with its first `mrr_snapshots` row starting at that date — **no backfilled rows for prior dates** (that's the "empty for earlier columns" rule from the spreadsheet version).
- If a tracked deal drops to 0 MRR or below the probability bar in a later week: **do not delete it or overwrite history.** Per the standing rule, don't insert a snapshot row with 0 for that week (leave a gap) — the dashboard should be able to show "no data this week" distinctly from "confirmed zero."
- Renames: when `current_name` changes in Zoho, update `deals.current_name` but push the old value onto `name_history` first. Never lose the original name.

## Open items to confirm with the business owner before automating fully
1. Whether "drop below 70% but still positive MRR" should still generate a snapshot row (current answer: yes, track the actual number regardless of probability once a deal has entered the universe) — confirmed.
2. What happens to a deal's `deals` row if it's Closed Lost — stays, with its snapshot history intact (confirmed: this is itself signal).
3. Multi-BU override rules above are currently just two named exceptions — if a third pattern shows up (e.g., a third dual-tag combination), stop and ask rather than extending the pattern-matching guess silently.

## Seed data attached
`mrr_commit_seed.csv` / `.json` — 93 deals (87 Farming + 6 Hunting) as of snapshot **2026-07-08**, already resolved for BU overrides and currency. Use this to seed `deals` and the first `mrr_snapshots` row for each. One deal (`Annai Dates`, Hunting) has `business_unit = "UNMAPPED"` by design — don't backfill a guess.
