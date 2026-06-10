// =============================================================================
// final_dashboard_script.gs
// Superstore Global Sales Executive Dashboard — Google Apps Script
//
// Architecture:
//   BigQuery views → Connected DataSource sheets → Apps Script (this file)
//   → helper tables (DASHBOARD col N) → embedded charts + KPI cards
//
// Key design decisions:
//   1. REF_YEAR / REF_CAT / REF_MKT / REF_SHIP: hardcoded marginal totals
//      derived from BigQuery exports. DataSource sheets do not support
//      getDataRange().getValues() and have no reliable row-count API.
//   2. Year filtering is EXACT (iterates REF_YEAR directly).
//      Category & Market filtering uses PROPORTIONAL SCALING (revenue fraction).
//      Each buildHT* function documents its own strategy in a comment.
//   3. Helper tables in DASHBOARD column N provide static range bindings
//      for embedded charts, which cannot bind to dynamic formula outputs.
//   4. Installable onEdit trigger (not simple onEdit) provides full OAuth
//      permissions for cross-sheet reads and batch writes.
//
// See docs/architecture_decisions.md for full rationale on each decision.
// See docs/technical_implementation.md for filtering strategy details.
//
// Setup (one-time):
//   1. Extensions → Apps Script → replace Code.gs → Save (Ctrl+S)
//   2. Run setupDashboard() from the function dropdown
//   3. Run installTrigger() to register the onEdit trigger
//   4. Grant OAuth permissions when prompted
// =============================================================================


// =============================================================================
// CONFIGURATION — all sheet names, cell addresses, and layout constants
// =============================================================================

var CFG = {
  CTRL_SHEET:     'Controls',
  DASH_SHEET:     'DASHBOARD',

  // Controls sheet filter cells
  YEAR_CELL:      'B2',
  CAT_CELL:       'B4',
  MKT_CELL:       'B6',

  // DASHBOARD inline filter cells
  DASH_YEAR_CELL: 'B6',
  DASH_CAT_CELL:  'B14',
  DASH_MKT_CELL:  'B20',

  // KPI card cells
  KPI_REV_CELL:   'C6',
  KPI_PRO_CELL:   'E6',
  KPI_MAR_CELL:   'G6',
  KPI_ORD_CELL:   'I6',
  KPI_REV_YOY:    'C7',
  KPI_PRO_YOY:    'E7',
  KPI_MAR_YOY:    'G7',
  KPI_ORD_YOY:    'I7',

  // Dimension members
  ALL_YEARS: ['2022', '2023', '2024', '2025', '2026'],
  ALL_CATS:  ['Technology', 'Furniture', 'Office Supplies'],
  ALL_MKTS:  ['APAC', 'EU', 'US', 'LATAM', 'Africa'],
  ALL_SHIPS: ['Standard Class', 'Second Class', 'First Class', 'Same Day'],

  // Helper table layout — column N = column 14
  // Each range includes one header row followed by data rows.
  HT_COL:      14,   // column N
  HT1_ROW:     2,    // HT1: N2:P7   — annual revenue/profit (header + 5 year rows)
  HT2_ROW:     10,   // HT2: N10:O13 — category revenue      (header + 3 cat rows)
  HT3_ROW:     16,   // HT3: N16:O21 — market revenue        (header + 5 mkt rows)
  HT4_ROW:     24,   // HT4: N24:O28 — ship mode revenue     (header + 4 mode rows)
  HT_PERF_ROW: 31    // Perf: N31:T37 — performance matrix   (header + 5 year rows + total)
};


// =============================================================================
// REFERENCE DATA — marginal totals derived from BigQuery full exports.
//
// IMPORTANT: These are marginal totals — each constant is aggregated over ALL
// values of the other dimensions. There is no cross-dimensional index.
// Example: REF_YEAR['2025'].rev is total revenue for 2025 across ALL categories
// and ALL markets. REF_CAT['Technology'].rev is Technology revenue across ALL
// years and ALL markets.
//
// This design is the foundation of the proportional scaling approach used for
// category and market filtering. See architecture_decisions.md Decision 2 & 4.
// =============================================================================

// Annual totals — all categories, all markets
var REF_YEAR = {
  '2022': { rev: 1835390, pro: 200534, ord: 3632, cust: 794 },
  '2023': { rev: 2355771, pro: 278767, ord: 4732, cust: 793 },
  '2024': { rev: 2920093, pro: 332761, ord: 5769, cust: 795 },
  '2025': { rev: 3300517, pro: 387734, ord: 6870, cust: 795 },
  '2026': { rev: 2231134, pro: 267663, ord: 4462, cust: 792 }
};

// Category totals — all years, all markets
var REF_CAT = {
  'Technology':      { rev: 4027120, pro: 512123 },
  'Furniture':       { rev: 2945185, pro: 121908 },
  'Office Supplies': { rev: 5670600, pro: 833428 }
};

// Market totals — all years, all categories
var REF_MKT = {
  'APAC':   { rev: 3232946, pro: 379423 },
  'EU':     { rev: 2593983, pro: 305219 },
  'US':     { rev: 2297295, pro: 249891 },
  'LATAM':  { rev: 2163854, pro: 235461 },
  'Africa': { rev:  354827, pro:  39465 }
};

// Ship mode totals — all years, all categories, all markets
// Verify these values against v_rpt_shipping if updating the dataset.
var REF_SHIP = {
  'Standard Class': { rev: 7332885, pro: 879946 },
  'Second Class':   { rev: 2402152, pro: 288258 },
  'First Class':    { rev: 1896436, pro: 208608 },
  'Same Day':       { rev: 1011432, pro: 101143 }
};

// Grand total across all years, categories, and markets
var TOTAL_REV = 12642905;


// =============================================================================
// MENU
// =============================================================================

function onOpen() {
  SpreadsheetApp.getActive().addMenu('Dashboard', [
    { name: 'Refresh Dashboard', functionName: 'runRefresh'     },
    { name: 'Setup Dashboard',   functionName: 'setupDashboard' },
    { name: 'Install Trigger',   functionName: 'installTrigger' }
  ]);
}


// =============================================================================
// TRIGGER ENTRY POINT
// onEdit fires on every cell edit. We only react to changes in filter cells
// on the Controls sheet or the DASHBOARD inline filter cells.
// Syncs the changed value to the other UI location before calling refreshAll.
// =============================================================================

function onEdit(e) {
  if (!e || !e.range) return;

  try {
    var sheetName = e.range.getSheet().getName();
    var cellA1    = e.range.getA1Notation();

    var ctrlFilterCells = [CFG.YEAR_CELL, CFG.CAT_CELL, CFG.MKT_CELL];
    var dashFilterCells = [CFG.DASH_YEAR_CELL, CFG.DASH_CAT_CELL, CFG.DASH_MKT_CELL];

    var isCtrlEdit = (sheetName === CFG.CTRL_SHEET) && (ctrlFilterCells.indexOf(cellA1) > -1);
    var isDashEdit = (sheetName === CFG.DASH_SHEET) && (dashFilterCells.indexOf(cellA1) > -1);

    if (!isCtrlEdit && !isDashEdit) return;

    var ss   = SpreadsheetApp.getActive();
    var ctrl = ss.getSheetByName(CFG.CTRL_SHEET);
    var dash = ss.getSheetByName(CFG.DASH_SHEET);
    var val  = e.range.getValue();

    // Sync the changed value to the other control UI
    if (isCtrlEdit) {
      if (cellA1 === CFG.YEAR_CELL) dash.getRange(CFG.DASH_YEAR_CELL).setValue(val);
      if (cellA1 === CFG.CAT_CELL)  dash.getRange(CFG.DASH_CAT_CELL).setValue(val);
      if (cellA1 === CFG.MKT_CELL)  dash.getRange(CFG.DASH_MKT_CELL).setValue(val);
    } else {
      if (cellA1 === CFG.DASH_YEAR_CELL) ctrl.getRange(CFG.YEAR_CELL).setValue(val);
      if (cellA1 === CFG.DASH_CAT_CELL)  ctrl.getRange(CFG.CAT_CELL).setValue(val);
      if (cellA1 === CFG.DASH_MKT_CELL)  ctrl.getRange(CFG.MKT_CELL).setValue(val);
    }

    refreshAll();

  } catch (err) {
    Logger.log('onEdit error: ' + err.message);
  }
}


// =============================================================================
// FILTER READER
// Reads the Controls sheet (always kept in sync by onEdit) and returns a
// normalised filter object. "All" expands to the full CFG dimension array.
// =============================================================================

function getFilters() {
  var ss   = SpreadsheetApp.getActive();
  var ctrl = ss.getSheetByName(CFG.CTRL_SHEET);

  var yearVal = String(ctrl.getRange(CFG.YEAR_CELL).getValue() || 'All');
  var catVal  = String(ctrl.getRange(CFG.CAT_CELL).getValue()  || 'All');
  var mktVal  = String(ctrl.getRange(CFG.MKT_CELL).getValue()  || 'All');

  var years = (yearVal === 'All' || yearVal === '') ? CFG.ALL_YEARS.slice() : [yearVal];
  var cats  = (catVal  === 'All' || catVal  === '') ? CFG.ALL_CATS.slice()  : [catVal];
  var mkts  = (mktVal  === 'All' || mktVal  === '') ? CFG.ALL_MKTS.slice()  : [mktVal];

  return { years: years, cats: cats, mkts: mkts };
}


// =============================================================================
// SCALE FACTOR HELPERS
// Each returns the fraction of TOTAL_REV that belongs to the selected subset.
// catScale and mktScale are used for proportional filtering (approximate).
// yearScale is used when we need a year-proportional weight for category/market charts.
// =============================================================================

// Filtered by: Category (direct lookup of marginal totals)
function getCatScale(f) {
  var selRev = 0;
  f.cats.forEach(function(c) {
    if (REF_CAT[c]) selRev += REF_CAT[c].rev;
  });
  return selRev / TOTAL_REV;
}

// Filtered by: Market (direct lookup of marginal totals)
function getMktScale(f) {
  var selRev = 0;
  f.mkts.forEach(function(m) {
    if (REF_MKT[m]) selRev += REF_MKT[m].rev;
  });
  return selRev / TOTAL_REV;
}

// Filtered by: Year (direct lookup of marginal totals)
function getYearScale(f) {
  var selRev = 0;
  f.years.forEach(function(y) {
    if (REF_YEAR[y]) selRev += REF_YEAR[y].rev;
  });
  return selRev / TOTAL_REV;
}


// =============================================================================
// HELPER TABLE BUILDERS
// Each returns a 2D array ready for setValues(). The first row is always a
// header row so embedded charts can label their series automatically.
// Filtering strategy is documented per function.
// =============================================================================

// HT1 — Annual revenue and gross profit
// Range: N2:P7 (6 rows × 3 cols: header + 5 year rows)
// Filtered by: Year (direct from REF_YEAR), Category & Market (proportional scale)
function buildHT1(f) {
  var catScale = getCatScale(f);
  var mktScale = getMktScale(f);
  var scale    = catScale * mktScale;

  var data = [['Year', 'Revenue', 'Gross Profit']];

  CFG.ALL_YEARS.forEach(function(y) {
    if (f.years.indexOf(y) > -1) {
      var d = REF_YEAR[y];
      data.push([y, Math.round(d.rev * scale), Math.round(d.pro * scale)]);
    } else {
      data.push(['', '', '']); // pad so range dimensions stay fixed
    }
  });

  return data; // always 6 rows
}

// HT2 — Revenue by product category
// Range: N10:O13 (4 rows × 2 cols: header + 3 category rows)
// Filtered by: Year (yearScale), Market (mktScale). Category shown as dimension.
function buildHT2(f) {
  var yearScale = getYearScale(f);
  var mktScale  = getMktScale(f);
  var scale     = yearScale * mktScale;

  var data = [['Category', 'Revenue']];

  CFG.ALL_CATS.forEach(function(cat) {
    if (REF_CAT[cat]) {
      var rev = Math.round(REF_CAT[cat].rev * scale);
      // Zero out categories not in filter so the chart reflects the active selection
      var inFilter = (f.cats.indexOf(cat) > -1);
      data.push([cat, inFilter ? rev : 0]);
    }
  });

  return data; // always 4 rows
}

// HT3 — Revenue by market
// Range: N16:O21 (6 rows × 2 cols: header + 5 market rows)
// Filtered by: Year (yearScale), Category (catScale). Market shown as dimension.
function buildHT3(f) {
  var yearScale = getYearScale(f);
  var catScale  = getCatScale(f);
  var scale     = yearScale * catScale;

  var data = [['Market', 'Revenue']];

  CFG.ALL_MKTS.forEach(function(mkt) {
    if (REF_MKT[mkt]) {
      var rev = Math.round(REF_MKT[mkt].rev * scale);
      var inFilter = (f.mkts.indexOf(mkt) > -1);
      data.push([mkt, inFilter ? rev : 0]);
    }
  });

  return data; // always 6 rows
}

// HT4 — Revenue by shipping mode
// Range: N24:O28 (5 rows × 2 cols: header + 4 ship mode rows)
// Filtered by: Year × Category × Market (all three scales combined)
function buildHT4(f) {
  var yearScale = getYearScale(f);
  var catScale  = getCatScale(f);
  var mktScale  = getMktScale(f);
  var scale     = yearScale * catScale * mktScale;

  var data = [['Ship Mode', 'Revenue']];

  CFG.ALL_SHIPS.forEach(function(mode) {
    if (REF_SHIP[mode]) {
      data.push([mode, Math.round(REF_SHIP[mode].rev * scale)]);
    }
  });

  return data; // always 5 rows
}

// KPI totals object
// Filtered by: Year (direct), Category & Market (proportional scale)
function buildKPIs(f) {
  var catScale = getCatScale(f);
  var mktScale = getMktScale(f);
  var scale    = catScale * mktScale;

  var totRev = 0, totPro = 0, totOrd = 0, totCust = 0;

  f.years.forEach(function(y) {
    var d = REF_YEAR[y];
    if (!d) return;
    totRev  += d.rev;
    totPro  += d.pro;
    totOrd  += d.ord;
    totCust += d.cust;
  });

  totRev  = Math.round(totRev  * scale);
  totPro  = Math.round(totPro  * scale);
  totOrd  = Math.round(totOrd  * scale);
  // Customer count: scale by catScale × mktScale (approximate)
  totCust = Math.round(totCust * scale);

  var margin = totRev > 0 ? (totPro / totRev) * 100 : 0;

  return { rev: totRev, pro: totPro, margin: margin, ord: totOrd, cust: totCust };
}

// Performance table: one row per year + total
// Range: N31:T37 (7 rows × 7 cols: header + 5 year rows + total row)
// Filtered by: Year (direct), Category & Market (proportional scale)
function buildPerfTable(f) {
  var catScale = getCatScale(f);
  var mktScale = getMktScale(f);
  var scale    = catScale * mktScale;

  var data = [['Year', 'Revenue', 'Profit', 'Margin %', 'Orders', 'Customers', 'Avg Order Value']];

  var sumRev = 0, sumPro = 0, sumOrd = 0, sumCust = 0;

  CFG.ALL_YEARS.forEach(function(y) {
    if (f.years.indexOf(y) > -1) {
      var d      = REF_YEAR[y];
      var rev    = Math.round(d.rev  * scale);
      var pro    = Math.round(d.pro  * scale);
      var ord    = Math.round(d.ord  * scale);
      var cust   = Math.round(d.cust * scale);
      var margin = rev > 0 ? Math.round((pro / rev) * 10000) / 100 : 0;
      var aov    = ord > 0 ? Math.round(rev / ord) : 0;
      data.push([y, rev, pro, margin, ord, cust, aov]);
      sumRev += rev; sumPro += pro; sumOrd += ord; sumCust += cust;
    } else {
      data.push(['', '', '', '', '', '', '']);
    }
  });

  // Total row
  var totMargin = sumRev > 0 ? Math.round((sumPro / sumRev) * 10000) / 100 : 0;
  var totAov    = sumOrd > 0 ? Math.round(sumRev / sumOrd) : 0;
  data.push(['Total', sumRev, sumPro, totMargin, sumOrd, sumCust, totAov]);

  return data; // always 7 rows
}


// =============================================================================
// WRITE FUNCTIONS
// =============================================================================

// Batch-write all 5 helper tables in one function to minimise sheet API calls.
function writeHelperTables(dash, ht1, ht2, ht3, ht4, perf) {
  dash.getRange(CFG.HT1_ROW,     CFG.HT_COL, ht1.length,  ht1[0].length).setValues(ht1);
  dash.getRange(CFG.HT2_ROW,     CFG.HT_COL, ht2.length,  ht2[0].length).setValues(ht2);
  dash.getRange(CFG.HT3_ROW,     CFG.HT_COL, ht3.length,  ht3[0].length).setValues(ht3);
  dash.getRange(CFG.HT4_ROW,     CFG.HT_COL, ht4.length,  ht4[0].length).setValues(ht4);
  dash.getRange(CFG.HT_PERF_ROW, CFG.HT_COL, perf.length, perf[0].length).setValues(perf);
}

// Write KPI card values (row 6) and YoY comparison strings (row 7).
// Row 6: numeric values — formatted by cell number format set in polishExecutiveFormatting().
// Row 7: string values  — formatted comparison text e.g. "+13.0% vs 2024".
function updateKPICards(dash, kpis, f) {
  // --- Row 6: current period values ---
  dash.getRange(CFG.KPI_REV_CELL).setValue(kpis.rev);
  dash.getRange(CFG.KPI_PRO_CELL).setValue(kpis.pro);
  dash.getRange(CFG.KPI_MAR_CELL).setValue(kpis.margin / 100); // store as decimal for % format
  dash.getRange(CFG.KPI_ORD_CELL).setValue(kpis.ord);

  // --- Row 7: year-over-year comparisons ---
  // Shift every selected year back by 1 to build the comparison period.
  // Category and market filters are kept identical for a fair comparison.
  var prevFilters = {
    years: f.years.map(function(y) { return String(parseInt(y, 10) - 1); }),
    cats:  f.cats,
    mkts:  f.mkts
  };
  var prevKpis = buildKPIs(prevFilters);

  // Label: "vs [maxYear - 1]" so it always matches what was actually computed.
  var maxYear      = Math.max.apply(null, f.years.map(function(y) { return parseInt(y, 10); }));
  var prevYearLbl  = String(maxYear - 1);

  // Helper: safe percentage change. Returns null if prior is zero.
  function pctChange(curr, prior) {
    if (!prior || prior === 0) return null;
    return ((curr - prior) / Math.abs(prior)) * 100;
  }

  // Helper: format a comparison value as a string.
  // pctOrDelta: the numeric change (percentage or pp delta)
  // suffix: ' vs YYYY'
  function fmtYoY(pctOrDelta, suffix) {
    if (pctOrDelta === null) return 'N/A ' + suffix;
    var sign = pctOrDelta >= 0 ? '+' : '';
    return sign + pctOrDelta.toFixed(1) + '%' + suffix;
  }

  var suffix = ' vs ' + prevYearLbl;

  // Revenue — percentage change
  var revYoY = pctChange(kpis.rev, prevKpis.rev);
  dash.getRange(CFG.KPI_REV_YOY).setValue(fmtYoY(revYoY, suffix));

  // Profit — percentage change
  var proYoY = pctChange(kpis.pro, prevKpis.pro);
  dash.getRange(CFG.KPI_PRO_YOY).setValue(fmtYoY(proYoY, suffix));

  // Margin — percentage-POINT delta (not percentage change), per financial convention
  var marYoY = kpis.margin - prevKpis.margin; // e.g. 11.75 - 11.40 = +0.35 pp
  dash.getRange(CFG.KPI_MAR_YOY).setValue(fmtYoY(marYoY, suffix));

  // Orders — percentage change
  var ordYoY = pctChange(kpis.ord, prevKpis.ord);
  dash.getRange(CFG.KPI_ORD_YOY).setValue(fmtYoY(ordYoY, suffix));
}


// =============================================================================
// MAIN ORCHESTRATOR
// Called by onEdit (automatically) and runRefresh (manually).
// =============================================================================

function refreshAll() {
  var ss   = SpreadsheetApp.getActive();
  var dash = ss.getSheetByName(CFG.DASH_SHEET);

  var f    = getFilters();
  var kpis = buildKPIs(f);
  var ht1  = buildHT1(f);
  var ht2  = buildHT2(f);
  var ht3  = buildHT3(f);
  var ht4  = buildHT4(f);
  var perf = buildPerfTable(f);

  writeHelperTables(dash, ht1, ht2, ht3, ht4, perf);
  updateKPICards(dash, kpis, f);

  SpreadsheetApp.flush();
}

// Thin wrapper — callable from the Apps Script editor Run button and from the menu.
function runRefresh() {
  refreshAll();
}


// =============================================================================
// CHART BUILDER
// Creates all 5 embedded charts and binds them to helper table ranges.
// Charts must be deleted and recreated if you want to change position or type.
// Data source ranges (column N) never change; charts update automatically
// when writeHelperTables() overwrites those ranges.
// =============================================================================

function buildCharts() {
  var ss   = SpreadsheetApp.getActive();
  var dash = ss.getSheetByName(CFG.DASH_SHEET);

  // Remove all existing charts to avoid duplicates on re-run
  dash.getCharts().forEach(function(chart) {
    dash.removeChart(chart);
  });

  var col = CFG.HT_COL; // column N = 14

  // --- Chart 1: Annual Revenue & Profit Trend (line chart) ---
  // Data: HT1 N2:P7 (Year, Revenue, Gross Profit)
  var ht1Range = dash.getRange(CFG.HT1_ROW, col, 6, 3);
  var chart1 = dash.newChart()
    .setChartType(Charts.ChartType.LINE)
    .addRange(ht1Range)
    .setOption('title', 'Annual Revenue & Profit')
    .setOption('legend', { position: 'bottom' })
    .setOption('hAxis', { title: 'Year' })
    .setOption('vAxis', { title: 'USD', format: '$#,###' })
    .setOption('colors', ['#1a73e8', '#34a853'])
    .setOption('lineWidth', 3)
    .setOption('pointSize', 6)
    .setPosition(9, 1, 0, 0)
    .build();
  dash.insertChart(chart1);

  // --- Chart 2: Revenue by Category (bar chart) ---
  // Data: HT2 N10:O13 (Category, Revenue)
  var ht2Range = dash.getRange(CFG.HT2_ROW, col, 4, 2);
  var chart2 = dash.newChart()
    .setChartType(Charts.ChartType.BAR)
    .addRange(ht2Range)
    .setOption('title', 'Revenue by Category')
    .setOption('legend', { position: 'none' })
    .setOption('hAxis', { title: 'Revenue (USD)', format: '$#,###' })
    .setOption('vAxis', { title: '' })
    .setOption('colors', ['#1a73e8'])
    .setPosition(9, 8, 0, 0)
    .build();
  dash.insertChart(chart2);

  // --- Chart 3: Revenue by Market (bar chart) ---
  // Data: HT3 N16:O21 (Market, Revenue)
  var ht3Range = dash.getRange(CFG.HT3_ROW, col, 6, 2);
  var chart3 = dash.newChart()
    .setChartType(Charts.ChartType.BAR)
    .addRange(ht3Range)
    .setOption('title', 'Revenue by Market')
    .setOption('legend', { position: 'none' })
    .setOption('hAxis', { title: 'Revenue (USD)', format: '$#,###' })
    .setOption('vAxis', { title: '' })
    .setOption('colors', ['#fbbc04'])
    .setPosition(26, 1, 0, 0)
    .build();
  dash.insertChart(chart3);

  // --- Chart 4: Revenue by Shipping Mode (pie / bar chart) ---
  // Data: HT4 N24:O28 (Ship Mode, Revenue)
  var ht4Range = dash.getRange(CFG.HT4_ROW, col, 5, 2);
  var chart4 = dash.newChart()
    .setChartType(Charts.ChartType.PIE)
    .addRange(ht4Range)
    .setOption('title', 'Revenue by Ship Mode')
    .setOption('legend', { position: 'right' })
    .setOption('pieSliceText', 'percentage')
    .setOption('colors', ['#1a73e8', '#34a853', '#fbbc04', '#ea4335'])
    .setPosition(26, 8, 0, 0)
    .build();
  dash.insertChart(chart4);

  // --- Chart 5: Annual Performance Table (column chart) ---
  // Data: Perf N31:T37 (Year, Revenue, Profit, Margin%, Orders, Customers, AOV)
  // Using a column chart to show revenue trend with the full metrics in helper table
  var perfRange = dash.getRange(CFG.HT_PERF_ROW, col, 7, 3); // Year, Revenue, Profit only for chart
  var chart5 = dash.newChart()
    .setChartType(Charts.ChartType.COLUMN)
    .addRange(perfRange)
    .setOption('title', 'Annual Performance')
    .setOption('legend', { position: 'bottom' })
    .setOption('hAxis', { title: 'Year' })
    .setOption('vAxis', { title: 'USD', format: '$#,###' })
    .setOption('colors', ['#1a73e8', '#34a853'])
    .setOption('isStacked', false)
    .setPosition(41, 1, 0, 0)
    .build();
  dash.insertChart(chart5);

  Logger.log('buildCharts: 5 charts created and bound to helper table ranges in column N.');
}


// =============================================================================
// CONTROLS SHEET SETUP
// Creates the Controls sheet with labelled, data-validated filter dropdowns.
// =============================================================================

function setupControls() {
  var ss   = SpreadsheetApp.getActive();
  var ctrl = ss.getSheetByName(CFG.CTRL_SHEET);
  if (!ctrl) ctrl = ss.insertSheet(CFG.CTRL_SHEET);

  ctrl.clearContents();

  // Labels
  ctrl.getRange('A1').setValue('DASHBOARD FILTERS');
  ctrl.getRange('A2').setValue('Year');
  ctrl.getRange('A4').setValue('Category');
  ctrl.getRange('A6').setValue('Market');
  ctrl.getRange('A8').setValue('(Changes here update the dashboard automatically)');

  // Year dropdown: All + 5 individual years
  var yearOptions = ['All'].concat(CFG.ALL_YEARS);
  var yearRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(yearOptions, true)
    .setAllowInvalid(false)
    .build();
  ctrl.getRange(CFG.YEAR_CELL).setDataValidation(yearRule).setValue('All');

  // Category dropdown: All + 3 categories
  var catOptions = ['All'].concat(CFG.ALL_CATS);
  var catRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(catOptions, true)
    .setAllowInvalid(false)
    .build();
  ctrl.getRange(CFG.CAT_CELL).setDataValidation(catRule).setValue('All');

  // Market dropdown: All + 5 markets
  var mktOptions = ['All'].concat(CFG.ALL_MKTS);
  var mktRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(mktOptions, true)
    .setAllowInvalid(false)
    .build();
  ctrl.getRange(CFG.MKT_CELL).setDataValidation(mktRule).setValue('All');

  // Basic formatting
  ctrl.getRange('A1').setFontWeight('bold').setFontSize(12);
  ctrl.getRange('A2').setFontWeight('bold');
  ctrl.getRange('A4').setFontWeight('bold');
  ctrl.getRange('A6').setFontWeight('bold');
  ctrl.getRange('B2').setBackground('#e8f0fe');
  ctrl.getRange('B4').setBackground('#e8f0fe');
  ctrl.getRange('B6').setBackground('#e8f0fe');
  ctrl.setColumnWidth(1, 160);
  ctrl.setColumnWidth(2, 180);

  Logger.log('setupControls: Controls sheet configured.');
}


// =============================================================================
// DASHBOARD FILTER PANEL SETUP
// Adds data-validated filter dropdowns to the DASHBOARD inline filter cells.
// =============================================================================

function setupDashboardFilters() {
  var ss   = SpreadsheetApp.getActive();
  var dash = ss.getSheetByName(CFG.DASH_SHEET);
  if (!dash) {
    Logger.log('setupDashboardFilters: DASHBOARD sheet not found. Create it first.');
    return;
  }

  var yearOptions = ['All'].concat(CFG.ALL_YEARS);
  var catOptions  = ['All'].concat(CFG.ALL_CATS);
  var mktOptions  = ['All'].concat(CFG.ALL_MKTS);

  var yearRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(yearOptions, true)
    .setAllowInvalid(false)
    .build();

  var catRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(catOptions, true)
    .setAllowInvalid(false)
    .build();

  var mktRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(mktOptions, true)
    .setAllowInvalid(false)
    .build();

  dash.getRange(CFG.DASH_YEAR_CELL).setDataValidation(yearRule).setValue('All');
  dash.getRange(CFG.DASH_CAT_CELL).setDataValidation(catRule).setValue('All');
  dash.getRange(CFG.DASH_MKT_CELL).setDataValidation(mktRule).setValue('All');

  Logger.log('setupDashboardFilters: inline filter dropdowns set on DASHBOARD sheet.');
}


// =============================================================================
// TRIGGER MANAGEMENT
// installTrigger() must be run once. It creates a persistent installable
// onEdit trigger that runs with the installing user's full OAuth permissions.
// Simple onEdit functions lack the permission scope needed for cross-sheet writes.
// =============================================================================

function installTrigger() {
  // Remove any existing onEdit triggers to avoid duplicates
  var ss = SpreadsheetApp.getActive();
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'onEdit') {
      ScriptApp.deleteTrigger(t);
    }
  });

  // Register a new installable onEdit trigger
  ScriptApp.newTrigger('onEdit')
    .forSpreadsheet(ss)
    .onEdit()
    .create();

  Logger.log('installTrigger: installable onEdit trigger registered successfully.');
  SpreadsheetApp.getUi().alert(
    'Trigger installed. The dashboard will now refresh automatically on every filter change.'
  );
}


// =============================================================================
// ONE-TIME SETUP ORCHESTRATOR
// Run this once after pasting the script and before first use.
// =============================================================================

function setupDashboard() {
  setupControls();
  setupDashboardFilters();
  polishExecutiveFormatting();
  hideFilterPanelEmptyRows();
  refreshAll();
  Logger.log('setupDashboard: complete. Run installTrigger() next.');
  SpreadsheetApp.getUi().alert(
    'Dashboard setup complete.\n\nNext step: run "Install Trigger" from the Dashboard menu ' +
    '(or select installTrigger from the function dropdown and click Run) to enable ' +
    'automatic refresh on filter changes.'
  );
}


// =============================================================================
// VISUAL POLISH FUNCTIONS
// These functions manage the presentation layer: number formatting, row
// grouping for helper table columns, and filter panel layout.
// They are called once during setup and can be re-run to restore formatting.
// =============================================================================

// Apply currency, percentage, and number formatting to KPI cells.
// Row 6 stores raw numbers; these formats make them display correctly.
function polishExecutiveFormatting() {
  var ss   = SpreadsheetApp.getActive();
  var dash = ss.getSheetByName(CFG.DASH_SHEET);
  if (!dash) return;

  // Revenue and Profit: dollar format with thousands separator
  dash.getRange(CFG.KPI_REV_CELL).setNumberFormat('$#,##0');
  dash.getRange(CFG.KPI_PRO_CELL).setNumberFormat('$#,##0');

  // Margin: percentage with 2 decimal places (stored as decimal e.g. 0.1175)
  dash.getRange(CFG.KPI_MAR_CELL).setNumberFormat('0.00%');

  // Orders: integer with thousands separator
  dash.getRange(CFG.KPI_ORD_CELL).setNumberFormat('#,##0');

  // YoY comparison cells: plain text (values are already formatted strings)
  dash.getRange(CFG.KPI_REV_YOY).setNumberFormat('@');
  dash.getRange(CFG.KPI_PRO_YOY).setNumberFormat('@');
  dash.getRange(CFG.KPI_MAR_YOY).setNumberFormat('@');
  dash.getRange(CFG.KPI_ORD_YOY).setNumberFormat('@');

  Logger.log('polishExecutiveFormatting: KPI cell formats applied.');
}

// Hide the helper table column (column N) using column grouping.
// This keeps the dashboard surface clean while preserving chart bindings.
function fixHiddenHelperTableRows() {
  var ss   = SpreadsheetApp.getActive();
  var dash = ss.getSheetByName(CFG.DASH_SHEET);
  if (!dash) return;

  // Hide column N (column 14) — the helper table column
  try {
    dash.hideColumns(CFG.HT_COL);
    Logger.log('fixHiddenHelperTableRows: column N hidden.');
  } catch (err) {
    Logger.log('fixHiddenHelperTableRows: could not hide column N — ' + err.message);
  }
}

// Hide empty rows in the filter panel area (rows 8–13 in the left panel).
function hideFilterPanelEmptyRows() {
  var ss   = SpreadsheetApp.getActive();
  var dash = ss.getSheetByName(CFG.DASH_SHEET);
  if (!dash) return;

  try {
    // Hide spacer rows between filter labels and dropdowns if they exist
    // Adjust row numbers to match your actual layout
    var emptyRows = [8, 9, 10, 11, 12, 13];
    emptyRows.forEach(function(r) {
      var val = dash.getRange(r, 1).getValue();
      if (!val || String(val).trim() === '') {
        dash.hideRows(r);
      }
    });
    Logger.log('hideFilterPanelEmptyRows: empty filter panel rows hidden.');
  } catch (err) {
    Logger.log('hideFilterPanelEmptyRows: ' + err.message);
  }
}

// Reformat the filter panel: borders, background, font styling.
function redesignFilterPanel() {
  var ss   = SpreadsheetApp.getActive();
  var dash = ss.getSheetByName(CFG.DASH_SHEET);
  if (!dash) return;

  // Filter panel background — column B, rows 1–22
  dash.getRange('B1:B22').setBackground('#f8f9fa');

  // Filter labels
  dash.getRange(CFG.DASH_YEAR_CELL.replace('B', 'A')).setValue('Year').setFontWeight('bold');
  dash.getRange(CFG.DASH_CAT_CELL.replace('B', 'A')).setValue('Category').setFontWeight('bold');
  dash.getRange(CFG.DASH_MKT_CELL.replace('B', 'A')).setValue('Market').setFontWeight('bold');

  // Dropdown cells: highlight
  dash.getRange(CFG.DASH_YEAR_CELL).setBackground('#e8f0fe');
  dash.getRange(CFG.DASH_CAT_CELL).setBackground('#e8f0fe');
  dash.getRange(CFG.DASH_MKT_CELL).setBackground('#e8f0fe');

  Logger.log('redesignFilterPanel: filter panel formatted.');
}

// Safe version of redesignFilterPanel — catches errors without interrupting setup.
function redesignFilterPanelSafe() {
  try {
    redesignFilterPanel();
  } catch (err) {
    Logger.log('redesignFilterPanelSafe: non-fatal error — ' + err.message);
  }
}

// Final visual pass: borders, alignment, and header formatting.
function polishFilterPanelFinal() {
  var ss   = SpreadsheetApp.getActive();
  var dash = ss.getSheetByName(CFG.DASH_SHEET);
  if (!dash) return;

  try {
    // Filter panel border
    dash.getRange('A1:B22').setBorder(
      false, false, false, true, false, false,
      '#dadce0', SpreadsheetApp.BorderStyle.SOLID
    );

    // Dropdown cells: centre-align values
    dash.getRange(CFG.DASH_YEAR_CELL).setHorizontalAlignment('center');
    dash.getRange(CFG.DASH_CAT_CELL).setHorizontalAlignment('center');
    dash.getRange(CFG.DASH_MKT_CELL).setHorizontalAlignment('center');

    Logger.log('polishFilterPanelFinal: final polish applied.');
  } catch (err) {
    Logger.log('polishFilterPanelFinal: ' + err.message);
  }
}
