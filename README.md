# MRR Commit Dashboard

Zoho CRM -> Supabase -> dashboard, replacing the manual weekly Excel MRR tracker.
Full business logic and schema rationale: [`docs/MRR_Dashboard_Handoff_Spec.md`](docs/MRR_Dashboard_Handoff_Spec.md).

## Status

- **Supabase project**: `aop-projections-mrr-dashboard` (ref `qnulyenilttpalbkmpvm`, org Bizom Finance, `ap-south-1`)
- **Schema**: applied, see `supabase/migrations/`
- **Seed data**: loaded, 93 deals / 93 snapshot rows for `2026-07-08` (from `data/mrr_commit_seed.json`)
- **Sync logic**: validated end-to-end against live Zoho CRM data for the `2026-07-08` universe, the full pipeline (universe filter, currency conversion, BU resolution with override rules) reproduces the seed dataset exactly, including all multi-BU override cases and the one `UNMAPPED` deal (Annai Dates)
- **Dashboard**: working, reads live from Supabase, with Combined/Farming/Hunting and July/August/September/JAS tabs, sort/filter/search, and Zoho deep links
- **Settings page**: working, requires a Supabase Auth login (see setup below)

## Layout

- `docs/` - handoff spec
- `data/` - the seed snapshot (csv + json) used for the initial load
- `supabase/migrations/` - schema
- `scripts/zoho-sync/` - the weekly Zoho -> Supabase sync job
- `dashboard/` - the dashboard (`index.html`) and settings page (`settings.html`), both static, both read/write Supabase directly

## Database schema

- `deals` - one row per tracked deal (deal_id, current_name, name_history, business_unit, account_name, deal_type, closing_date)
- `mrr_snapshots` - one row per deal per weekly pull (deal_id, snapshot_date, mrr_amount, probability). A deal that drops out of the universe for a week gets no row that week (a gap, not a zero) per the spec.
- `bu_targets` - the JAS 2026 quarter MRR target per business unit
- `target_settings` - how each BU's JAS target splits across July/August/September: either a percent of the JAS target (default 30/30/40) or an absolute override. Edited from the settings page.
- `nrr_targets` - non-recurring revenue targets per BU for JAS 2026 (reference only, not wired into the MRR attainment math)
- `bu_baseline_mrr` - June 2026 exit MRR per BU (reference only, the existing book of business, separate from the commit deals tracked above)

All tables are publicly readable (the dashboard's anon key is read-only by RLS).
`bu_targets` and `target_settings` also accept writes from authenticated Supabase
users, which is what the settings page uses.

## One-time setup: create a settings-page login

The settings page needs a Supabase Auth user to save changes; there is no way to
create one via this repo's tooling. In the Supabase dashboard for this project: go to
Authentication > Users > Add user, and create an email/password account. Anyone with
those credentials can edit targets from `dashboard/settings.html`; the public
dashboard itself stays read-only regardless.

## Running the weekly sync

```
cd scripts/zoho-sync
npm install
cp .env.example .env   # fill in Zoho OAuth app creds + Supabase service role key
npm run sync
```

Required env vars are documented in `.env.example`. `TARGET_MONTH` and `SNAPSHOT_DATE`
default to the current month/day, override them for a backfill or a specific run.
The script is idempotent: re-running it for the same `SNAPSHOT_DATE` updates that
date's rows rather than duplicating them. It also backfills `deals.closing_date`,
which drives the dashboard's July/August/September tabs.

If the sync logs a multi-BU flag ("ask, don't guess"), resolve it with the business
owner and add the override to `resolveBU()` in `sync.js`, per the spec, don't
extend the pattern-matching guess silently.

## Viewing the dashboard

`dashboard/index.html` is a self-contained static page, serve the `dashboard/`
directory with any static file server (or open the file directly) and it reads
straight from Supabase using the project's publishable (read-only, RLS-scoped) key.
It's also deployed to GitHub Pages automatically on push (see
`.github/workflows/deploy-pages.yml`).

## Automating the weekly pull

Not wired up yet. The natural next step is a scheduled GitHub Action (weekly cron)
that runs `scripts/zoho-sync` with the Zoho OAuth and Supabase service-role
credentials as repo secrets.
