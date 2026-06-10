# System Architecture

# # Overview

The dashboard is built on a three-layer architecture: BigQuery as the data warehouse, Google Sheets Connected DataSources as the live data transport layer, and Google Apps Script as the computation and orchestration engine. The three layers communicate through a well-defined data flow, with a hidden helper table layer bridging the read-only DataSource sheets and the chart presentation layer.

---

# # Architecture Diagram
┌─────────────────────────────────────────────────────────────────┐
│                      BIGQUERY WAREHOUSE                         │
│  8 SQL views: v_rpt_exec_summary, v_rpt_monthly_trend,          │
│  v_rpt_category, v_rpt_discount, v_rpt_market_geo,             │
│  v_rpt_customer, v_rpt_product, v_rpt_shipping                  │
└───────────────────────┬─────────────────────────────────────────┘
│  Google Sheets Connected DataSource
│  (live query on file open)
▼
┌─────────────────────────────────────────────────────────────────┐
│              8 × v_rpt_* SHEETS (read-only)                     │
│  DataSource sheets — Apps Script reads via                      │
│  getRange(row, col, numRows, numCols).getValues()               │
└───────────────────────┬─────────────────────────────────────────┘
│  Apps Script reads at setup time
│  (values hardcoded as JS constants)
▼
┌─────────────────────────────────────────────────────────────────┐
│             APPS SCRIPT — Code.gs (27 functions)                │
│                                                                 │
│  Constants:  CFG | REF_YEAR | REF_CAT | REF_MKT | REF_SHIP      │
│  Trigger:    onEdit → getFilters → refreshAll                   │
│  Builders:   buildHT1/2/3/4 | buildKPIs | buildPerfTable        │
│  Writers:    writeHelperTables | updateKPICards                 │
│  Setup:      setupDashboard | buildCharts | setupControls        │
└───────┬───────────────────────────┬─────────────────────────────┘
│ setValues()               │ setValue()
▼                           ▼
┌───────────────────┐     ┌─────────────────────────────────────┐
│  HELPER TABLES    │     │           KPI CARDS                 │
│  DASHBOARD col N  │     │   Row 6: $3,300,517 / 11.75% / ...  │
│  HT1 rows 2–7     │     │   Row 7: +13.0% vs 2024 / ...       │
│  HT2 rows 10–13   │     └─────────────────────────────────────┘
│  HT3 rows 16–21   │
│  HT4 rows 24–28   │
│  Perf rows 31–37  │
└───────┬───────────┘
│  chart data source ranges (static bindings)
▼
┌─────────────────────────────────────────────────────────────────┐
│                     EMBEDDED CHARTS                             │
│  Annual Revenue/Profit trend | Category bar | Market bar        │
│  Shipping mode split | Performance table                        │
└─────────────────────────────────────────────────────────────────┘

---

# # Components

# ## 1. BigQuery DataSource Sheets (8 sheets)

Each sheet is a live Connected DataSource executing a BigQuery SQL view. They refresh when the spreadsheet is opened or when manually refreshed. Apps Script reads these sheets using explicit range references; `.getDataRange().getValues()` is not supported on DataSource sheets.

| Sheet | Description | Key Columns |
|---|---|---|
| `v_rpt_exec_summary` | Annual aggregates | `order_year`, `total_revenue`, `total_profit`, `profit_margin`, `total_orders`, `unique_customers`, `avg_order_value`, `revenue_per_order`, `total_shipping_cost`, `shipping_cost_ratio`, `avg_discount`, `total_units`, `revenue_yoy_growth`, `profit_yoy_growth` |
| `v_rpt_monthly_trend` | Monthly time series | `order_year`, `order_quarter`, `order_month`, `year_month`, `monthly_revenue`, `monthly_profit`, `profit_margin`, `order_count`, `unique_customers`, `units_sold`, `total_shipping`, `ytd_revenue` |
| `v_rpt_category` | Category/sub-category | `order_year`, `category`, `sub_category`, `total_revenue`, `total_profit`, `profit_margin`, `order_count`, `units_sold`, `avg_discount`, `revenue_share`, `category_rank`, `margin_tier` |
| `v_rpt_discount` | Discount impact | `order_year`, `discount_level`, `category`, `sub_category`, `order_count`, `total_revenue`, `total_profit`, `profit_margin`, `avg_discount`, `units_sold`, `avg_profit_per_unit`, `loss_rate` |
| `v_rpt_market_geo` | Geographic/market | `order_year`, `market`, `region`, `country`, `total_revenue`, `total_profit`, `profit_margin`, `order_count`, `unique_customers`, `units_sold`, `total_shipping`, `shipping_cost_ratio`, `avg_days_to_ship`, `revenue_per_customer` |
| `v_rpt_customer` | Customer segmentation | Segment / lifetime value metrics |
| `v_rpt_product` | Product performance | Sub-category / SKU-level metrics |
| `v_rpt_shipping` | Shipping analysis | Ship mode / delivery time metrics |

# ## 2. Hardcoded Reference Data

Because DataSource sheets do not support `getDataRange().getValues()`, and because Google Sheets Connected DataSources cannot be queried with runtime SQL filters, the Apps Script stores pre-computed marginal totals as JavaScript constants. These values were derived from full BigQuery exports.

```javascript
// Annual totals (all categories, all markets)
var REF_YEAR = {
  '2022': { rev: 1835390, pro: 200534, ord: 3632, cust: 794 },
  '2023': { rev: 2355771, pro: 278767, ord: 4732, cust: 793 },
  '2024': { rev: 2920093, pro: 332761, ord: 5769, cust: 795 },
  '2025': { rev: 3300517, pro: 387734, ord: 6870, cust: 795 },
  '2026': { rev: 2231134, pro: 267663, ord: 4462, cust: 792 }
};

// Category totals (all years, all markets)
var REF_CAT = {
  'Technology':       { rev: 4027120, pro: 512123 },
  'Furniture':        { rev: 2945185, pro: 121908 },
  'Office Supplies':  { rev: 5670600, pro: 833428 }
};

// Market totals (all years, all categories)
var REF_MKT = {
  'APAC':   { rev: 3232946, pro: 379423 },
  'EU':     { rev: 2593983, pro: 305219 },
  'US':     { rev: 2297295, pro: 249891 },
  'LATAM':  { rev: 2163854, pro: 235461 },
  'Africa': { rev: 354827,  pro: 39465  }
};

var TOTAL_REV = 12642905; // grand total (all years, cats, markets)
```

**Important:** Each reference table contains **marginal totals** — aggregated over all values of the other dimensions. There is no cross-dimensional index (e.g., no `REF[year][category]`). This is the architectural foundation of the proportional scaling approach described below.

# ## 3. CFG Object

All cell addresses, sheet names, and layout constants are centralised in a single `CFG` object, eliminating magic strings throughout the codebase.

```javascript
var CFG = {
  CTRL_SHEET: 'Controls',   DASH_SHEET: 'DASHBOARD',
  YEAR_CELL:  'B2',         CAT_CELL:   'B4',    MKT_CELL:   'B6',
  DASH_YEAR_CELL: 'B6',     DASH_CAT_CELL: 'B14', DASH_MKT_CELL: 'B20',
  ALL_YEARS: ['2022','2023','2024','2025','2026'],
  ALL_CATS:  ['Technology','Furniture','Office Supplies'],
  ALL_MKTS:  ['APAC','EU','US','LATAM','Africa'],
  ALL_SHIPS: ['Standard Class','Second Class','First Class','Same Day'],
  HT_COL: 14,  HT1_ROW: 2,  HT2_ROW: 10,  HT3_ROW: 16,
  HT4_ROW: 24, HT_PERF_ROW: 31
};
```

# ## 4. Filter / Control Architecture

The dashboard exposes two equivalent filter UIs with full bidirectional synchronisation:
Controls sheet (B2 / B4 / B6)
↕  bidirectional sync on every onEdit event
DASHBOARD inline dropdowns (B6 / B14 / B20)

`getFilters()` reads both locations and returns a normalised filter object:
```javascript
{ years: ['2025'], cats: ['Technology'], mkts: ['APAC','EU','US','LATAM','Africa'] }
```
When "All" is selected for a dimension, the full `CFG.ALL_*` array is used so downstream logic always works with explicit arrays.

# ## 5. Filter Logic: Exact Year Aggregation + Cross-Dimensional Scaling

The script applies two different filtering strategies depending on which dimension is being filtered:

**Year filtering — exact:** `buildKPIs`, `buildHT1`, and `buildPerfTable` iterate only over the selected years from `REF_YEAR`, summing those rows precisely. A filter of `years: ['2025']` produces exactly the 2025 totals; `years: ['2024', '2025']` sums both years exactly.

**Category and Market filtering — proportional scaling:** Because the reference tables store marginal totals (not cross-dimensional breakdowns), filtering by category or market is computed as a revenue proportion:

```javascript
catScale = sum(REF_CAT[c].rev for c in selectedCats) / TOTAL_REV
mktScale = sum(REF_MKT[m].rev for m in selectedMkts) / TOTAL_REV
```

The selected scale factors are multiplied together and applied to the year-filtered totals. The code comment on each `buildHT*` function documents which filtering strategy is used for each dimension: `// Filtered by: Year (direct), Category & Market (proportional scale)`.

This approach is fit for purpose for an executive dashboard showing relative trends and YoY comparisons, and is clearly documented as an approximation for the category and market dimensions. See `technical_implementation.md` for a full discussion of this trade-off.

# ## 6. Helper Tables

Charts in Google Sheets require static cell range references. Since the DataSource sheets are read-only and cannot be rearranged, Apps Script writes computed values into column N of the DASHBOARD sheet. These cells are hidden from view but serve as permanent data sources for the embedded charts.

| Table | Range | Content |
|---|---|---|
| HT1 | N2:P7   | Annual revenue and gross profit by selected year |
| HT2 | N10:O13 | Revenue by selected category |
| HT3 | N16:O21 | Revenue by selected market |
| HT4 | N24:O28 | Revenue by ship mode |
| Perf | N31:T37 | Annual performance table (revenue, profit, margin, orders, customers, avg order value) |

# ## 7. KPI Cards

| Cell | Metric | Format |
|---|---|---|
| C6 | Total Revenue | `$3,300,517` |
| E6 | Total Profit | `$387,734` |
| G6 | Profit Margin % | `11.75%` |
| I6 | Total Orders | `6,870` |
| C7 | Revenue YoY | `+13.0% vs 2024` |
| E7 | Profit YoY | `+16.5% vs 2024` |
| G7 | Margin YoY | `+0.4% vs 2024` |
| I7 | Orders YoY | `+19.1% vs 2024` |

# ## 8. Function Reference (27 functions)

| Function | Lines | Role |
|---|---|---|
| `onEdit(e)` | 71 | Installable trigger entry point; detects edits on Controls or DASHBOARD; calls `refreshAll()` |
| `getFilters()` | 92 | Reads both control UIs; syncs them; returns normalised filter object |
| `getCatScale(f)` | 119 | Computes `selectedCatRevenue / TOTAL_REV` |
| `getMktScale(f)` | 126 | Computes `selectedMktRevenue / TOTAL_REV` |
| `getYearScale(f)` | 133 | Computes `selectedYearRevenue / TOTAL_REV` (used by HT2/HT3/HT4) |
| `buildHT1(f)` | 143 | Annual revenue+profit: exact year loop, cat×mkt scale applied |
| `buildHT2(f)` | 163 | Category revenue: exact cat loop, year×mkt scale applied |
| `buildHT3(f)` | 178 | Market revenue: exact mkt loop, year×cat scale applied |
| `buildHT4(f)` | 193 | Shipping mode revenue: full year×cat×mkt scale applied |
| `buildKPIs(f)` | 208 | KPI totals: exact year loop, cat×mkt scale applied |
| `buildPerfTable(f)` | 228 | Annual perf matrix: exact year loop, cat×mkt scale applied |
| `writeHelperTables(...)` | 249 | Batch `setValues()` for all 5 helper tables |
| `updateKPICards(dash,kpis,f)` | 259 | Writes rows 6–7; computes YoY comparison strings |
| `refreshAll()` | 327 | Orchestrator: reads filters → builds tables → writes sheet |
| `buildCharts()` | 344 | Creates/recreates all embedded charts bound to helper table ranges |
| `setupControls()` | — | Initialises Controls sheet with data-validated dropdowns |
| `installTrigger()` | — | Registers the installable `onEdit` trigger |
| `setupDashboardFilters()` | — | Adds inline filter dropdowns to DASHBOARD sheet |
| `setupDashboard()` | — | One-time full setup orchestrator |
| `runRefresh()` | — | Thin wrapper: `refreshAll()` — callable from the editor run button |
| `onOpen()` | — | Adds "Dashboard" custom menu to Sheets menu bar |
| `redesignFilterPanel()` | — | Reformats the filter panel visual layout |
| `redesignFilterPanelSafe()` | — | Safe variant with error handling |
| `hideFilterPanelEmptyRows()` | — | Hides empty rows in filter panel |
| `polishFilterPanelFinal()` | — | Final visual polish pass on filter panel |
| `fixHiddenHelperTableRows()` | — | Ensures helper table rows remain hidden |
| `polishExecutiveFormatting()` | — | Applies number/currency formatting to KPI cells |