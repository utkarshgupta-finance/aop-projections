-- Actual booked revenue per account per BU per month.
-- Populated via the sheets-sync Edge Function (push from Google Sheets).
CREATE TABLE IF NOT EXISTS revenue_actuals (
  id             bigserial PRIMARY KEY,
  account_name   text      NOT NULL,
  business_unit  text      NOT NULL,
  month          date      NOT NULL,  -- first day of the month, e.g. 2026-07-01
  mrr_amount     numeric,
  nrr_amount     numeric,
  currency       text      NOT NULL DEFAULT 'INR',
  notes          text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS revenue_actuals_unique_idx
  ON revenue_actuals (account_name, business_unit, month);

ALTER TABLE revenue_actuals ENABLE ROW LEVEL SECURITY;

-- Anon / publishable key can read
CREATE POLICY "revenue_actuals_read" ON revenue_actuals
  FOR SELECT USING (true);

-- Service role writes (used by sheets-sync function)
CREATE POLICY "revenue_actuals_service_write" ON revenue_actuals
  FOR ALL USING (auth.role() = 'service_role');
