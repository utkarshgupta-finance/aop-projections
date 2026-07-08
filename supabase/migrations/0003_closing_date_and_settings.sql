alter table deals add column closing_date date;

update deals as d set closing_date = v.closing_date::date from (values
  ('10574000054107017', '2026-07-17'),
  ('10574000074152162', '2026-07-23'),
  ('10574000078638061', '2026-07-20'),
  ('10574000078658079', '2026-07-24'),
  ('10574000084105650', '2026-07-25'),
  ('10574000084630001', '2026-07-30'),
  ('10574000087379075', '2026-07-30'),
  ('10574000088263115', '2026-07-22'),
  ('10574000088520138', '2026-07-30'),
  ('10574000088520190', '2026-07-30'),
  ('10574000088817312', '2026-07-23'),
  ('10574000088842499', '2026-07-31'),
  ('10574000088892021', '2026-07-24'),
  ('10574000089320756', '2026-07-23'),
  ('10574000091023416', '2026-07-22'),
  ('10574000091045931', '2026-07-16'),
  ('10574000091608037', '2026-07-10'),
  ('10574000091771141', '2026-07-30'),
  ('10574000091901005', '2026-07-30'),
  ('10574000091952057', '2026-07-03'),
  ('10574000092424001', '2026-07-24'),
  ('10574000092439548', '2026-07-25'),
  ('10574000092439700', '2026-07-24'),
  ('10574000092738107', '2026-07-24'),
  ('10574000093065446', '2026-07-15'),
  ('10574000093522447', '2026-07-17'),
  ('10574000093863263', '2026-07-24'),
  ('10574000093866120', '2026-07-24'),
  ('10574000094093101', '2026-07-15'),
  ('10574000094110501', '2026-07-15'),
  ('10574000094355031', '2026-07-24'),
  ('10574000094428001', '2026-07-22'),
  ('10574000094646141', '2026-07-15'),
  ('10574000095098085', '2026-07-15'),
  ('10574000095098121', '2026-07-24'),
  ('10574000095423074', '2026-07-01'),
  ('10574000095470090', '2026-07-24'),
  ('10574000095470108', '2026-07-24'),
  ('10574000095825205', '2026-07-15'),
  ('10574000095825226', '2026-07-15'),
  ('10574000095832012', '2026-07-24'),
  ('10574000096259184', '2026-07-31'),
  ('10574000096537043', '2026-07-31'),
  ('10574000096542001', '2026-07-31'),
  ('10574000096546022', '2026-07-10'),
  ('10574000096685298', '2026-07-30'),
  ('10574000096697379', '2026-07-30'),
  ('10574000096737443', '2026-07-30'),
  ('10574000096982089', '2026-07-16'),
  ('10574000097029013', '2026-07-25'),
  ('10574000097391190', '2026-07-24'),
  ('10574000097415219', '2026-07-25'),
  ('10574000097442062', '2026-07-15'),
  ('10574000097443002', '2026-07-22'),
  ('10574000097450092', '2026-07-30'),
  ('10574000097455238', '2026-07-20'),
  ('10574000097700017', '2026-07-16'),
  ('10574000097896021', '2026-07-30'),
  ('10574000097918111', '2026-07-15'),
  ('10574000097920183', '2026-07-30'),
  ('10574000097927056', '2026-07-25'),
  ('10574000097927074', '2026-07-25'),
  ('10574000097927114', '2026-07-25'),
  ('10574000097927132', '2026-07-25'),
  ('10574000097927202', '2026-07-25'),
  ('10574000097927220', '2026-07-25'),
  ('10574000098049078', '2026-07-16'),
  ('10574000098057001', '2026-07-15'),
  ('10574000098089001', '2026-07-15'),
  ('10574000098100039', '2026-07-10'),
  ('10574000098208349', '2026-07-24'),
  ('10574000098218237', '2026-07-23'),
  ('10574000098236079', '2026-07-24'),
  ('10574000098386018', '2026-07-31'),
  ('10574000098386097', '2026-07-31'),
  ('10574000098389197', '2026-07-10'),
  ('10574000098389215', '2026-07-03'),
  ('10574000098397167', '2026-07-10'),
  ('10574000098397239', '2026-07-13'),
  ('10574000098397335', '2026-07-03'),
  ('10574000098397353', '2026-07-02'),
  ('10574000098405038', '2026-07-20'),
  ('10574000098420007', '2026-07-15'),
  ('10574000098420036', '2026-07-01'),
  ('10574000098420078', '2026-07-01'),
  ('10574000098431028', '2026-07-31'),
  ('10574000098431075', '2026-07-31'),
  ('10574000098431093', '2026-07-31'),
  ('10574000098555041', '2026-07-23'),
  ('10574000098573309', '2026-07-24'),
  ('10574000098587003', '2026-07-08'),
  ('10574000098589011', '2026-07-06'),
  ('10574000098591001', '2026-07-16')
) as v(deal_id, closing_date) where d.deal_id = v.deal_id;

create index deals_closing_date_idx on deals (closing_date);

create table target_settings (
  business_unit text not null,
  period text not null,
  mode text not null default 'percent' check (mode in ('percent', 'absolute')),
  value numeric not null,
  updated_at timestamptz not null default now(),
  primary key (business_unit, period)
);

alter table target_settings enable row level security;
create policy "public read target_settings" on target_settings for select using (true);
create policy "authenticated write target_settings" on target_settings for all to authenticated using (true) with check (true);

insert into target_settings (business_unit, period, mode, value)
select bu, period, 'percent', pct
from (values ('India ENT BU'), ('India MM BU'), ('BAT BU'), ('KAM BU'), ('SME BU'), ('MEA BU'), ('SEA BU')) as bus(bu)
cross join (values ('July 2026', 30), ('August 2026', 30), ('September 2026', 40)) as periods(period, pct);

create table nrr_targets (
  business_unit text primary key,
  period text not null,
  target_amount numeric not null,
  updated_at timestamptz not null default now()
);

alter table nrr_targets enable row level security;
create policy "public read nrr_targets" on nrr_targets for select using (true);
create policy "authenticated write nrr_targets" on nrr_targets for all to authenticated using (true) with check (true);

insert into nrr_targets (business_unit, period, target_amount) values
  ('India ENT BU', 'JAS 2026', 20500000),
  ('India MM BU', 'JAS 2026', 6000000),
  ('SEA BU', 'JAS 2026', 2200000),
  ('KAM BU', 'JAS 2026', 38000000),
  ('MEA BU', 'JAS 2026', 11000000),
  ('BAT BU', 'JAS 2026', 84000000),
  ('SME BU', 'JAS 2026', 4120000);

create table bu_baseline_mrr (
  business_unit text primary key,
  period text not null,
  mrr_amount numeric not null,
  updated_at timestamptz not null default now()
);

alter table bu_baseline_mrr enable row level security;
create policy "public read bu_baseline_mrr" on bu_baseline_mrr for select using (true);
create policy "authenticated write bu_baseline_mrr" on bu_baseline_mrr for all to authenticated using (true) with check (true);

insert into bu_baseline_mrr (business_unit, period, mrr_amount) values
  ('BAT BU', 'June 2026 exit', 10575107),
  ('India ENT BU', 'June 2026 exit', 22231220),
  ('India MM BU', 'June 2026 exit', 22602706),
  ('KAM BU', 'June 2026 exit', 6755551),
  ('MEA BU', 'June 2026 exit', 6192775),
  ('SEA BU', 'June 2026 exit', 1647767),
  ('SME BU', 'June 2026 exit', 8625322);

create policy "authenticated write bu_targets" on bu_targets for all to authenticated using (true) with check (true);
