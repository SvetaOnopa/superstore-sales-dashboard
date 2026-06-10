# Technical Implementation Notes

# # Why Google Apps Script?

Google Sheets does not provide a native mechanism to:
- React to filter selection changes and recompute aggregates across multiple sheets
- Write computed values into specific dashboard cells in response to user input
- Keep two sets of filter controls (a Controls sheet and inline DASHBOARD dropdowns) synchronised
- Build and maintain hidden intermediate data tables that charts can reference

Apps Script fills all of these gaps. It runs server-side within Google's infrastructure, requires no external hosting or infrastructure, and can be triggered automatically by spreadsheet events via installable triggers.

---

# # Why Helper Tables?

Charts in Google Sheets must reference a **static, fixed cell range**. The underlying data lives in eight read-only BigQuery DataSource sheets that cannot be sorted, filtered, rearranged, or overwritten by Apps Script. There is no native mechanism to connect a chart to a dynamic formula output spanning multiple sheets.

The solution: Apps Script computes aggregated data in memory, then writes the results into a dedicated hidden column (column N) on the DASHBOARD sheet. Each chart is permanently bound to a fixed range within that column. Every refresh overwrites column N with newly computed values, and all charts update automatically. Helper table rows are hidden using row grouping so the dashboard surface remains clean for users.

---

# # Why Hardcoded Reference Data?

Google Sheets Connected DataSources (BigQuery-linked sheets) have two key constraints that shaped this architecture:

**Constraint 1:** `.getDataRange().getValues()` throws a runtime error on DataSource sheets. Only explicit range references — `getRange(1, 1, 200, 15).getValues()` — work reliably, and only when the sheet has already loaded its data.

**Constraint 2:** Runtime SQL filters cannot be injected into Connected DataSource queries. The BigQuery view executes with its own fixed `WHERE` clause defined at connection time; Apps Script cannot modify it.

Given these constraints, the decision was made to hardcode pre-computed marginal totals as JavaScript constants (`REF_YEAR`, `REF_CAT`, `REF_MKT`, `REF_SHIP`). These values were derived from full BigQuery exports and represent exact aggregates from the actual dataset. They eliminate fragile runtime sheet-reading for dimension members that are stable in count and well-known.

This is a deliberate engineering trade-off: the reference data is static in the script, but it represents the real dataset values exactly. If the underlying data grows to include a new year or market, the constants require a one-time update.

---

# # How Filtering Works: Two Strategies

The dashboard applies **two different filtering strategies** depending on the dimension:

# ## Year Filtering — Exact Aggregation

Year filtering is always exact. `buildKPIs`, `buildHT1`, and `buildPerfTable` iterate only over the selected years:

```javascript
filters.years.forEach(function(y) {
  var d = REF_YEAR[y];       // look up this specific year's data
  if (d) { totRev += d.rev; totPro += d.pro; totOrd += d.ord; }
});
```

Selecting 2025 produces exactly the 2025 totals. Selecting 2024+2025 sums those two years precisely. This is fully exact because `REF_YEAR` contains per-year breakdowns.

# ## Category and Market Filtering — Proportional Scaling

Category and Market filtering uses a proportional scaling approach. This is a documented approximation necessitated by the data structure: the reference tables store **marginal totals** — each aggregated over all values of the other dimensions. There is no cross-dimensional index (e.g., no per-year-per-category breakdown) in the current reference data.

The approach computes a revenue proportion for the selected subset:

```javascript
// catScale = what fraction of all revenue comes from selected categories
catScale = sum(REF_CAT[c].rev for c in selectedCats) / TOTAL_REV

// mktScale = what fraction of all revenue comes from selected markets  
mktScale = sum(REF_MKT[m].rev for m in selectedMkts) / TOTAL_REV
```

These scale factors are then multiplied and applied to the year-exact totals:

```javascript
scale = catScale * mktScale;
totRev = Math.round(totRev * scale);
```

Each `buildHT*` function documents its own filtering strategy in a comment:
```javascript
// Filtered by: Year (direct), Category & Market (proportional scale)
```

**When does this work well?** For an executive dashboard designed to surface relative trends, YoY comparisons, and distribution across categories/markets, proportional scaling produces directionally accurate results that are appropriate for the use case. If you select "Technology only," revenue scales to approximately the Technology fraction of total revenue. If you select "APAC + EU," revenue scales to approximately their combined share.

**When does this have limits?** If category or market revenue shares vary significantly by year (e.g., a category that grew from 10% to 40% share over five years), the proportional approach will produce estimates that diverge from exact filtered BigQuery values. For operational dashboards requiring exact per-filter counts, a cross-dimensional reference table or a backend query capability would be needed.

**How to make filtering fully exact:** Populate a cross-dimensional reference object from BigQuery exports:
```javascript
// Example structure for fully exact cross-dimensional filtering:
var REF_YEAR_CAT_MKT = {
  '2025_Technology_APAC': { rev: ..., pro: ..., ord: ... },
  '2025_Technology_EU':   { rev: ..., pro: ..., ord: ... },
  // ... all combinations
};
```
This would allow exact aggregation across all filter combinations but requires a more complex reference data setup. The current proportional approach was chosen to keep the reference data compact and maintainable.

---

# # Dual Control Synchronisation

The dashboard exposes two equivalent filter interfaces:

- **Controls sheet** (B2, B4, B6): A dedicated structured form, useful for users who prefer a separate control pane
- **DASHBOARD inline dropdowns** (B6, B14, B20): Dropdowns embedded in the visual dashboard, useful for quick ad-hoc filtering

Both sets are created with data validation from `CFG.ALL_YEARS`, `CFG.ALL_CATS`, and `CFG.ALL_MKTS` plus an "All" option. When a user changes either location, `getFilters()` reads both, identifies the most recent change, syncs the other location to match, and proceeds with `refreshAll()`. From the user's perspective there is only one set of filters.

---

# # KPI Year-over-Year Comparison

`updateKPICards()` computes YoY comparisons by constructing a `prevFilters` object that shifts each selected year back by one:

```javascript
var prevFilters = {
  years: filters.years.map(y => String(parseInt(y) - 1)),
  cats: filters.cats,
  mkts: filters.mkts
};
var prevKpis = buildKPIs(prevFilters);
```

Revenue, profit, and orders use percentage change: `(current - prior) / |prior| × 100`.
Margin uses percentage-point delta: `currentMargin% - priorMargin%`, displayed as `%` (not `pts`).
All values display with `+` prefix for positive changes and exactly one decimal place: `+13.0% vs 2024`.

---

# # Trigger Architecture

An **installable** `onEdit` trigger is used rather than a simple `onEdit` function. The distinction matters: a simple `onEdit` function runs with restricted permissions and cannot reliably access cross-sheet operations and SpreadsheetApp methods at the scope needed. An installable trigger runs with the permissions of the installing user and has full access to the spreadsheet's API surface.

`installTrigger()` registers the trigger once:
```javascript
ScriptApp.newTrigger('onEdit')
  .forSpreadsheet(SpreadsheetApp.getActive())
  .onEdit()
  .create();
```

---

# # Custom Menu

`onOpen()` adds a "Dashboard" top-level menu to Google Sheets with three items:
- **Refresh Dashboard** → `runRefresh()`
- **Setup Dashboard** → `setupDashboard()`
- **Install Trigger** → `installTrigger()`

This gives users a recoverable path to manually re-run setup or refresh without opening the Apps Script editor.

---

# # Technical Challenges Solved

| Challenge | Root Cause | Solution |
|---|---|---|
| `getDataRange().getValues()` fails on DataSource sheets | Known Google Sheets Connected DataSource limitation | Hardcoded reference constants derived from BigQuery exports |
| Charts require static ranges; data is dynamic | Google Sheets chart architecture | Hidden helper tables in column N as permanent chart data sources |
| Category/market filters cannot query BigQuery at runtime | Connected DataSource SQL is fixed at connection time | Proportional scaling using marginal revenue fractions |
| Two filter UIs must stay in sync | Dual control surface design | Bidirectional sync in `getFilters()` on every `onEdit` event |
| KPI row 7 showed static placeholder text | Row 7 was hardcoded in the sheet cells | Added YoY computation to `updateKPICards(filters)`, writing to row 7 on every refresh |
| Margin comparison used "pts" abbreviation | Inconsistent formatting in `polishExecutiveFormatting()` | Fixed to `% vs YYYY` throughout |
| Apps Script saves not persisting | Editing via script.google.com/home (project viewer) instead of editor | Must open editor via Sheets → Extensions → Apps Script; only that context persists saves to server |