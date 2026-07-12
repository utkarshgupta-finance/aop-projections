create or replace function bulk_update_hunting_bu(bu_map jsonb)
returns void language sql security definer as $$
  update hunting_pipeline hp
  set business_unit = (bu_map ->> hp.deal_id)
  where bu_map ? hp.deal_id
    and (bu_map ->> hp.deal_id) is not null;
$$;
