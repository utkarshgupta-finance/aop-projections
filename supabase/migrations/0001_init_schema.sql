create table deals (
  deal_id text primary key,
  deal_type text not null check (deal_type in ('Farming', 'Hunting')),
  current_name text not null,
  name_history text[] not null default '{}',
  business_unit text,
  account_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table mrr_snapshots (
  id bigserial primary key,
  deal_id text not null references deals(deal_id),
  snapshot_date date not null,
  mrr_amount numeric not null,
  probability numeric,
  created_at timestamptz not null default now(),
  unique (deal_id, snapshot_date)
);

create index mrr_snapshots_deal_id_idx on mrr_snapshots (deal_id);
create index mrr_snapshots_snapshot_date_idx on mrr_snapshots (snapshot_date);
create index deals_business_unit_idx on deals (business_unit);
create index deals_deal_type_idx on deals (deal_type);

alter table deals enable row level security;
alter table mrr_snapshots enable row level security;

create policy "public read deals" on deals for select using (true);
create policy "public read mrr_snapshots" on mrr_snapshots for select using (true);
