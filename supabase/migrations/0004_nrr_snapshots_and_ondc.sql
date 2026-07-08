create table nrr_snapshots (
  id bigserial primary key,
  deal_id text not null references deals(deal_id),
  snapshot_date date not null,
  nrr_amount numeric not null,
  probability numeric,
  created_at timestamptz not null default now(),
  unique (deal_id, snapshot_date)
);

create index nrr_snapshots_deal_id_idx on nrr_snapshots (deal_id);
create index nrr_snapshots_snapshot_date_idx on nrr_snapshots (snapshot_date);

alter table nrr_snapshots enable row level security;
create policy "public read nrr_snapshots" on nrr_snapshots for select using (true);
create policy "authenticated write nrr_snapshots" on nrr_snapshots for all to authenticated using (true) with check (true);

insert into bu_baseline_mrr (business_unit, period, mrr_amount) values
  ('ONDC', 'June 2026 exit', 31989)
on conflict (business_unit) do nothing;
