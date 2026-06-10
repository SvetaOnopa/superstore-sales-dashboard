-- =============================================================================
-- v_rpt_shipping
-- BigQuery view: shipping mode analysis — cost, speed, and order share
--
-- Aggregates to one row per year-ship_mode-order_priority-market. Computes
-- delivery time statistics, shipping cost as a percentage of revenue, and each
-- ship mode's share of total orders for that year. Used by the shipping mode
-- split chart and the shipping efficiency panel in the dashboard.
-- =============================================================================

CREATE OR REPLACE VIEW `plasma-origin-497414-f2.superstore_sales.v_rpt_shipping` AS

SELECT
  order_year,
  ship_mode,
  order_priority,
  market,
  COUNT(DISTINCT order_id)                                                   AS order_count,
  ROUND(AVG(days_to_ship), 1)                                               AS avg_days_to_ship,
  MIN(days_to_ship)                                                         AS min_days_to_ship,
  MAX(days_to_ship)                                                         AS max_days_to_ship,
  ROUND(SUM(shipping_cost), 2)                                             AS total_shipping_cost,
  ROUND(AVG(shipping_cost), 2)                                             AS avg_shipping_cost_per_line,
  ROUND(SAFE_DIVIDE(SUM(shipping_cost), SUM(sales)) * 100, 2)             AS shipping_cost_pct_of_revenue,
  ROUND(SUM(sales), 2)                                                     AS total_revenue,
  ROUND(SUM(profit), 2)                                                    AS total_profit,

  -- This ship mode's share of all orders that year
  ROUND(SAFE_DIVIDE(
    COUNT(DISTINCT order_id),
    SUM(COUNT(DISTINCT order_id)) OVER (PARTITION BY order_year)
  ) * 100, 2)                                                               AS order_share_pct

FROM `plasma-origin-497414-f2.superstore_sales.v_stg_superstore`
GROUP BY order_year, ship_mode, order_priority, market
ORDER BY order_year, order_count DESC;
