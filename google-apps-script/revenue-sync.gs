// Revenue Sync — pushes CMRR (MRR) and NRR Consolidated data to Supabase.
// Setup: paste your SHEETS_SYNC_API_KEY in the SUPABASE_API_KEY constant below,
// then reload the sheet to see the "Revenue Sync" menu.

var SUPABASE_ENDPOINT = 'https://qnulyenilttpalbkmpvm.supabase.co/functions/v1/sheets-sync';
var SUPABASE_API_KEY  = 'YOUR_SHEETS_SYNC_API_KEY'; // ← replace with your key

// ─── Menu ────────────────────────────────────────────────────────────────────

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Revenue Sync')
    .addItem('Push MRR + NRR to Supabase', 'syncRevenue')
    .addToUi();
}

// ─── Main entry point ────────────────────────────────────────────────────────

function syncRevenue() {
  var ui = SpreadsheetApp.getUi();
  try {
    var rows = [];
    rows = rows.concat(readCmrrRows());
    rows = rows.concat(readNrrRows());

    var invoiceRows = readNrrInvoiceRows();

    if (rows.length === 0 && invoiceRows.length === 0) {
      ui.alert('Revenue Sync', 'No data rows found — nothing pushed.', ui.ButtonSet.OK);
      return;
    }

    var result = pushToSupabase(rows, invoiceRows);
    ui.alert('Revenue Sync ✓',
      'Successfully pushed ' + result.rows_upserted + ' revenue rows and ' +
      result.invoice_rows_upserted + ' invoice rows to Supabase.',
      ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Revenue Sync — Error', String(e), ui.ButtonSet.OK);
  }
}

// ─── CMRR sheet reader ───────────────────────────────────────────────────────
// Row 3 = header. Col B (idx 1) = Regrouped Nomenclature, Col D (idx 3) = Customer Name.
// Cols AD–AP (idx 29–41) = MRR months. Col AS (idx 44) = BU.

function readCmrrRows() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('CMRR');
  if (!sheet) throw new Error('Sheet "CMRR" not found');

  var range = sheet.getDataRange();
  var data = range.getValues();
  var headerRow = range.getDisplayValues()[2]; // display text avoids Date timezone issues

  // Discover month positions from header row (cols AD–AP = indices 29–41)
  var mrrMonths = [];
  for (var c = 29; c <= 41; c++) {
    var hdr = headerRow[c];
    if (!hdr) continue;
    var monthStr = formatMonthHeader(hdr);
    if (monthStr) mrrMonths.push({ col: c, month: monthStr });
  }

  var byKey = {}; // key = account_name|business_unit|month

  for (var r = 3; r < data.length; r++) { // row 4+ (0-indexed = 3+)
    var row = data[r];
    // Skip subtotal/group/blank rows — only process rows with a numeric row-counter in col A
    if (toNumber(row[0]) <= 0) continue;
    // Use col D (Customer Name) as primary; fall back to col B (Regrouped Nomenclature)
    var accountName = trim(row[3]) || trim(row[1]);
    var bu          = trim(row[44]); // col AS = BU2
    if (!accountName || !bu) continue;

    for (var m = 0; m < mrrMonths.length; m++) {
      var amt = toNumber(row[mrrMonths[m].col]);
      if (amt === 0) continue;
      var key = accountName + '|' + bu + '|' + mrrMonths[m].month;
      if (!byKey[key]) {
        byKey[key] = { account_name: accountName, business_unit: bu, month: mrrMonths[m].month, mrr_amount: 0, nrr_amount: null };
      }
      byKey[key].mrr_amount += amt;
    }
  }

  return Object.values(byKey);
}

// ─── NRR Consolidated sheet reader ──────────────────────────────────────────
// Row 3 = header. Col F (idx 5) = Customer Name, Cols P–AA (idx 15–26) = NRR months.
// Col AT (idx 45) = BU. Multiple rows per account — sum them.

function readNrrRows() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('NRR Consolidated');
  if (!sheet) throw new Error('Sheet "NRR Consolidated" not found');

  var range = sheet.getDataRange();
  var data = range.getValues();
  var headerRow = range.getDisplayValues()[2]; // display text avoids Date timezone issues

  var nrrMonths = [];
  for (var c = 15; c <= 26; c++) {
    var hdr = headerRow[c];
    if (!hdr) continue;
    var monthStr = formatMonthHeader(hdr);
    if (monthStr) nrrMonths.push({ col: c, month: monthStr });
  }

  var byKey = {};
  for (var r = 3; r < data.length; r++) {
    var row = data[r];
    var accountName = trim(row[5]);
    var bu          = trim(row[45]); // col AT = BU2
    if (!accountName || !bu) continue;

    for (var m = 0; m < nrrMonths.length; m++) {
      var amt = toNumber(row[nrrMonths[m].col]);
      if (amt === 0) continue;
      var key = accountName + '|' + bu + '|' + nrrMonths[m].month;
      if (!byKey[key]) {
        byKey[key] = { account_name: accountName, business_unit: bu, month: nrrMonths[m].month, mrr_amount: null, nrr_amount: 0 };
      }
      byKey[key].nrr_amount += amt;
    }
  }

  return Object.values(byKey).filter(function(r) { return r.nrr_amount !== 0; });
}

// ─── NRR Invoice detail reader ───────────────────────────────────────────────
// Reads individual rows from NRR Consolidated to capture invoice-level detail.
// Col E (idx 4) = Inv No., Col F (idx 5) = Customer Name, Col H (idx 7) = Memo,
// Col K (idx 10) = Revenue Type, Col AT (idx 45) = BU, Cols P–AA (idx 15–26) = months.
// One row is emitted per invoice × month combination (where amount ≠ 0).

function readNrrInvoiceRows() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('NRR Consolidated');
  if (!sheet) throw new Error('Sheet "NRR Consolidated" not found');

  var range = sheet.getDataRange();
  var data = range.getValues();
  var headerRow = range.getDisplayValues()[2];

  var nrrMonths = [];
  for (var c = 15; c <= 26; c++) {
    var hdr = headerRow[c];
    if (!hdr) continue;
    var monthStr = formatMonthHeader(hdr);
    if (monthStr) nrrMonths.push({ col: c, month: monthStr });
  }

  var rows = [];
  for (var r = 3; r < data.length; r++) {
    var row = data[r];
    var accountName = trim(row[5]);  // col F = Customer Name
    var bu          = trim(row[45]); // col AT = BU2
    var invNo       = trim(row[4]);  // col E = Inv No.
    if (!accountName || !bu || !invNo) continue;

    var memo        = trim(row[7]);  // col H
    var revenueType = trim(row[10]); // col K

    for (var m = 0; m < nrrMonths.length; m++) {
      var amt = toNumber(row[nrrMonths[m].col]);
      if (amt === 0) continue;
      rows.push({
        account_name:  accountName,
        business_unit: bu,
        month:         nrrMonths[m].month,
        inv_no:        invNo,
        memo:          memo || null,
        revenue_type:  revenueType || null,
        amount:        amt,
      });
    }
  }

  return rows;
}

// ─── Push to Supabase ────────────────────────────────────────────────────────

function pushToSupabase(rows, invoiceRows) {
  // De-duplicate: cmrrRows + nrrRows may overlap; merge by key
  var merged = {};
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var key = r.account_name + '|' + r.business_unit + '|' + r.month;
    if (!merged[key]) {
      merged[key] = { account_name: r.account_name, business_unit: r.business_unit, month: r.month, mrr_amount: null, nrr_amount: null };
    }
    if (r.mrr_amount !== null && r.mrr_amount !== 0) merged[key].mrr_amount = (merged[key].mrr_amount || 0) + r.mrr_amount;
    if (r.nrr_amount !== null && r.nrr_amount !== 0) merged[key].nrr_amount = (merged[key].nrr_amount || 0) + r.nrr_amount;
  }

  var finalRows = Object.values(merged);

  // Send ALL revenue rows in a single request so the edge function's
  // delete-then-insert covers every row in one atomic operation.
  // UrlFetchApp handles payloads up to 10 MB; ~1000 rows ≈ 150 KB, well within limits.
  var totalUpserted = 0;
  if (finalRows.length > 0) {
    var resp = UrlFetchApp.fetch(SUPABASE_ENDPOINT, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'Authorization': 'Bearer ' + SUPABASE_API_KEY },
      payload: JSON.stringify({ rows: finalRows }),
      muteHttpExceptions: true,
    });
    var code = resp.getResponseCode();
    var body = JSON.parse(resp.getContentText());
    if (code !== 200 || !body.ok) {
      throw new Error('Supabase error (HTTP ' + code + '): ' + (body.error || resp.getContentText()));
    }
    totalUpserted = body.rows_upserted;
  }

  // Push invoice rows in batches of 500
  var totalInvoiceUpserted = 0;
  for (var istart = 0; istart < invoiceRows.length; istart += BATCH) {
    var ibatch = invoiceRows.slice(istart, istart + BATCH);
    var iresp = UrlFetchApp.fetch(SUPABASE_ENDPOINT, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'Authorization': 'Bearer ' + SUPABASE_API_KEY },
      payload: JSON.stringify({ rows: [], invoice_rows: ibatch }),
      muteHttpExceptions: true,
    });
    var icode = iresp.getResponseCode();
    var ibody = JSON.parse(iresp.getContentText());
    if (icode !== 200 || !ibody.ok) {
      throw new Error('Supabase invoice error (HTTP ' + icode + '): ' + (ibody.error || iresp.getContentText()));
    }
    totalInvoiceUpserted += ibody.invoice_rows_upserted;
  }

  return { rows_upserted: totalUpserted, invoice_rows_upserted: totalInvoiceUpserted };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function trim(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return 0;
  var n = Number(v);
  return isNaN(n) ? 0 : n;
}

// Convert a header string like "Mar-2026", "Mar-26", "March 2026" to "YYYY-MM-01"
function formatMonthHeader(hdr) {
  if (!hdr) return null;

  var s = String(hdr).trim();

  // "YYYY-MM" or "YYYY-MM-DD"
  var ymMatch = s.match(/^(\d{4})-(\d{2})(-\d{2})?$/);
  if (ymMatch) return ymMatch[1] + '-' + ymMatch[2] + '-01';

  // "MMM-YYYY" e.g. "Mar-2026"  ← primary format in CMRR sheet
  var myyyyhyphen = s.match(/^([A-Za-z]{3,})-(\d{4})$/);
  if (myyyyhyphen) {
    var mo4 = monthIndex(myyyyhyphen[1]);
    if (mo4 > 0) return myyyyhyphen[2] + '-' + String(mo4).padStart(2, '0') + '-01';
  }

  // "MMM-YY" e.g. "Mar-26"
  var myyMatch = s.match(/^([A-Za-z]{3})-(\d{2})$/);
  if (myyMatch) {
    var mo2 = monthIndex(myyMatch[1]);
    if (mo2 > 0) {
      var yr = parseInt(myyMatch[2], 10);
      yr = yr < 50 ? 2000 + yr : 1900 + yr;
      return yr + '-' + String(mo2).padStart(2, '0') + '-01';
    }
  }

  // "MMM YYYY" or "MMMM YYYY" e.g. "March 2026"
  var myyyyMatch = s.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (myyyyMatch) {
    var mo3 = monthIndex(myyyyMatch[1]);
    if (mo3 > 0) return myyyyMatch[2] + '-' + String(mo3).padStart(2, '0') + '-01';
  }

  return null;
}

var MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
function monthIndex(abbr) {
  return MONTHS[abbr.toLowerCase().slice(0, 3)] || 0;
}

// ─── Debug helper — run once to see what CMRR header cells actually contain ──
// Run this from Apps Script editor: Extensions → Apps Script → debugCmrrHeaders → Run

function debugCmrrHeaders() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('CMRR');
  if (!sheet) { SpreadsheetApp.getUi().alert('Sheet "CMRR" not found'); return; }
  var range = sheet.getDataRange();
  var displayRow = range.getDisplayValues()[2];
  var valueRow   = range.getValues()[2];
  var msg = 'CMRR row-3 headers, cols AD–AP (indices 29–41):\n\n';
  for (var c = 29; c <= 41; c++) {
    msg += 'Col ' + c + ': display=[' + displayRow[c] + ']  raw=[' + valueRow[c] + ']\n';
  }
  SpreadsheetApp.getUi().alert('CMRR Header Debug', msg, SpreadsheetApp.getUi().ButtonSet.OK);
}

function debugNrrHeaders() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('NRR Consolidated');
  if (!sheet) { SpreadsheetApp.getUi().alert('Sheet "NRR Consolidated" not found'); return; }
  var range = sheet.getDataRange();
  var displayRow = range.getDisplayValues()[2];
  var valueRow   = range.getValues()[2];
  var msg = 'NRR Consolidated row-3 headers, cols P–AA (indices 15–26):\n\n';
  for (var c = 15; c <= 26; c++) {
    msg += 'Col ' + c + ': display=[' + displayRow[c] + ']  raw=[' + valueRow[c] + ']\n';
  }
  SpreadsheetApp.getUi().alert('NRR Header Debug', msg, SpreadsheetApp.getUi().ButtonSet.OK);
}
