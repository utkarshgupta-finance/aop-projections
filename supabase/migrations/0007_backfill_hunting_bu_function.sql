create or replace function backfill_hunting_bu()
returns void language sql security definer as $$
  update hunting_pipeline hp
  set business_unit = d.business_unit
  from deals d
  where hp.deal_id = d.deal_id
    and d.business_unit is not null
    and d.business_unit != 'UNMAPPED'
    and (hp.business_unit is null or hp.business_unit = 'UNMAPPED');
$$;
