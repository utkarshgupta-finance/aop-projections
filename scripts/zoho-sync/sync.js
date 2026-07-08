// Weekly Zoho CRM -> Supabase sync for the MRR commit dashboard.
// Business rules mirror docs/MRR_Dashboard_Handoff_Spec.md verbatim -- don't re-derive them here.
'use strict';

const { createClient } = require('@supabase/supabase-js');

const ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.com';
const ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com';
const ZOHO_CLIENT_ID = required('ZOHO_CLIENT_ID');
const ZOHO_CLIENT_SECRET = required('ZOHO_CLIENT_SECRET');
const ZOHO_REFRESH_TOKEN = required('ZOHO_REFRESH_TOKEN');
const SUPABASE_URL = required('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = required('SUPABASE_SERVICE_ROLE_KEY');

// Fixed conversion rates -- deliberately NOT the CRM's own Exchange_Rate field, which drifts.
const CURRENCY_RATES = { INR: 1, USD: 90.23, GBP: 120.83, IDR: 0.00543909 };

const now = new Date();
const targetMonth = process.env.TARGET_MONTH || `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
const snapshotDate = process.env.SNAPSHOT_DATE || now.toISOString().slice(0, 10);

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

function monthBounds(yyyyMm) {
  const [y, m] = yyyyMm.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0)); // last day of month
  const fmt = d => d.toISOString().slice(0, 10);
  const dayBefore = new Date(start);
  dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
  return { closingDateGT: fmt(dayBefore), closingDateLTE: fmt(end) };
}

async function getAccessToken() {
  const url = `${ZOHO_ACCOUNTS_DOMAIN}/oauth/v2/token?refresh_token=${ZOHO_REFRESH_TOKEN}&client_id=${ZOHO_CLIENT_ID}&client_secret=${ZOHO_CLIENT_SECRET}&grant_type=refresh_token`;
  const res = await fetch(url, { method: 'POST' });
  const body = await res.json();
  if (!body.access_token) throw new Error(`zoho auth failed: ${JSON.stringify(body)}`);
  return body.access_token;
}

async function coql(accessToken, selectQuery) {
  const res = await fetch(`${ZOHO_API_DOMAIN}/crm/v6/coql`, {
    method: 'POST',
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ select_query: selectQuery }),
  });
  const body = await res.json();
  if (body.status === 'error') throw new Error(`COQL error: ${JSON.stringify(body)}`);
  return body.data || [];
}

async function fetchUniverseDeals(accessToken) {
  const { closingDateGT, closingDateLTE } = monthBounds(targetMonth);
  const rows = [];
  let offset = 0;
  const pageSize = 200;
  for (;;) {
    const query = `select id, Deal_Name, Closing_Date, Probability, MRR_Amount, Currency, ` +
      `Deal_Type_New_or_Existing, Account_Name from Deals where ` +
      `(Closing_Date > '${closingDateGT}' and Closing_Date <= '${closingDateLTE}') ` +
      `and Probability >= 70 limit ${offset},${pageSize}`;
    const page = await coql(accessToken, query);
    rows.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

async function fetchBUTags(accessToken, dealIds) {
  const tagsByDeal = new Map();
  const batchSize = 100;
  for (let i = 0; i < dealIds.length; i += batchSize) {
    const batch = dealIds.slice(i, i + batchSize).map(id => `'${id}'`).join(',');
    const rows = await coql(accessToken, `select Deal, Business_Unit from BU_Deal_Map where Deal in (${batch}) limit 200`);
    for (const row of rows) {
      const dealId = row.Deal.id;
      if (!tagsByDeal.has(dealId)) tagsByDeal.set(dealId, []);
      tagsByDeal.get(dealId).push(row.Business_Unit.name);
    }
  }
  return tagsByDeal;
}

// Returns { bu, flagged } -- flagged=true means "don't silently pick one, ask" (per spec).
function resolveBU(dealName, tags) {
  if (!tags || tags.length === 0) return { bu: 'UNMAPPED', flagged: false };
  if (tags.length === 1) return { bu: tags[0], flagged: false };
  const set = new Set(tags);
  if (set.has('SEA BU') && set.has('BAT BU') && /BAT/i.test(dealName)) return { bu: 'BAT BU', flagged: false };
  if (set.has('SEA BU') && set.has('KAM BU')) return { bu: 'SEA BU', flagged: false };
  return { bu: null, flagged: true };
}

async function main() {
  console.log(`Syncing MRR commit universe for ${targetMonth}, snapshot_date=${snapshotDate}`);

  const accessToken = await getAccessToken();
  const dealsRaw = await fetchUniverseDeals(accessToken);
  console.log(`Zoho universe (before MRR!=0 filter): ${dealsRaw.length} deals`);

  const universe = [];
  for (const d of dealsRaw) {
    if (d.MRR_Amount === 0 || d.MRR_Amount === null) continue;
    const rate = CURRENCY_RATES[d.Currency];
    if (rate === undefined) {
      throw new Error(`unknown currency "${d.Currency}" on deal ${d.id} (${d.Deal_Name}) -- add a fixed rate before proceeding`);
    }
    universe.push({
      id: d.id,
      name: d.Deal_Name,
      dealType: d.Deal_Type_New_or_Existing,
      accountName: d.Account_Name.name,
      mrrInr: Math.round(d.MRR_Amount * rate * 100) / 100,
      probability: d.Probability,
    });
  }
  console.log(`Universe after MRR!=0 filter: ${universe.length} deals`);

  const tagsByDeal = await fetchBUTags(accessToken, universe.map(d => d.id));
  const flagged = [];
  for (const d of universe) {
    const { bu, flagged: isFlagged } = resolveBU(d.name, tagsByDeal.get(d.id));
    d.businessUnit = bu;
    if (isFlagged) flagged.push({ id: d.id, name: d.name, tags: tagsByDeal.get(d.id) });
  }

  if (flagged.length) {
    console.warn(`\n${flagged.length} deal(s) have an unresolved multi-BU tag combination -- ask the business owner, do not guess:`);
    flagged.forEach(f => console.warn(`  ${f.id} ${f.name}: ${f.tags.join(' + ')}`));
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const dealIds = universe.map(d => d.id);
  const { data: existingDeals, error: fetchErr } = await supabase
    .from('deals')
    .select('deal_id, current_name, name_history, business_unit')
    .in('deal_id', dealIds);
  if (fetchErr) throw fetchErr;
  const existingByDeal = new Map((existingDeals || []).map(r => [r.deal_id, r]));

  const dealRows = universe.map(d => {
    const existing = existingByDeal.get(d.id);
    const nameHistory = existing?.name_history || [];
    const renamed = existing && existing.current_name !== d.name;
    // Flagged multi-BU deals keep their previous business_unit rather than a guessed value.
    const businessUnit = d.businessUnit === null && existing ? existing.business_unit : d.businessUnit;
    return {
      deal_id: d.id,
      deal_type: d.dealType,
      current_name: d.name,
      name_history: renamed ? [...nameHistory, existing.current_name] : nameHistory,
      business_unit: businessUnit,
      account_name: d.accountName,
      updated_at: new Date().toISOString(),
    };
  });

  const { error: upsertDealsErr } = await supabase.from('deals').upsert(dealRows, { onConflict: 'deal_id' });
  if (upsertDealsErr) throw upsertDealsErr;
  console.log(`Upserted ${dealRows.length} deals rows`);

  const snapshotRows = universe.map(d => ({
    deal_id: d.id,
    snapshot_date: snapshotDate,
    mrr_amount: d.mrrInr,
    probability: d.probability,
  }));
  const { error: upsertSnapErr } = await supabase
    .from('mrr_snapshots')
    .upsert(snapshotRows, { onConflict: 'deal_id,snapshot_date' });
  if (upsertSnapErr) throw upsertSnapErr;
  console.log(`Upserted ${snapshotRows.length} mrr_snapshots rows for ${snapshotDate}`);

  // Deals that dropped out of the universe this week intentionally get no new row --
  // that's the "gap, not zero" rule. Nothing to do here.

  console.log('Sync complete.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
