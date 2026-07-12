create table nrr_target_settings (
  id bigserial primary key,
  business_unit text not null,
  period text not null,
  mode text not null default 'percent',
  value numeric not null,
  unique (business_unit, period)
);

alter table nrr_target_settings enable row level security;
create policy "public read nrr_target_settings" on nrr_target_settings for select using (true);
create policy "authenticated write nrr_target_settings" on nrr_target_settings for all to authenticated using (true) with check (true);
