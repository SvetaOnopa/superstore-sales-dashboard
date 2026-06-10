# Architecture Decisions and Trade-offs

This document records the major design decisions made during the development of the Superstore Global Sales Executive Dashboard. Each decision is presented with its motivating problem, the platform constraints that shaped it, the solution chosen, the alternatives considered, and the reasoning behind the final approach.

---

## Decision 1 — Connected Sheets as the Data Transport Layer

**Problem**

The dashboard needs to surface live data from a BigQuery warehouse without requiring users to manually export and paste data, and without maintaining a separate ETL pipeline or scheduled job.

**Constraint**

The team's tooling is entirely within Google Workspace. There is no dedicated BI platform, no middleware service, and no scheduled orchestration layer. The solution must be self-contained within Google Sheets.

**Solution**

Use Google Sheets Connected DataSources to link each BigQuery SQL view directly to a dedicated worksheet tab. Data refreshes when the file is opened, with no intermediary steps. Eight views are connected: `v_rpt_exec_summary`, `v_rpt_monthly_trend`, `v_rpt_category`, `v_rpt_discount`, `v_rpt_market_geo`, `v_rpt_customer`, `v_rpt_product`, and `v_rpt_shipping`.

**Alternatives Considered**

- **Scheduled export via Cloud Functions + Google Drive:** Would provide more control over refresh timing but introduces external infrastructure, IAM configuration, and deployment overhead inconsistent with a Sheets-native solution.
- **IMPORTDATA / IMPORTRANGE from a staging sheet:** Fragile, subject to quota limits, and cannot execute BigQuery SQL.
- **Manual CSV imports:** Eliminates the live connection entirely and requires a human in the refresh loop.
- **Looker Studio:** A genuine alternative for BI dashboards, but would move the entire dashboard outside of Google Sheets, eliminating the Apps Script automation layer and requiring users to adopt a new tool.

**Why This Approach**

Connected DataSources provide a live BigQuery connection with zero infrastructure overhead, no credentials to manage, and a familiar Google Workspace interface for users. The trade-off is that the sheets become read-only and cannot be manipulated programmatically — a constraint that shapes every other decision in this list.

---

## Decision 2 — Hardcoded Reference Data Instead of Runtime Sheet Reads

**Problem**

Apps Script needs to perform filter-aware aggregations across years, categories, and markets. The natural approach would be to read the DataSource sheets at runtime and aggregate rows in JavaScript.

**Constraint**

Google Sheets DataSource sheets have two hard limitations that make runtime reads unreliable:

1. `.getDataRange().getValues()` throws a runtime error on DataSource sheets — only explicit fixed-range reads (`getRange(1, 1, n, m).getValues()`) work.
2. There is no API to determine the current row count of a DataSource sheet programmatically. A sheet may have 0 rows (not yet loaded) or hundreds of rows, with no reliable way to know which.

Additionally, reading a multi-hundred-row DataSource sheet on every `onEdit` event (which fires on every filter change) would create unacceptable latency and risk exceeding Apps Script execution time limits.

**Solution**

Extract pre-computed marginal totals from BigQuery exports once, and hardcode them as JavaScript constants in `Code.gs`:

```javascript
var REF_YEAR = {
  '2022': { rev: 1835390, pro: 200534, ord: 3632, cust: 794 },
  '2025': { rev: 3300517, pro: 387734, ord: 6870, cust: 795 },
  // ...
};
var REF_CAT = {
  'Technology': { rev: 4027120, pro: 512123 },
  // ...
};
var TOTAL_REV = 12642905;
```

Each constant stores marginal totals: per-year aggregates over all categories and markets; per-category aggregates over all years and markets; and so on.

**Alternatives Considered**

- **Runtime row-scan with try/catch fallback:** Read up to a safe maximum row count (e.g., 500 rows) and scan for empty rows to determine the actual data boundary. Viable but fragile — a DataSource sheet that hasn't loaded yet returns empty rows indistinguishable from a genuinely empty dataset.
- **Cross-dimensional reference table:** Populate a full breakdown by `{year × category × market}` rather than marginal totals, enabling exact filtering across all dimensions. Accurate but requires 5 × 3 × 5 = 75 entries and grows combinatorially if new dimensions are added.
- **Apps Script UrlFetch to BigQuery REST API:** Query BigQuery directly from Apps Script using a service account. Provides exact runtime queries but introduces OAuth credential management and significant complexity for a Sheets-native project.

**Why This Approach**

The hardcoded constants approach is fast (no I/O on `onEdit`), reliable (no dependency on DataSource load state), and transparent (the values are readable in the source and clearly attributed to BigQuery exports in the comment header). The trade-off — that a new year or dimension value requires a one-time constant update — is acceptable given the dataset's stable structure and the 5-year planning horizon.

---

## Decision 3 — Helper Table Architecture for Chart Data

**Problem**

The dashboard requires multiple embedded charts (annual trend, category breakdown, market breakdown, shipping mode split, performance table). Each chart must update automatically when filters change.

**Constraint**

Google Sheets embedded charts require a static, fixed cell range as their data source. Charts cannot reference formula outputs from multiple sheets, cannot reference computed values returned by Apps Script, and cannot be rebound to a different range at runtime without being deleted and recreated. The DataSource sheets are read-only and cannot be rearranged to produce filter-adjusted views.

**Solution**

Designate column N of the DASHBOARD sheet as a hidden intermediate layer — the "helper table" zone. Five fixed ranges are allocated:

| Table | Range    | Content |
|-------|----------|---------|
| HT1   | N2:P7    | Annual revenue + gross profit (by selected years) |
| HT2   | N10:O13  | Revenue by selected category |
| HT3   | N16:O21  | Revenue by selected market |
| HT4   | N24:O28  | Revenue by ship mode |
| Perf  | N31:T37  | Full annual performance matrix |

Each chart is permanently bound to its corresponding helper table range. On every `refreshAll()` call, Apps Script overwrites these ranges via `setValues()`. Charts update automatically because their data source ranges have changed, with no chart rebuild required. Row grouping hides column N from users, keeping the dashboard surface clean.

**Alternatives Considered**

- **Rebuild charts on every refresh:** Delete and recreate all charts using the Sheets Chart API on every `onEdit` event. Technically possible but slow (chart creation takes several seconds each), visually disruptive (charts flicker on rebuild), and risks quota exhaustion.
- **QUERY / FILTER formulas feeding chart ranges:** Use native Sheets formulas instead of Apps Script to populate the chart source ranges. Limited by the same DataSource read constraints and cannot incorporate the cross-sheet filter state.
- **Separate "staging" sheet for computed data:** Use a dedicated sheet instead of a hidden column. Functionally equivalent but adds a visible sheet tab to the workbook that users might accidentally edit or delete.

**Why This Approach**

The hidden helper table pattern cleanly separates concerns: the DataSource sheets own the raw data, the helper tables own the presentation-ready aggregates, and the charts own the visualisation. Placing helper tables in a hidden column on the same sheet as the charts keeps all DASHBOARD content co-located and makes the range bindings immediately legible. This pattern is also highly reusable — adding a new chart requires only allocating a new fixed range in column N and adding a `buildHT*` function.

---

## Decision 4 — Proportional Scaling for Category and Market Filtering

**Problem**

When a user selects a specific category (e.g., "Technology only") or market (e.g., "APAC + EU"), all KPI cards and charts must reflect totals for that subset of the data.

**Constraint**

The reference data tables (`REF_YEAR`, `REF_CAT`, `REF_MKT`) store marginal totals — each aggregated over all values of the other dimensions. There is no cross-dimensional breakdown (e.g., no per-year-per-category totals). This means there is no way to derive "revenue for Technology in 2025" directly from the constants. Injecting a runtime SQL filter into the Connected DataSource query is not supported by the Google Sheets API.

**Solution**

Compute a revenue proportion (scale factor) for each filtered dimension and apply it multiplicatively to the year-exact aggregate:

```javascript
// What share of total revenue comes from the selected categories?
catScale = sum(REF_CAT[c].rev for c in selectedCats) / TOTAL_REV

// What share of total revenue comes from the selected markets?
mktScale = sum(REF_MKT[m].rev for m in selectedMkts) / TOTAL_REV

// Apply both scales to the year-exact totals:
filteredRevenue = yearExactRevenue × catScale × mktScale
```

Year filtering remains exact — it iterates only over selected years from `REF_YEAR` and sums those rows precisely. The code comments in each `buildHT*` function explicitly document the filtering strategy per dimension:
```javascript
// Filtered by: Year (direct), Category & Market (proportional scale)
```

**Alternatives Considered**

- **Cross-dimensional reference table:** Populate a `REF_YEAR_CAT_MKT` object with all 5 × 3 × 5 = 75 combinations. Would enable exact filtering across all dimensions with no approximation. Requires more complex reference data maintenance and grows combinatorially if new dimensions are added.
- **Runtime BigQuery query via UrlFetch:** Call BigQuery's REST API from Apps Script to run a parameterised query at filter time. Provides exact results for any filter combination. Introduces service account credential management, network latency on every filter change (typically 1–3 seconds per query), and significant architectural complexity.
- **Native Sheets QUERY/FILTER formulas on DataSource data:** Use Sheets-native formulas to aggregate DataSource sheet data. This hits the same DataSource read limitations and cannot incorporate the filter state held in Controls/DASHBOARD cells without creating circular dependencies.

**Why This Approach**

Proportional scaling produces directionally accurate, immediately responsive results for the dashboard's intended use case: executive-level trend monitoring, YoY comparisons, and relative distribution across categories and markets. The scale factors are derived from the real dataset values — they are not guesses. When selecting "Technology only," the revenue estimate correctly reflects Technology's ~32% share of total revenue; when selecting "APAC + EU," the estimate reflects their combined ~46% share.

The approximation assumption — that the category/market revenue distribution is uniform across years — holds reasonably well for an established global business where category and market mix is relatively stable year-over-year. The approach is explicitly documented in code comments, making the approximation transparent to any future developer who inspects the implementation.

The decisive advantages over the alternatives are: zero network latency (all computation is in-memory JavaScript), no external credentials or API configuration, and a complete solution within the Google Workspace constraint. For a dashboard upgrade requiring exact cross-dimensional filtering, the cross-dimensional reference table approach would be the natural next iteration.

---

## Decision 5 — KPI Year-over-Year Comparison Design

**Problem**

KPI cards must communicate not just the current period's value, but whether performance is improving or declining relative to the prior period. Static placeholder text (`+0.0% versus 2023`) provided no real information and did not respond to filter changes.

**Constraint**

The comparison must work correctly across all filter states: single-year selection, multi-year selection, and "All Years." It must respect the same category and market filter context as the KPI value itself. The comparison period must be clear to the user without additional explanation.

**Solution**

`updateKPICards()` constructs a `prevFilters` object by decrementing each selected year by one, keeping category and market filters identical:

```javascript
var prevFilters = {
  years: filters.years.map(y => String(parseInt(y) - 1)),
  cats:  filters.cats,
  mkts:  filters.mkts
};
var prevKpis = buildKPIs(prevFilters);
```

The comparison period displayed in the UI (`vs 2024`) is derived from `max(selectedYears) - 1`, ensuring the label always matches the actual comparison data. Revenue, profit, and orders use percentage change; margin uses percentage-point delta (displayed as `%`, not `pts`). Positive values carry a `+` prefix. Format: `+13.0% vs 2024`.

**Alternatives Considered**

- **Fixed prior-year comparison (always vs. 2023):** Simple to implement but becomes misleading as the dataset extends into future years and as users filter to different periods.
- **Period-over-period vs. the dataset average:** Contextually useful but harder for executives to interpret without explanation.
- **Absolute value change (e.g., "+$380K vs 2024"):** Eliminates the need to know the baseline magnitude to interpret the change, but makes comparisons across KPIs of different scales (revenue vs. order count) visually inconsistent.
- **Sparkline-style trend indicator:** More visual but requires additional chart space and cannot be written as a simple cell value by Apps Script.

**Why This Approach**

Year-over-year percentage comparison is the dominant convention in executive financial reporting. It is immediately interpretable without context, scale-independent (a +13% revenue growth and a +13% order growth are directly comparable), and unambiguous about the reference period. Tying the comparison to the active filter ensures the comparison is always coherent with what the user is looking at.

---

## Decision 6 — Dual Control System with Bidirectional Synchronisation

**Problem**

Different user types interact with the dashboard in different ways. Some prefer inline controls embedded in the dashboard visual; others prefer a structured form on a separate sheet where they can see all filter settings at a glance. Supporting only one interaction style would exclude or inconvenience part of the user base.

**Constraint**

Google Sheets does not provide a native mechanism to keep two dropdown cells in sync — changing one does not automatically update the other. Both locations must produce the same `refreshAll()` outcome regardless of which was changed.

**Solution**

Maintain two sets of data-validated dropdown cells:

- **Controls sheet** (B2 = Year, B4 = Category, B6 = Market): a structured form interface
- **DASHBOARD sheet** (B6 = Year, B14 = Category, B20 = Market): inline controls

The `onEdit` trigger fires on edits to either sheet. `getFilters()` reads both locations, determines which was most recently changed (based on the event's sheet name), copies the changed value to the other location, and returns the unified filter state. Both sync operations complete before `refreshAll()` runs, so the dashboard always reflects a consistent filter state.

**Alternatives Considered**

- **Single control location (Controls sheet only):** Simpler to implement and reason about, but requires users to navigate away from the DASHBOARD to change filters — a poor experience for the most common use case.
- **Single control location (DASHBOARD only):** Removes the Controls sheet entirely. Appropriate if all users are comfortable with inline controls. Loses the structural clarity of a dedicated settings form.
- **Linked cell formulas (`=Controls!B2`):** Would display the Controls value on the DASHBOARD but would make the DASHBOARD cell read-only (formulas cannot be overwritten by a dropdown selection without breaking the formula).
- **Google Sheets Slicers:** Native Sheets slicers can filter data in tables and pivot tables but cannot trigger Apps Script refreshes and do not work with DataSource sheets in the way needed here.

**Why This Approach**

Bidirectional sync via the trigger layer is the only approach that keeps both surfaces genuinely interactive — either location can initiate a filter change and the other will follow. The implementation cost is modest: `getFilters()` reads from both locations and writes back to the location that was not edited, adding a single `setValue()` call to every refresh cycle. The user benefit — seamless filter interaction regardless of which surface they prefer — is substantial.

---

## Decision 7 — Installable onEdit Trigger vs. Simple onEdit Function

**Problem**

The dashboard needs to automatically refresh every time a user changes a filter dropdown. This requires detecting cell edits across multiple sheets and executing a multi-sheet read/write operation in response.

**Constraint**

Google Apps Script provides two types of edit detection:

- **Simple `onEdit` function:** Runs automatically on any cell edit but is constrained to a limited permission set. It cannot call services that require authorisation (including some SpreadsheetApp methods, UrlFetch, and external APIs). It runs as the current user but without OAuth scope grants.
- **Installable `onEdit` trigger:** Registered once via `ScriptApp.newTrigger()`. Runs with the full OAuth permissions of the user who installed it, including all SpreadsheetApp methods needed for cross-sheet reads and batch writes. Supports longer execution times.

**Solution**

Use an installable `onEdit` trigger registered by `installTrigger()`:

```javascript
function installTrigger() {
  ScriptApp.newTrigger('onEdit')
    .forSpreadsheet(SpreadsheetApp.getActive())
    .onEdit()
    .create();
}
```

`installTrigger()` is exposed as a custom menu item and as a runnable function in the Apps Script editor so it can be registered once by any authorised user. After installation, the trigger persists across sessions and fires on all subsequent edits.

**Alternatives Considered**

- **Simple `onEdit` function alone:** Lower permission set may cause silent failures on certain SpreadsheetApp calls. Cannot be guaranteed to execute `refreshAll()` reliably across all required API calls.
- **Time-driven trigger (e.g., every 1 minute):** Would refresh the dashboard on a schedule regardless of whether a filter was changed. Creates unnecessary API calls, adds latency between filter change and visual update, and provides a poor interactive experience.
- **Button-triggered refresh (manual only):** Use a drawn button on the DASHBOARD sheet linked to `runRefresh()`. Eliminates the trigger requirement entirely but forces users to click a button after every filter change — a significant UX regression for a dashboard designed for fast exploratory filtering.
- **`onChange` trigger:** Fires on structural changes (sheet insertions, etc.) in addition to cell edits. More events than needed and does not provide the cell reference needed to identify which filter was changed.

**Why This Approach**

An installable `onEdit` trigger is the correct tool for event-driven, permission-requiring, cell-edit-responsive automation in Google Apps Script. It provides automatic refresh on filter change (the primary UX requirement), runs with the necessary permissions for all SpreadsheetApp operations in `refreshAll()`, and requires only a single one-time registration step. The custom menu item makes trigger (re)installation accessible to users without requiring them to open the Apps Script editor.
