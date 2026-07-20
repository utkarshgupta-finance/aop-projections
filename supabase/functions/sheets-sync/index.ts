import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Simple bearer-token auth — set SHEETS_SYNC_API_KEY in Supabase secrets.
// Google Apps Script sends: Authorization: Bearer <key>
const SHEETS_SYNC_API_KEY = Deno.env.get('SHEETS_SYNC_API_KEY') ?? '';

interface RevenueRow {
  account_name:  string;
  business_unit: string;
  month:         string;  // YYYY-MM-DD (first of month) or YYYY-MM
  mrr_amount?:   number | null;
  nrr_amount?:   number | null;
  currency?:     string;
  notes?:        string;
}

interface InvoiceRow {
  account_name:  string;
  business_unit: string;
  month:         string;
  inv_no:        string;
  memo?:         string | null;
  revenue_type?: string | null;
  amount?:       number | null;
}

function normaliseMonth(raw: string): string {
  // Accept "2026-07", "2026-07-01", "Jul 2026", "July 2026"
  const ym = raw.trim();
  if (/^\d{4}-\d{2}$/.test(ym)) return `${ym}-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(ym)) return ym.slice(0, 7) + '-01';
  // Try to parse "Jul 2026" / "July 2026"
  const parsed = new Date(`1 ${ym}`);
  if (!isNaN(parsed.getTime())) {
    const y = parsed.getFullYear();
    const m = String(parsed.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}-01`;
  }
  throw new Error(`Cannot parse month: ${JSON.stringify(raw)}`);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Auth check
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!SHEETS_SYNC_API_KEY || token !== SHEETS_SYNC_API_KEY) {
    return new Response(
      JSON.stringify({ ok: false, error: 'Unauthorized' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  try {
    const body = await req.json();
    const rawRows: RevenueRow[] = body.rows;
    const rawInvoiceRows: InvoiceRow[] = body.invoice_rows ?? [];

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    let revenueUpserted = 0;

    // ── Revenue actuals ──────────────────────────────────────────────────────
    if (Array.isArray(rawRows) && rawRows.length > 0) {
      const rows = rawRows.map((r, i) => {
        if (!r.account_name) throw new Error(`Row ${i}: missing account_name`);
        if (!r.business_unit) throw new Error(`Row ${i}: missing business_unit`);
        if (!r.month) throw new Error(`Row ${i}: missing month`);
        return {
          account_name:  String(r.account_name).trim(),
          business_unit: String(r.business_unit).trim(),
          month:         normaliseMonth(String(r.month)),
          mrr_amount:    r.mrr_amount ?? null,
          nrr_amount:    r.nrr_amount ?? null,
          currency:      r.currency ?? 'INR',
          notes:         r.notes ?? null,
          updated_at:    new Date().toISOString(),
        };
      });

      const { error } = await supabase
        .from('revenue_actuals')
        .upsert(rows, { onConflict: 'account_name,business_unit,month' });

      if (error) throw error;
      revenueUpserted = rows.length;
      console.log(`sheets-sync: upserted ${rows.length} revenue rows`);
    }

    // ── NRR invoice details ──────────────────────────────────────────────────
    let invoiceUpserted = 0;

    if (rawInvoiceRows.length > 0) {
      const invoiceRows = rawInvoiceRows.map((r, i) => {
        if (!r.account_name) throw new Error(`Invoice row ${i}: missing account_name`);
        if (!r.business_unit) throw new Error(`Invoice row ${i}: missing business_unit`);
        if (!r.month) throw new Error(`Invoice row ${i}: missing month`);
        if (!r.inv_no) throw new Error(`Invoice row ${i}: missing inv_no`);
        return {
          account_name:  String(r.account_name).trim(),
          business_unit: String(r.business_unit).trim(),
          month:         normaliseMonth(String(r.month)),
          inv_no:        String(r.inv_no).trim(),
          memo:          r.memo ? String(r.memo).trim() : null,
          revenue_type:  r.revenue_type ? String(r.revenue_type).trim() : null,
          amount:        r.amount ?? null,
          updated_at:    new Date().toISOString(),
        };
      });

      const { error } = await supabase
        .from('nrr_invoice_details')
        .upsert(invoiceRows, { onConflict: 'account_name,business_unit,inv_no,month' });

      if (error) throw error;
      invoiceUpserted = invoiceRows.length;
      console.log(`sheets-sync: upserted ${invoiceRows.length} invoice rows`);
    }

    return new Response(
      JSON.stringify({ ok: true, rows_upserted: revenueUpserted, invoice_rows_upserted: invoiceUpserted }),
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
