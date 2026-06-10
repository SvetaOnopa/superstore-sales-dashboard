-- =============================================================================
-- v_rpt_market_geo
-- BigQuery view: revenue, margin, and shipping by market and geography
--
-- Aggregates to one row per year-market-region-country. Computes each market's
-- revenue share within its year, and includes shipping efficiency metrics
-- (cost percentage, average days to ship). Used by the market breakdown chart
-- and the geographic performance panel in the dashboard.
-- =============================================================================

CREATE OR REPLACE VIEW `plasma-origin-497414-f2.superstore_sales.v_rpt_market_geo` AS

SELECT
  order_year,
  market,
  region,
  country,
  ROUND(SUM(sales), 2)                                                       AS total_revenue,
  ROUND(SUM(profit), 2)                                                      AS total_profit,
  ROUND(SAFE_DIVIDE(SUM(profit), SUM(sales)) * 100, 2)                      AS profit_margin_pct,
  COUNT(DISTINCT order_id)                                                   AS order_count,
  COUNT(DISTINCT customer_name)                                              AS unique_customers,
  SUM(quantity)                                                              AS units_sold,
  ROUND(SUM(shipping_cost), 2)                                              AS total_shipping_cost,
  ROUND(SAFE_DIVIDE(SUM(shipping_cost), SUM(sales)) * 100, 2)              AS shipping_cost_pct,
  ROUND(AVG(days_to_ship), 1)                                               AS avg_days_to_ship,

  -- Each market's share of total revenue for that year
  ROUND(SAFE_DIVIDE(
    SUM(sales),
    SUM(SUM(sales)) OVER (PARTITION BY order_year)
  ) * 100, 2)                                                                AS revenue_share_pct

FROM `plasma-origin-497414-f2.superstore_sales.v_stg_superstore`
GROUP BY order_year, market, region, country
ORDER BY order_year, total_revenue DESC;
