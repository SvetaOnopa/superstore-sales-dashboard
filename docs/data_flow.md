# Data Flow

## End-to-End Pipeline

```
┌──────────────────────────────────┐
│       BIGQUERY WAREHOUSE         │
│  8 SQL views pre-aggregate data  │
│  at the right granularity for    │
│  each dashboard panel            │
└───────────────┬──────────────────┘
                │  Connected DataSource (live on file open)
                ▼
┌──────────────────────────────────┐
│   8 × v_rpt_* SHEETS             │
│   READ-ONLY DataSource tabs      │
│   getDataRange().getValues() ✗   │
│   getRange(r,c,rows,cols) ✓      │
└───────────────┬──────────────────┘
                │  Read at setup / buildCharts time
                │  Values extracted to hardcoded JS constants
                ▼
┌──────────────────────────────────┐
│   APPS SCRIPT CONSTANTS          │
│   REF_YEAR / REF_CAT             │
│   REF_MKT / REF_SHIP             │
│   TOTAL_REV = 12,642,905         │
└───────────────┬──────────────────┘
                │  onEdit trigger fires on filter change
                ▼
┌──────────────────────────────────┐
│   getFilters()                   │
│   Reads Controls!B2/B4/B6        │
│   Reads DASHBOARD!B6/B14/B20     │
│   Syncs both locations           │
│   Returns normalised filter obj  │
└───────────────┬──────────────────┘
                │  filters object passed to all builders
                ▼
┌──────────────────────────────────────────────────────────┐
│   IN-MEMORY COMPUTATION                                  │
│                                                          │
│   getCatScale(f)  = selectedCatRev / TOTAL_REV           │
│   getMktScale(f)  = selectedMktRev / TOTAL_REV           │
│   getYearScale(f) = selectedYearRev / TOTAL_REV          │
│                                                          │
│   buildHT1(f)  → year×(catScale×mktScale)                │
│   buildHT2(f)  → category×(yearScale×mktScale)           │
│   buildHT3(f)  → market×(yearScale×catScale)             │
│   buildHT4(f)  → shipMode×(yearScale×catScale×mktScale)  │
│   buildKPIs(f) → year exact, then ×(catScale×mktScale)   │
│   buildPerfTable(f) → year exact, then ×(catScale×mktScale) │
└──────┬───────────────────────────┬─────────────────────┘
       │ writeHelperTables()        │ updateKPICards()
       │ 5× setValues() to col N   │ setValue() to rows 6–7
       ▼                           ▼
┌──────────────────┐        ┌──────────────────────────────┐
│  HELPER TABLES   │        │  KPI CARDS                   │
│  col N, hidden   │        │  C6: $3,300,517              │
│  HT1  N2:P7      │        │  E6: $387,734                │
│  HT2  N10:O13    │        │  G6: 11.75%                  │
│  HT3  N16:O21    │        │  I6: 6,870                   │
│  HT4  N24:O28    │        │  C7: +13.0% vs 2024          │
│  Perf N31:T37    │        │  E7: +16.5% vs 2024          │
└──────┬───────────┘        │  G7: +0.4% vs 2024           │
       │ static range binds │  I7: +19.1% vs 2024          │
       ▼                    └──────────────────────────────┘
┌──────────────────────────────────┐
│  EMBEDDED CHARTS (auto-update)   │
│  Line: annual revenue/profit     │
│  Bar: by category                │
│  Bar: by market                  │
│  Bar: by ship mode               │
│  Table: annual performance       │
└──────────────────────────────────┘
```

---

## Filter Signal Trace — Example 1: Year = 2025, Category = All, Market = All

```
User selects "2025" in DASHBOARD!B6 dropdown
└── onEdit(e) fires: sheetName=DASHBOARD, cell=B6

getFilters():
  reads DASHBOARD!B6  → "2025"
  reads DASHBOARD!B14 → "All" → CFG.ALL_CATS = ['Technology','Furniture','Office Supplies']
  reads DASHBOARD!B20 → "All" → CFG.ALL_MKTS = ['APAC','EU','US','LATAM','Africa']
  syncs Controls!B2 = "2025"
  returns { years:['2025'], cats:[all 3], mkts:[all 5] }

Scale factors (cats=All → catScale=1.0, mkts=All → mktScale=1.0):
  getCatScale = (4027120+2945185+5670600) / 12642905 = 1.0
  getMktScale = (3232946+2593983+2297295+2163854+354827) / 12642905 = 1.0

buildKPIs({ years:['2025'], ... }):
  loops years: REF_YEAR['2025'] = { rev:3300517, pro:387734, ord:6870 }
  scale = catScale × mktScale = 1.0
  totRev = 3300517 × 1.0 = 3,300,517
  totPro = 387734 × 1.0  =   387,734
  totOrd = 6870 × 1.0    =     6,870
  margin = 387734/3300517 × 100 = 11.75%

YoY comparison (prevYear = 2024):
  prevFilters = { years:['2024'], cats:[all], mkts:[all] }
  prevKpis: rev=2920093, pro=332761, ord=5769
  Revenue: (3300517-2920093)/2920093 × 100 = +13.0%
  Profit:  (387734-332761)/332761 × 100    = +16.5%
  Margin:  11.75% - 11.40%                 = +0.35% → "+0.4% vs 2024"
  Orders:  (6870-5769)/5769 × 100          = +19.1%

writeHelperTables → sets DASHBOARD N2:T37 in 5 setValues() calls
updateKPICards    → sets C6:I7 (values + YoY comparison strings)
Charts auto-render from updated column N ranges
```

---

## Filter Signal Trace — Example 2: Year = 2025, Category = Technology, Market = APAC + EU

```
User selects "Technology" in DASHBOARD!B14 dropdown
└── onEdit(e) fires: sheetName=DASHBOARD, cell=B14

getFilters():
  reads DASHBOARD!B6  → "2025"   → years: ['2025']
  reads DASHBOARD!B14 → "Technology" → cats: ['Technology']
  reads DASHBOARD!B20 → "All"    → mkts: ['APAC','EU','US','LATAM','Africa']
  syncs Controls!B4 = "Technology"
  returns { years:['2025'], cats:['Technology'], mkts:[all 5] }

Scale factors:
  getCatScale = REF_CAT['Technology'].rev / TOTAL_REV
             = 4027120 / 12642905 = 0.3185  (~31.9% of revenue is Technology)
  getMktScale = 1.0  (all markets selected)

buildKPIs:
  year exact:  totRev_year = REF_YEAR['2025'].rev = 3,300,517
  scale        = catScale × mktScale = 0.3185 × 1.0 = 0.3185
  filteredRev  = 3300517 × 0.3185 ≈ 1,051,215
  filteredPro  = 387734 × 0.3185 ≈   123,493
  filteredOrd  = 6870 × 0.3185   ≈     2,188

YoY comparison (prevYear = 2024, same category/market filters):
  prevFilters = { years:['2024'], cats:['Technology'], mkts:[all] }
  prevCatScale = 0.3185  (same — marginal total is dataset-wide, not year-specific)
  prevRev = 2920093 × 0.3185 ≈ 930,250
  Revenue YoY = (1051215 - 930250) / 930250 × 100 ≈ +13.0%
  (same growth rate as All Categories — this is the proportional scaling approximation;
   exact Technology-only growth may differ if Technology's share shifted year-over-year)

Note: The identical YoY rate when switching categories illustrates the proportional
scaling limitation. The scale factor is dataset-wide, so it applies uniformly to all
years. For exact per-category-per-year filtering, a cross-dimensional reference table
would be needed. See docs/architecture_decisions.md Decision 4.
```

---

## Data Refresh Sequence (on file open)

```
1. Google Sheets opens
2. All 8 Connected DataSource sheets query their BigQuery views simultaneously
3. v_rpt_* tabs populate with fresh data (typically 5–15 seconds)
4. onOpen() fires → adds "Dashboard" custom menu
5. If installable trigger is registered:
   - No automatic refresh fires (onOpen ≠ onEdit)
   - User changes a filter → onEdit fires → refreshAll() runs
6. If user selects "Dashboard → Refresh Dashboard":
   - runRefresh() → refreshAll() runs immediately
```

---

## Sheet Tab Map

| Tab name              | Type              | Purpose |
|-----------------------|-------------------|---------|
| DASHBOARD             | Standard sheet    | Main visual surface; KPI cards, charts, inline filter dropdowns, helper tables (col N, hidden) |
| Controls              | Standard sheet    | Structured filter form; data-validated dropdowns for Year, Category, Market |
| v_rpt_exec_summary    | DataSource sheet  | Annual executive summary (BigQuery view) |
| v_rpt_monthly_trend   | DataSource sheet  | Monthly time series (BigQuery view) |
| v_rpt_category        | DataSource sheet  | Category/sub-category breakdown (BigQuery view) |
| v_rpt_discount        | DataSource sheet  | Discount tier profitability (BigQuery view) |
| v_rpt_market_geo      | DataSource sheet  | Geographic/market breakdown (BigQuery view) |
| v_rpt_customer        | DataSource sheet  | Customer segmentation (BigQuery view) |
| v_rpt_product         | DataSource sheet  | Product performance (BigQuery view) |
| v_rpt_shipping        | DataSource sheet  | Shipping mode analysis (BigQuery view) |
