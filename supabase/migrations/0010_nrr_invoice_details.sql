create table if not exists public.nrr_invoice_details (
  id             bigint generated always as identity primary key,
  account_name   text        not null,
  business_unit  text        not null,
  month          date        not null,
  inv_no         text        not null,
  memo           text,
  revenue_type   text,
  amount         numeric,
  updated_at     timestamptz not null default now(),
  unique (account_name, business_unit, inv_no, month)
);

alter table public.nrr_invoice_details enable row level security;

create policy "service role full access"
  on public.nrr_invoice_details
  for all
  using (true)
  with check (true);
