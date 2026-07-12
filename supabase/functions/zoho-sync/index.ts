import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ZOHO_ACCOUNTS_DOMAIN = Deno.env.get('ZOHO_ACCOUNTS_DOMAIN') ?? 'https://accounts.zoho.com';
const ZOHO_API_DOMAIN      = Deno.env.get('ZOHO_API_DOMAIN')      ?? 'https://www.zohoapis.com';
const ZOHO_CLIENT_ID       = Deno.env.get('ZOHO_CLIENT_ID')       ?? '';
const ZOHO_CLIENT_SECRET   = Deno.env.get('ZOHO_CLIENT_SECRET')   ?? '';
const ZOHO_REFRESH_TOKEN   = Deno.env.get('ZOHO_REFRESH_TOKEN')   ?? '';

const CURRENCY_RATES: Record<string, number> = {
  INR: 1,
  USD: 90.23,
  GBP: 120.83,
  IDR: 0.00543909,
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const BU_MODULE_CANDIDATES = [
  'Business_Units', 'Business_Unit', 'BUs', 'BusinessUnits', 'BU',
  'Business_units', 'business_units',
];

function extractName(field: any): string {
  if (!field) return '';
  if (typeof field === 'string') return field;
  if (typeof field !== 'object') return String(field);
  for (const key of ['name', 'display_value', 'Display_Value', 'label', 'value', 'Account_Name']) {
    if (field[key] && typeof field[key] === 'string') return field[key];
  }
  for (const val of Object.values(field)) {
    if (typeof val === 'string' && val.length > 0 && !/^\d+$/.test(val)) return val;
  }
  return '';
}

// Returns the current quarter key, e.g. "2026-Q3"
function currentQuarterKey(date: Date): string {
  const m = date.getUTCMonth() + 1;
  const q = Math.ceil(m / 3);
  return `${date.getUTCFullYear()}-Q${q}`;
}

// Returns {dayBefore, end} for use in COQL: Closing_Date > dayBefore AND Closing_Date <= end
function quarterRange(quarter: string): { dayBefore: string; end: string } {
  const [yearStr, qStr] = quarter.split('-Q');
  const year = parseInt(yearStr), q = parseInt(qStr);
  const startMonth = (q - 1) * 3 + 1;
  const endMonth   = startMonth + 2;
  const startDate  = new Date(Date.UTC(year, startMonth - 1, 1));
  const endDate    = new Date(Date.UTC(year, endMonth, 0)); // last day of endMonth
  const dayBefore  = new Date(startDate);
  dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { dayBefore: fmt(dayBefore), end: fmt(endDate) };
}

async function getAccessToken(): Promise<string> {
  const url = `${ZOHO_ACCOUNTS_DOMAIN}/oauth/v2/token` +
    `?refresh_token=${ZOHO_REFRESH_TOKEN}` +
    `&client_id=${ZOHO_CLIENT_ID}` +
    `&client_secret=${ZOHO_CLIENT_SECRET}` +
    `&grant_type=refresh_token`;
  const res = await fetch(url, { method: 'POST' });
  const body = await res.json();
  if (!body.access_token) throw new Error(`Zoho auth failed: ${JSON.stringify(body)}`);
  return body.access_token;
}

async function coqlRaw(token: string, query: string): Promise<{ data: any[]; error: any }> {
  try {
    const res = await fetch(`${ZOHO_API_DOMAIN}/crm/v6/coql`, {
      method: 'POST',
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ select_query: query }),
    });
    const body = await res.json();
    if (body.status === 'error') return { data: [], error: body };
    return { data: body.data ?? [], error: null };
  } catch (e: any) {
    return { data: [], error: e.message };
  }
}

async function coql(token: string, query: string): Promise<any[]> {
  const { data, error } = await coqlRaw(token, query);
  if (error) throw new Error(`COQL error: ${JSON.stringify(error)}`);
  return data;
}

// Fetch main universe deals (probability >= 70) for the full quarter date range.
async function fetchUniverseDeals(token: string, dayBefore: string, end: string) {
  const rows: any[] = [];
  let offset = 0;
  const pageSize = 200;
  for (;;) {
    const query =
      `select id, Deal_Name, Closing_Date, Probability, MRR_Amount, NRR_Amount, Currency, ` +
      `Deal_Type_New_or_Existing, Account_Name from Deals where ` +
      `(Closing_Date > '${dayBefore}' and Closing_Date <= '${end}') ` +
      `and Probability >= 70 limit ${offset},${pageSize}`;
    const page = await coql(token, query);
    rows.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

// Fetch ALL hunting/new-account deals for the quarter (any probability).
async function fetchHuntingPipelineDeals(token: string, dayBefore: string, end: string) {
  const rows: any[] = [];
  let offset = 0;
  const pageSize = 200;
  for (;;) {
    const query =
      `select id, Deal_Name, Stage, Closing_Date, Probability, MRR_Amount, NRR_Amount, Currency, Account_Name, Owner ` +
      `from Deals where ` +
      `(Closing_Date > '${dayBefore}' and Closing_Date <= '${end}') ` +
      `and Deal_Type_New_or_Existing = 'Hunting' ` +
      `limit ${offset},${pageSize}`;
    const page = await coql(token, query);
    rows.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

async function fetchAccountNames(token: string, accountIds: string[]): Promise<Map<string, string>> {
  const nameById = new Map<string, string>();
  const batchSize = 50;
  for (let i = 0; i < accountIds.length; i += batchSize) {
    const batch = accountIds.slice(i, i + batchSize).map(id => `'${id}'`).join(',');
    const rows = await coql(token, `select id, Account_Name from Accounts where id in (${batch})`);
    for (const row of rows) {
      const name = typeof row.Account_Name === 'string'
        ? row.Account_Name
        : extractName(row.Account_Name);
      if (name) nameById.set(String(row.id), name);
    }
  }
  return nameById;
}

async function discoverBUModule(token: string, sampleBUId: string): Promise<{
  moduleName: string | null;
  probeResults: { candidate: string; found: boolean; error: any }[];
}> {
  const probeResults: { candidate: string; found: boolean; error: any }[] = [];

  for (const candidate of BU_MODULE_CANDIDATES) {
    const { data, error } = await coqlRaw(token,
      `select id, Name from ${candidate} where id = '${sampleBUId}'`);
    const found = !error && data.length > 0 && !!data[0].Name;
    probeResults.push({ candidate, found, error: error ?? null });
    if (found) {
      console.log(`BU module found via COQL: ${candidate}`);
      return { moduleName: candidate, probeResults };
    }
  }

  for (const candidate of BU_MODULE_CANDIDATES) {
    try {
      const res = await fetch(
        `${ZOHO_API_DOMAIN}/crm/v6/${candidate}/${sampleBUId}`,
        { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
      );
      const body = await res.json();
      if (body?.data?.[0]?.Name) {
        console.log(`BU module found via REST: ${candidate}`);
        return { moduleName: `__rest__${candidate}`, probeResults };
      }
    } catch { /* skip */ }
  }

  return { moduleName: null, probeResults };
}

async function fetchBUNamesByIds(
  token: string,
  moduleName: string,
  buIds: string[],
): Promise<Map<string, string>> {
  const nameById = new Map<string, string>();
  const isRest = moduleName.startsWith('__rest__');
  const mod = isRest ? moduleName.slice(8) : moduleName;
  const batchSize = 50;

  for (let i = 0; i < buIds.length; i += batchSize) {
    const batch = buIds.slice(i, i + batchSize);
    if (isRest) {
      try {
        const res = await fetch(
          `${ZOHO_API_DOMAIN}/crm/v6/${mod}?ids=${batch.join(',')}&fields=id,Name`,
          { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
        );
        const body = await res.json();
        for (const r of body?.data ?? []) {
          if (r.id && r.Name) nameById.set(String(r.id), String(r.Name));
        }
      } catch { /* skip */ }
    } else {
      const ids = batch.map(id => `'${id}'`).join(',');
      const { data } = await coqlRaw(token, `select id, Name from ${mod} where id in (${ids})`);
      for (const r of data) {
        if (r.id && r.Name) nameById.set(String(r.id), String(r.Name));
      }
    }
  }
  return nameById;
}

async function fetchBUTags(token: string, dealIds: string[]): Promise<{
  tagsByDeal: Map<string, string[]>;
  buNameMissing: number;
  debugBU: any;
}> {
  const tagsByDeal = new Map<string, string[]>();
  let buNameMissing = 0;

  type RawRow = { dealId: string; buId: string | null; buText: string | null };
  const rawRows: RawRow[] = [];

  const batchSize = 50;
  for (let i = 0; i < dealIds.length; i += batchSize) {
    const batch = dealIds.slice(i, i + batchSize).map(id => `'${id}'`).join(',');
    let offset = 0;
    const pageSize = 200;
    for (;;) {
      const { data: rows, error } = await coqlRaw(token,
        `select Deal, Business_Unit from BU_Deal_Map where Deal in (${batch}) limit ${offset},${pageSize}`);
      if (error) { console.warn('BU_Deal_Map error:', JSON.stringify(error)); break; }
      for (const row of rows) {
        const dealId = String(row.Deal?.id ?? row.Deal);
        const buText = extractName(row.Business_Unit);
        const buId = (!buText && row.Business_Unit?.id) ? String(row.Business_Unit.id) : null;
        rawRows.push({ dealId, buId, buText: buText || null });
      }
      if (rows.length < pageSize) break;
      offset += pageSize;
    }
  }

  const buIdSet = new Set(rawRows.filter(r => r.buId).map(r => r.buId!));
  let buNameById = new Map<string, string>();
  let debugBUModule: any = null;

  if (buIdSet.size > 0) {
    const sampleId = [...buIdSet][0];
    const { moduleName, probeResults } = await discoverBUModule(token, sampleId);
    debugBUModule = { moduleName, probeResults };
    console.log(`BU module: ${moduleName}, unique IDs: ${buIdSet.size}`);
    if (moduleName) {
      buNameById = await fetchBUNamesByIds(token, moduleName, [...buIdSet]);
      console.log(`BU names resolved: ${buNameById.size}/${buIdSet.size}`);
    }
  }

  for (const { dealId, buId, buText } of rawRows) {
    const buName = buText ?? (buId ? buNameById.get(buId) ?? '' : '');
    if (!buName) { buNameMissing++; continue; }
    if (!tagsByDeal.has(dealId)) tagsByDeal.set(dealId, []);
    tagsByDeal.get(dealId)!.push(buName);
  }

  return {
    tagsByDeal,
    buNameMissing,
    debugBU: {
      totalBUMapRows: rawRows.length,
      buIdCount: buIdSet.size,
      buIds: [...buIdSet],
      buResolved: buNameById.size,
      buModule: debugBUModule,
    },
  };
}

function resolveBU(dealName: string, tags: string[] | undefined): { bu: string | null; flagged: boolean } {
  if (!tags || tags.length === 0) return { bu: 'UNMAPPED', flagged: false };
  if (tags.length === 1)          return { bu: tags[0],    flagged: false };
  const set = new Set(tags);
  if (set.has('SEA BU') && set.has('BAT BU') && /BAT/i.test(dealName)) return { bu: 'BAT BU', flagged: false };
  if (set.has('SEA BU') && set.has('KAM BU'))                           return { bu: 'SEA BU', flagged: false };
  return { bu: null, flagged: true };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !ZOHO_REFRESH_TOKEN) {
    return new Response(
      JSON.stringify({ ok: false, error: 'Zoho credentials not configured.' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  try {
    const reqBody = await req.json().catch(() => ({}));
    const now = new Date();

    // Quarter-based sync (replaces single target_month).
    // Falls back to current quarter if not specified.
    const targetQuarter: string = reqBody.target_quarter ?? currentQuarterKey(now);
    const snapshotDate: string  = reqBody.snapshot_date  ?? now.toISOString().slice(0, 10);
    const { dayBefore, end }    = quarterRange(targetQuarter);

    console.log(`Syncing quarter=${targetQuarter} (${dayBefore} to ${end}) snapshot=${snapshotDate}`);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const token = await getAccessToken();

    // ---- Universe deals (prob >= 70, for MRR/NRR commit tracking) ----
    const dealsRaw = await fetchUniverseDeals(token, dayBefore, end);
    console.log(`Zoho raw deals (>=70%): ${dealsRaw.length}`);

    // ---- Account name lookup for deals with object-style Account_Name ----
    const accountIdsToLookup = new Set<string>();
    for (const d of dealsRaw) {
      if (!extractName(d.Account_Name) && d.Account_Name?.id) {
        accountIdsToLookup.add(String(d.Account_Name.id));
      }
    }
    let accountNameMap = new Map<string, string>();
    if (accountIdsToLookup.size > 0) {
      accountNameMap = await fetchAccountNames(token, [...accountIdsToLookup]);
    }

    const universe: any[] = [];
    for (const d of dealsRaw) {
      const mrr = d.MRR_Amount ?? 0;
      const nrr = d.NRR_Amount ?? 0;
      if (mrr === 0 && nrr === 0) continue;
      const rate = CURRENCY_RATES[d.Currency as string];
      if (rate === undefined) {
        throw new Error(`Unknown currency "${d.Currency}" on deal ${d.id} (${d.Deal_Name})`);
      }
      let accountName = extractName(d.Account_Name);
      if (!accountName && d.Account_Name?.id) {
        accountName = accountNameMap.get(String(d.Account_Name.id)) ?? '';
      }
      universe.push({
        id: String(d.id), name: d.Deal_Name, dealType: d.Deal_Type_New_or_Existing,
        accountName,
        mrrInr: mrr === 0 ? 0 : Math.round(mrr * rate * 100) / 100,
        nrrInr: nrr === 0 ? 0 : Math.round(nrr * rate * 100) / 100,
        probability: d.Probability, closingDate: d.Closing_Date,
      });
    }
    console.log(`Universe: ${universe.length}`);

    // ---- Hunting pipeline (all hunting deals, any probability) ----
    // Fetched BEFORE BU tags so we can do a single combined BU lookup for all deals.
    const huntingRawAll = await fetchHuntingPipelineDeals(token, dayBefore, end);
    const huntingRaw = huntingRawAll.filter(d => {
      const stage = typeof d.Stage === 'string' ? d.Stage : extractName(d.Stage);
      return stage !== 'Closed Lost';
    });
    console.log(`Hunting pipeline raw: ${huntingRawAll.length}, after Closed Lost filter: ${huntingRaw.length}`);

    // Collect any account IDs in hunting deals that need name resolution
    const huntingAccountIds = new Set<string>();
    for (const d of huntingRaw) {
      if (!extractName(d.Account_Name) && d.Account_Name?.id) {
        huntingAccountIds.add(String(d.Account_Name.id));
      }
    }
    if (huntingAccountIds.size > 0) {
      const extra = await fetchAccountNames(token, [...huntingAccountIds]);
      extra.forEach((v, k) => accountNameMap.set(k, v));
    }

    // ---- BU tags — single call covering both universe and hunting deals ----
    const allDealIdsForBU = [...new Set([
      ...universe.map(d => d.id),
      ...huntingRaw.map(d => String(d.id)),
    ])];
    const { tagsByDeal, buNameMissing, debugBU } =
      await fetchBUTags(token, allDealIdsForBU);
    console.log(`BU tags resolved for ${tagsByDeal.size} of ${allDealIdsForBU.length} deals`);

    const flagged: any[] = [];
    for (const d of universe) {
      const { bu, flagged: isFlagged } = resolveBU(d.name, tagsByDeal.get(d.id));
      d.businessUnit = bu;
      if (isFlagged) flagged.push({ id: d.id, name: d.name, tags: tagsByDeal.get(d.id) });
    }

    // ---- Fetch existing deals (for bu_override and name history) ----
    const dealIds = universe.map(d => d.id);
    const { data: existingDeals, error: fetchErr } = await supabase
      .from('deals')
      .select('deal_id, current_name, name_history, business_unit, bu_override')
      .in('deal_id', dealIds);
    if (fetchErr) throw fetchErr;
    const existingByDeal = new Map((existingDeals ?? []).map((r: any) => [r.deal_id, r]));

    const dealRows = universe.map(d => {
      const existing    = existingByDeal.get(d.id);
      const nameHistory = existing?.name_history ?? [];
      const renamed     = existing && existing.current_name !== d.name;
      const buOverride  = existing?.bu_override ?? null;
      const businessUnit = buOverride
        ?? (d.businessUnit !== null ? d.businessUnit : (existing?.business_unit ?? 'UNMAPPED'));
      return {
        deal_id: d.id, deal_type: d.dealType, current_name: d.name,
        name_history: renamed ? [...nameHistory, existing.current_name] : nameHistory,
        business_unit: businessUnit, bu_override: buOverride,
        account_name: d.accountName,
        closing_date: d.closingDate, updated_at: now.toISOString(),
      };
    });

    const { error: dealsErr } = await supabase.from('deals').upsert(dealRows, { onConflict: 'deal_id' });
    if (dealsErr) throw dealsErr;

    // ---- MRR / NRR snapshots ----
    const mrrRows = universe.filter(d => d.mrrInr !== 0).map(d => ({
      deal_id: d.id, snapshot_date: snapshotDate, mrr_amount: d.mrrInr, probability: d.probability,
    }));
    const { error: mrrErr } = await supabase.from('mrr_snapshots')
      .upsert(mrrRows, { onConflict: 'deal_id,snapshot_date' });
    if (mrrErr) throw mrrErr;

    const nrrRows = universe.filter(d => d.nrrInr !== 0).map(d => ({
      deal_id: d.id, snapshot_date: snapshotDate, nrr_amount: d.nrrInr, probability: d.probability,
    }));
    const { error: nrrErr } = await supabase.from('nrr_snapshots')
      .upsert(nrrRows, { onConflict: 'deal_id,snapshot_date' });
    if (nrrErr) throw nrrErr;

    // Fetch existing BU values for hunting deals — used as fallback if BU lookup still fails
    const huntingIds = huntingRaw.map(d => String(d.id));
    const { data: existingHuntingData } = huntingIds.length > 0
      ? await supabase.from('hunting_pipeline').select('deal_id, business_unit').in('deal_id', huntingIds)
      : { data: [] };
    const existingHuntingBU = new Map(
      (existingHuntingData ?? []).map((r: any) => [r.deal_id, r.business_unit as string | null])
    );

    const huntingRows = huntingRaw.map(d => {
      const currency = d.Currency as string;
      const rate     = CURRENCY_RATES[currency] ?? 1;
      const mrr      = d.MRR_Amount ?? 0;
      const nrr      = d.NRR_Amount ?? 0;
      let accountName = extractName(d.Account_Name);
      if (!accountName && d.Account_Name?.id) {
        accountName = accountNameMap.get(String(d.Account_Name.id)) ?? '';
      }
      const { bu } = resolveBU(d.Deal_Name ?? '', tagsByDeal.get(String(d.id)));
      // Preserve existing non-UNMAPPED BU as fallback when lookup still fails
      const existingBU = existingHuntingBU.get(String(d.id));
      const finalBU = (bu && bu !== 'UNMAPPED') ? bu
        : (existingBU && existingBU !== 'UNMAPPED') ? existingBU
        : 'UNMAPPED';
      return {
        deal_id:       String(d.id),
        deal_name:     d.Deal_Name ?? '',
        stage:         typeof d.Stage === 'string' ? d.Stage : extractName(d.Stage),
        closing_date:  d.Closing_Date ?? null,
        deal_owner:    extractName(d.Owner),
        account_name:  accountName,
        probability:   d.Probability ?? 0,
        mrr_amount:    mrr,
        nrr_amount:    nrr,
        mrr_inr:       mrr === 0 ? 0 : Math.round(mrr * rate * 100) / 100,
        nrr_inr:       nrr === 0 ? 0 : Math.round(nrr * rate * 100) / 100,
        currency:      currency || 'INR',
        quarter:       targetQuarter,
        business_unit: finalBU,
        updated_at:    now.toISOString(),
      };
    });

    const { error: huntingErr } = await supabase.from('hunting_pipeline')
      .upsert(huntingRows, { onConflict: 'deal_id' });
    if (huntingErr) throw huntingErr;

    // Backfill business_unit from deals table for any hunting deals already tracked there.
    // This covers the case where BU_Deal_Map lookup returns nothing for hunting deals.
    await supabase.rpc('backfill_hunting_bu');

    // ---- Summary stats ----
    const dealsWithBU = dealRows.filter(r => r.business_unit && r.business_unit !== 'UNMAPPED').length;
    const huntingWithBU = huntingRows.filter(r => r.business_unit && r.business_unit !== 'UNMAPPED').length;
    const huntingTagsResolved = huntingIds.filter(id => tagsByDeal.has(id)).length;
    console.log(`Done: ${dealRows.length} deals, ${dealsWithBU} with BU, hunting=${huntingRows.length} (${huntingWithBU} with BU, ${huntingTagsResolved} tags resolved), bu_name_missing=${buNameMissing}`);

    return new Response(
      JSON.stringify({
        ok: true, snapshot_date: snapshotDate, target_quarter: targetQuarter,
        deals_upserted: dealRows.length,
        deals_with_bu: dealsWithBU,
        bu_name_missing: buNameMissing,
        mrr_rows: mrrRows.length, nrr_rows: nrrRows.length,
        hunting_upserted: huntingRows.length,
        hunting_with_bu: huntingWithBU,
        hunting_tags_resolved: huntingTagsResolved,
        flagged: flagged.length, flagged_deals: flagged,
        _debug_bu: debugBU,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err: any) {
    console.error(err);
    return new Response(
      JSON.stringify({ ok: false, error: err.message ?? String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
