# Interview Talking Points

This document helps you describe the Superstore Global Sales Executive Dashboard in interviews for Data Analyst, Analytics Engineer, BI Developer, and Business Intelligence roles.

---

## Elevator Pitch (30 seconds)

> "I built an executive sales dashboard using BigQuery, Google Sheets Connected DataSources, and Google Apps Script. The interesting part isn't the charts — it's the orchestration layer: an event-driven Apps Script that fires on every filter change, computes KPI aggregates in memory using pre-computed reference data, writes to hidden helper tables that drive the charts, and updates YoY comparison strings in real time. The whole thing runs inside Google Sheets with no external infrastructure."

---

## One-Sentence Version (for resume bullet or LinkedIn summary)

> "An automated executive sales dashboard built with BigQuery, Connected Sheets, and Apps Script, using helper tables, event-driven refresh, dynamic KPI cards, and filter-aware YoY calculations."

---

## Strongest Technical Aspects

### 1. Analytics Engineering at the SQL layer
Eight BigQuery views pre-aggregate data at exactly the right granularity for each dashboard panel. Window functions compute YoY growth, YTD totals, market revenue share, and margin health tiers — all in SQL before the data reaches the sheet. The Apps Script layer never touches raw row-level data.

### 2. Apps Script as an orchestration layer
The 1,203-line, 27-function script is not a set of macros. It is a proper orchestration layer with:
- A configuration object (`CFG`) eliminating all magic strings
- Hardcoded reference constants (`REF_YEAR`, `REF_CAT`, `REF_MKT`) derived from BigQuery exports
- Separated builder functions (`buildHT1`, `buildKPIs`, `buildPerfTable`) with explicit, documented filtering strategies
- A single entry point (`refreshAll`) called on every filter event

### 3. Helper table architecture
Charts in Google Sheets require static range references. Since the BigQuery DataSource sheets are read-only, I designed a hidden intermediate layer in column N of the dashboard sheet. Apps Script writes computed aggregates there on every refresh; the charts never need to be rebuilt. This is a clean separation of concerns: raw data → computed aggregates → visualisation.

### 4. Two filtering strategies, explicitly documented
Year filtering is exact (iterates over REF_YEAR directly). Category and market filtering uses proportional scaling — a deliberate, documented approximation appropriate for executive-level trend monitoring. Both strategies are explained in code comments and in the architecture decisions document. Knowing *when* an approximation is acceptable is an engineering judgment, not a shortcut.

### 5. Event-driven refresh with installable triggers
The dashboard uses an installable `onEdit` trigger (not a simple `onEdit` function) because it needs cross-sheet write permissions that the simple function cannot obtain. The distinction matters: it shows awareness of the Apps Script permission model, not just "I added an onEdit."

### 6. Bidirectional filter synchronisation
Two filter UIs (inline dashboard dropdowns + a separate Controls sheet) stay in sync on every edit. `getFilters()` reads both locations, identifies which was just changed, writes the value to the other, and returns a unified filter object. Either surface can initiate a filter change.

---

## Business Value

- **Zero manual work for the end user:** Filters respond instantly; no export/refresh buttons; no waiting.
- **Live data:** BigQuery views refresh automatically when the spreadsheet opens. No stale snapshots.
- **Executive-ready:** KPI cards show formatted values + YoY comparisons in the exact format used in financial reporting (`+13.0% vs 2024`). Margin uses percentage-point delta, not percentage change — a meaningful distinction for profitability analysis.
- **Portable:** Runs entirely within Google Workspace. No external infrastructure, no service accounts, no deployment pipeline.
- **5-year trend analysis:** Revenue, profit, margin, orders across APAC, EU, US, LATAM, Africa and three product categories — all filterable and comparable in seconds.

---

## Technical Challenges Solved

| Challenge | Root Cause | Solution |
|-----------|------------|----------|
| `getDataRange().getValues()` fails on DataSource sheets | Known Google Sheets Connected DataSource API limitation | Hardcoded reference constants derived from BigQuery exports — fast, reliable, transparent |
| Charts require static ranges; aggregated data changes with filters | Google Sheets chart architecture | Hidden helper tables in column N as permanent chart data sources, overwritten on each refresh |
| Category/market filters cannot query BigQuery at runtime | Connected DataSource SQL is fixed at connection time | Proportional scaling using marginal revenue fractions — documented and appropriate for executive use |
| Two filter UIs must stay in sync | Dual control surface design | Bidirectional sync in `getFilters()` on every `onEdit` event |
| `onEdit` permission limits | Simple triggers have restricted scope | Installable trigger with full OAuth permissions |
| KPI row showed static placeholder text | Cells were hardcoded in the sheet, not driven by script | Added YoY computation to `updateKPICards()`, writing formatted comparison strings on every refresh |

---

## Trade-offs and How to Explain Them

### Proportional scaling for category/market filters

**What it is:** When you filter by "Technology only," the KPI values are estimated by multiplying the year totals by Technology's share of overall revenue (~32%), not by querying BigQuery for exact Technology-only figures.

**When it works:** For an executive dashboard focused on relative trends, YoY growth, and distribution across segments, this is fit for purpose. The scale factors are derived from actual dataset values.

**Where it has limits:** If category/market revenue mix shifts dramatically year-over-year, the estimate diverges from exact filtered BigQuery values.

**How to explain professionally:** *"I made a deliberate trade-off between approximation accuracy and architectural complexity. The exact alternative — a cross-dimensional reference table with 75 entries, or a runtime BigQuery API call — was disproportionate to the precision needed for executive trend monitoring. I documented the approximation explicitly in code comments and in the architecture decisions doc, so any future developer understands the boundary."*

### Hardcoded reference data

**What it is:** Marginal totals for years, categories, and markets are baked into the Apps Script as JavaScript constants rather than read dynamically from the DataSource sheets.

**Trade-off:** Adding a new year or market requires a one-time constant update in the script.

**Why it's correct here:** The DataSource API makes runtime reads unreliable (no way to know if the sheet has loaded), and reading hundreds of rows on every filter change would exceed execution time limits. The dataset's 5-year planning horizon makes static constants reasonable.

---

## Resume Bullets

Pick 3–4 for your resume. Tailor to the role:

**For a Data/Analytics Engineer role:**
- Designed and deployed 8 BigQuery SQL reporting views using window functions (LAG, SUM OVER, SAFE_DIVIDE) to pre-aggregate executive KPIs, YoY growth rates, and margin health tiers at source.
- Implemented a Google Apps Script orchestration layer (27 functions, 1,203 lines) that responds to filter events, applies two-strategy aggregation logic, and writes computed results to a hidden helper table layer consumed by embedded charts.
- Documented platform constraints, architectural trade-offs, and design decisions across architecture, data flow, and technical implementation guides.

**For a BI Developer / Dashboard Developer role:**
- Built an executive sales dashboard (BigQuery → Connected Sheets → Apps Script → helper tables → dynamic charts) surfacing revenue, profit, margin, and YoY comparisons across 5 years, 5 markets, and 3 product categories.
- Engineered an event-driven refresh system using installable `onEdit` triggers and bidirectional filter synchronisation across two control surfaces.
- Designed a hidden helper table architecture enabling chart data to update dynamically without chart rebuilds, solving the static-range constraint of Google Sheets embedded charts.

**For a Data Analyst role:**
- Built an interactive executive sales dashboard in Google Sheets backed by BigQuery views and automated by Google Apps Script, enabling live YoY comparison filtering across markets and product categories.
- Implemented dynamic KPI cards with year-over-year percentage comparisons that respond to filter changes in real time, using Apps Script to compute and write formatted comparison strings (`+13.0% vs 2024`).

**Additional bullets (mix and match):**
- Implemented event-driven dashboard refresh using installable `onEdit` triggers and bidirectional filter synchronisation between inline dashboard controls and a dedicated Controls sheet.
- Documented platform constraints and architecture trade-offs, including proportional scaling approximation, Connected Sheets read limitations, and installable vs. simple trigger permission model.
- Designed a proportional scaling approach for cross-dimensional KPI filtering, balancing accuracy for executive use against complexity of a full cross-dimensional reference dataset.

---

## Anticipate These Interview Questions

**"Why not use Looker Studio / Power BI / Tableau?"**
> "Looker Studio was a real option. I chose Google Sheets because the team's workflow was entirely in Google Workspace, and I could add Apps Script automation — event-driven refresh, bidirectional filter sync, custom menu — that you can't do in a standalone BI tool. The constraint became an interesting engineering challenge."

**"How accurate is the filtering?"**
> "Year filtering is exact — I look up the year directly in hardcoded reference constants. Category and market filtering uses proportional scaling, which is an approximation. For executive trend monitoring — 'is APAC growing faster than EU this year?' — the approximation is fit for purpose. I documented the limitation explicitly and the code comments call it out on every function that uses it."

**"What would you do differently?"**
> "The next step up in accuracy would be a cross-dimensional reference table with one entry per year-category-market combination — 75 entries for the current dataset. That's a straight upgrade with no architectural change. The bigger upgrade would be adding a BigQuery API call via UrlFetch on filter change, which would give exact results but add latency and credential management. Both are documented in the architecture decisions doc."

**"How does it handle real-time data?"**
> "BigQuery views refresh when the spreadsheet opens via Connected DataSources. The Apps Script reference constants are static — they need updating if a new year is added. That's the documented trade-off for zero-latency in-memory computation."

**"What's the most technically interesting part?"**
> "The helper table architecture. Charts in Google Sheets need a fixed cell range as their data source — you can't point them at a computed value or a dynamic range. Since the BigQuery sheets are read-only, I created a hidden column on the dashboard sheet as an intermediate layer. Apps Script overwrites it on every filter change; the charts update automatically. It's a pattern that also generalises cleanly — adding a new chart is just allocating a new range in column N."

---

## Technical Stack Summary (for verbal answers)

> "BigQuery for the data warehouse — eight SQL views that pre-aggregate at the right granularity. Connected DataSources for the live link from BigQuery into Google Sheets — no ETL, no export, refreshes on file open. Google Apps Script for the orchestration layer — event-driven, fires on every filter change, computes aggregates in memory, writes to the dashboard. The charts are bound to hidden helper tables in the sheet, so they update automatically without being rebuilt."
