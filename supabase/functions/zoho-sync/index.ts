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

async function coql(token: string, query: string): Promise<any[]> {
  const res = await fetch(`${ZOHO_API_DOMAIN}/crm/v6/coql`, {
    method: 'POST',
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ select_query: query }),
  });
  const body = await res.json();
  if (body.status === 'error') throw new Error(`COQL error: ${JSON.stringify(body)}`);
  return body.data ?? [];
}

function monthBounds(yyyyMm: string) {
  const [y, m] = yyyyMm.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end   = new Date(Date.UTC(y, m, 0));
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const dayBefore = new Date(start);
  dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
  return { closingDateGT: fmt(dayBefore), closingDateLTE: fmt(end) };
}

async function fetchUniverseDeals(token: string, targetMonth: string) {
  const { closingDateGT, closingDateLTE } = monthBounds(targetMonth);
  const rows: any[] = [];
  let offset = 0;
  const pageSize = 200;
  for (;;) {
    const query =
      `select id, Deal_Name, Closing_Date, Probability, MRR_Amount, NRR_Amount, Currency, ` +
      `Deal_Type_New_or_Existing, Account_Name from Deals where ` +
      `(Closing_Date > '${closingDateGT}' and Closing_Date <= '${closingDateLTE}') ` +
      `and Probability >= 70 limit ${offset},${pageSize}`;
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

// Discover which Zoho module the Business_Unit lookup field points to.
async function discoverBUModule(token: string): Promise<{ moduleName: string | null; primaryField: string | null; debugFields: any[] }> {
  try {
    const res = await fetch(`${ZOHO_API_DOMAIN}/crm/v6/BU_Deal_Map/fields`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });
    const data = await res.json();
    const fields: any[] = data.fields ?? [];
    const debugFields = fields.slice(0, 5).map((f: any) => ({
      api_name: f.api_name,
      data_type: f.data_type,
      lookup: f.lookup,
    }));
    for (const f of fields) {
      if (f.api_name === 'Business_Unit') {
        const moduleName = f.lookup?.module?.api_name ?? null;
        const primaryField = f.lookup?.field?.api_name ?? 'Name';
        return { moduleName, primaryField, debugFields };
      }
    }
    return { moduleName: null, primaryField: null, debugFields };
  } catch (e: any) {
    return { moduleName: null, primaryField: null, debugFields: [{ error: e.message }] };
  }
}

// Fetch BU names from the discovered module by ID list using COQL.
async function fetchBUNamesByIds(
  token: string,
  moduleName: string,
  primaryField: string,
  buIds: string[],
): Promise<Map<string, string>> {
  const nameById = new Map<string, string>();
  const batchSize = 50;
  for (let i = 0; i < buIds.length; i += batchSize) {
    const batch = buIds.slice(i, i + batchSize).map(id => `'${id}'`).join(',');
    try {
      const rows = await coql(token, `select id, ${primaryField} from ${moduleName} where id in (${batch})`);
      for (const row of rows) {
        const name = row[primaryField];
        if (row.id && name) nameById.set(String(row.id), String(name));
      }
      continue;
    } catch { /* fall through to Name */ }
    if (primaryField !== 'Name') {
      try {
        const rows = await coql(token, `select id, Name from ${moduleName} where id in (${batch})`);
        for (const row of rows) {
          if (row.id && row.Name) nameById.set(String(row.id), String(row.Name));
        }
      } catch { /* ignore */ }
    }
  }
  return nameById;
}

async function fetchBUTags(token: string, dealIds: string[]): Promise<{
  tagsByDeal: Map<string, string[]>;
  buNameMissing: number;
  debugBUSample: any[];
  debugBUModule: string | null;
  debugBUModuleFields: any[];
  debugBUResolved: number;
  debugBUIdCount: number;
}> {
  const tagsByDeal = new Map<string, string[]>();
  const debugBUSample: any[] = [];
  let buNameMissing = 0;

  // Phase 1: fetch all BU_Deal_Map rows and collect raw data
  type RawRow = { dealId: string; buId: string | null; buText: string | null };
  const rawRows: RawRow[] = [];

  const batchSize = 50;
  for (let i = 0; i < dealIds.length; i += batchSize) {
    const batch = dealIds.slice(i, i + batchSize).map(id => `'${id}'`).join(',');
    let offset = 0;
    const pageSize = 200;
    for (;;) {
      const rows = await coql(token,
        `select Deal, Business_Unit from BU_Deal_Map where Deal in (${batch}) limit ${offset},${pageSize}`);

      if (debugBUSample.length < 5) {
        for (const r of rows) {
          if (debugBUSample.length >= 5) break;
          debugBUSample.push({
            dealId: String(r.Deal?.id ?? r.Deal),
            Business_Unit: r.Business_Unit,
            Business_Unit_typeof: typeof r.Business_Unit,
            Business_Unit_keys: r.Business_Unit && typeof r.Business_Unit === 'object'
              ? Object.keys(r.Business_Unit)
              : null,
          });
        }
      }

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

  // Phase 2: resolve BU IDs -> names via the BU module
  const buIdSet = new Set(rawRows.filter(r => r.buId).map(r => r.buId!));
  let buNameById = new Map<string, string>();
  let debugBUModule: string | null = null;
  let debugBUModuleFields: any[] = [];

  if (buIdSet.size > 0) {
    const { moduleName, primaryField, debugFields } = await discoverBUModule(token);
    debugBUModule = moduleName;
    debugBUModuleFields = debugFields;
    console.log(`BU module discovered: ${moduleName}, primaryField: ${primaryField}, unique BU IDs: ${buIdSet.size}`);
    if (moduleName && primaryField) {
      buNameById = await fetchBUNamesByIds(token, moduleName, primaryField, [...buIdSet]);
      console.log(`BU names resolved: ${buNameById.size}/${buIdSet.size}`);
    }
  }

  // Phase 3: build tagsByDeal
  for (const { dealId, buId, buText } of rawRows) {
    const buName = buText ?? (buId ? buNameById.get(buId) ?? '' : '');
    if (!buName) { buNameMissing++; continue; }
    if (!tagsByDeal.has(dealId)) tagsByDeal.set(dealId, []);
    tagsByDeal.get(dealId)!.push(buName);
  }

  return {
    tagsByDeal,
    buNameMissing,
    debugBUSample,
    debugBUModule,
    debugBUModuleFields,
    debugBUResolved: buNameById.size,
    debugBUIdCount:  buIdSet.size,
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
    const targetMonth: string = reqBody.target_month ??
      `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const snapshotDate: string = reqBody.snapshot_date ?? now.toISOString().slice(0, 10);

    console.log(`Syncing month=${targetMonth} snapshot=${snapshotDate}`);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const token = await getAccessToken();
    const dealsRaw = await fetchUniverseDeals(token, targetMonth);
    console.log(`Zoho raw deals: ${dealsRaw.length}`);

    const accountIdsToLookup = new Set<string>();
    for (const d of dealsRaw) {
      if (!extractName(d.Account_Name) && d.Account_Name?.id) {
        accountIdsToLookup.add(String(d.Account_Name.id));
      }
    }
    let accountNameMap = new Map<string, string>();
    if (accountIdsToLookup.size > 0) {
      console.log(`Looking up ${accountIdsToLookup.size} account names from Accounts module`);
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
        id:          String(d.id),
        name:        d.Deal_Name,
        dealType:    d.Deal_Type_New_or_Existing,
        accountName,
        mrrInr:      mrr === 0 ? 0 : Math.round(mrr * rate * 100) / 100,
        nrrInr:      nrr === 0 ? 0 : Math.round(nrr * rate * 100) / 100,
        probability: d.Probability,
        closingDate: d.Closing_Date,
      });
    }
    console.log(`Universe: ${universe.length}`);

    const {
      tagsByDeal, buNameMissing,
      debugBUSample, debugBUModule, debugBUModuleFields,
      debugBUResolved, debugBUIdCount,
    } = await fetchBUTags(token, universe.map(d => d.id));

    const flagged: any[] = [];
    for (const d of universe) {
      const { bu, flagged: isFlagged } = resolveBU(d.name, tagsByDeal.get(d.id));
      d.businessUnit = bu;
      if (isFlagged) flagged.push({ id: d.id, name: d.name, tags: tagsByDeal.get(d.id) });
    }

    const dealIds = universe.map(d => d.id);
    const { data: existingDeals, error: fetchErr } = await supabase
      .from('deals')
      .select('deal_id, current_name, name_history, business_unit')
      .in('deal_id', dealIds);
    if (fetchErr) throw fetchErr;
    const existingByDeal = new Map((existingDeals ?? []).map((r: any) => [r.deal_id, r]));

    const dealRows = universe.map(d => {
      const existing = existingByDeal.get(d.id);
      const nameHistory  = existing?.name_history ?? [];
      const renamed      = existing && existing.current_name !== d.name;
      const businessUnit = d.businessUnit === null && existing ? existing.business_unit : d.businessUnit;
      return {
        deal_id:       d.id,
        deal_type:     d.dealType,
        current_name:  d.name,
        name_history:  renamed ? [...nameHistory, existing.current_name] : nameHistory,
        business_unit: businessUnit,
        account_name:  d.accountName,
        closing_date:  d.closingDate,
        updated_at:    new Date().toISOString(),
      };
    });

    const { error: dealsErr } = await supabase.from('deals').upsert(dealRows, { onConflict: 'deal_id' });
    if (dealsErr) throw dealsErr;

    const mrrRows = universe.filter(d => d.mrrInr !== 0).map(d => ({
      deal_id:       d.id,
      snapshot_date: snapshotDate,
      mrr_amount:    d.mrrInr,
      probability:   d.probability,
    }));
    const { error: mrrErr } = await supabase.from('mrr_snapshots')
      .upsert(mrrRows, { onConflict: 'deal_id,snapshot_date' });
    if (mrrErr) throw mrrErr;

    const nrrRows = universe.filter(d => d.nrrInr !== 0).map(d => ({
      deal_id:       d.id,
      snapshot_date: snapshotDate,
      nrr_amount:    d.nrrInr,
      probability:   d.probability,
    }));
    const { error: nrrErr } = await supabase.from('nrr_snapshots')
      .upsert(nrrRows, { onConflict: 'deal_id,snapshot_date' });
    if (nrrErr) throw nrrErr;

    const dealsWithAccount = dealRows.filter(r => r.account_name).length;
    const dealsWithBU = dealRows.filter(r => r.business_unit && r.business_unit !== 'UNMAPPED').length;
    console.log(`Done: ${dealRows.length} deals (${dealsWithAccount} with account, ${dealsWithBU} with BU), bu_name_missing=${buNameMissing}`);

    return new Response(
      JSON.stringify({
        ok: true,
        snapshot_date:           snapshotDate,
        target_month:            targetMonth,
        deals_upserted:          dealRows.length,
        deals_with_account:      dealsWithAccount,
        deals_with_bu:           dealsWithBU,
        bu_name_missing:         buNameMissing,
        mrr_rows:                mrrRows.length,
        nrr_rows:                nrrRows.length,
        flagged:                 flagged.length,
        flagged_deals:           flagged,
        _debug_bu_sample:        debugBUSample,
        _debug_bu_module:        debugBUModule,
        _debug_bu_module_fields: debugBUModuleFields,
        _debug_bu_id_count:      debugBUIdCount,
        _debug_bu_resolved:      debugBUResolved,
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
