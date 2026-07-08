# MRR Commit Dashboard

Zoho CRM → Supabase → dashboard, replacing the manual weekly Excel MRR tracker.
Full business logic and schema rationale: [`docs/MRR_Dashboard_Handoff_Spec.md`](docs/MRR_Dashboard_Handoff_Spec.md).

## Status

- **Supabase project**: `aop-projections-mrr-dashboard` (ref `qnulyenilttpalbkmpvm`, org Bizom Finance, `ap-south-1`)
- **Schema**: applied (`supabase/migrations/0001_init_schema.sql`) — `deals` + `mrr_snapshots`, normalized per spec
- **Seed data**: loaded — 93 deals / 93 snapshot rows for `2026-07-08` (from `data/mrr_commit_seed.json`)
- **Sync logic**: validated end-to-end against live Zoho CRM data for the `2026-07-08` universe — the full pipeline (universe filter, currency conversion, BU resolution with override rules) reproduces the seed dataset exactly, including all multi-BU override cases and the one `UNMAPPED` deal (Annai Dates)
- **Dashboard**: working, reads live from Supabase

## Layout

- `docs/` — handoff spec
- `data/` — the seed snapshot (csv + json) used for the initial load
- `supabase/migrations/` — schema
- `scripts/zoho-sync/` — the weekly Zoho → Supabase sync job
- `dashboard/` — the dashboard (static HTML, reads Supabase directly)

## Running the weekly sync

```
cd scripts/zoho-sync
npm install
cp .env.example .env   # fill in Zoho OAuth app creds + Supabase service role key
npm run sync
```

Required env vars are documented in `.env.example`. `TARGET_MONTH` and `SNAPSHOT_DATE`
default to the current month/day — override them for a backfill or a specific run.
The script is idempotent: re-running it for the same `SNAPSHOT_DATE` updates that
date's rows rather than duplicating them.

If the sync logs a multi-BU flag ("ask, don't guess"), resolve it with the business
owner and add the override to `resolveBU()` in `sync.js` — per the spec, don't
extend the pattern-matching guess silently.

## Viewing the dashboard

`dashboard/index.html` is a self-contained static page — serve the `dashboard/`
directory with any static file server (or open the file directly) and it reads
straight from Supabase using the project's publishable (read-only, RLS-scoped) key.

## Automating the weekly pull

Not wired up yet. The natural next step is a scheduled GitHub Action (weekly cron)
that runs `scripts/zoho-sync` with the Zoho OAuth and Supabase service-role
credentials as repo secrets.
