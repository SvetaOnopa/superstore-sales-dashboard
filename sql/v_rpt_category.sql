-- =============================================================================
-- v_rpt_category
-- BigQuery view: revenue and margin by category and sub-category
--
-- Aggregates to one row per year-category-sub_category. Computes revenue share
-- within year and within category, and assigns a margin health tier label used
-- for conditional formatting in Google Sheets. Used by the category breakdown
-- bar chart and the sub-category detail panel in the dashboard.
-- =============================================================================

CREATE OR REPLACE VIEW `plasma-origin-497414-f2.superstore_sales.v_rpt_category` AS

SELECT
  order_year,
  category,
  sub_category,
  ROUND(SUM(sales), 2)                                                       AS total_revenue,
  ROUND(SUM(profit), 2)                                                      AS total_profit,
  ROUND(SAFE_DIVIDE(SUM(profit), SUM(sales)) * 100, 2)                      AS profit_margin_pct,
  COUNT(DISTINCT order_id)                                                   AS order_count,
  SUM(quantity)                                                              AS units_sold,
  ROUND(AVG(discount) * 100, 2)                                             AS avg_discount_pct,

  -- Revenue share within year (sub-category vs. all sales that year)
  ROUND(SAFE_DIVIDE(
    SUM(sales),
    SUM(SUM(sales)) OVER (PARTITION BY order_year)
  ) * 100, 2)                                                                AS revenue_share_pct,

  -- Revenue share within category and year (sub-category mix within parent)
  ROUND(SAFE_DIVIDE(
    SUM(sales),
    SUM(SUM(sales)) OVER (PARTITION BY order_year, category)
  ) * 100, 2)                                                                AS category_revenue_share_pct,

  -- Margin health label for conditional formatting in Sheets
  CASE
    WHEN SAFE_DIVIDE(SUM(profit), SUM(sales)) >= 0.20 THEN 'High Margin'
    WHEN SAFE_DIVIDE(SUM(profit), SUM(sales)) >= 0.10 THEN 'Medium Margin'
    WHEN SAFE_DIVIDE(SUM(profit), SUM(sales)) >= 0    THEN 'Low Margin'
    ELSE                                                    'Loss-Making'
  END                                                                        AS margin_tier

FROM `plasma-origin-497414-f2.superstore_sales.v_stg_superstore`
GROUP BY order_year, category, sub_category
ORDER BY order_year, total_revenue DESC;
