create table bu_targets (
  business_unit text primary key,
  period text not null,
  target_amount numeric not null,
  updated_at timestamptz not null default now()
);

alter table bu_targets enable row level security;
create policy "public read bu_targets" on bu_targets for select using (true);

insert into bu_targets (business_unit, period, target_amount) values
  ('India ENT BU', 'JAS 2026', 1040000),
  ('India MM BU', 'JAS 2026', 1700000),
  ('BAT BU', 'JAS 2026', 2100000),
  ('KAM BU', 'JAS 2026', 2000000),
  ('SME BU', 'JAS 2026', 970000),
  ('MEA BU', 'JAS 2026', 0),
  ('SEA BU', 'JAS 2026', 485000);
