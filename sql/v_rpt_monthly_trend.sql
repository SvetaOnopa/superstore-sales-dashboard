-- =============================================================================
-- v_rpt_monthly_trend
-- BigQuery view: monthly time-series metrics
--
-- Aggregates to one row per year-month. Produces monthly and YTD revenue/profit,
-- order and customer counts, and month-over-month revenue growth. Used by the
-- annual trend chart and the monthly performance breakdown in the dashboard.
-- =============================================================================

CREATE OR REPLACE VIEW `plasma-origin-497414-f2.superstore_sales.v_rpt_monthly_trend` AS

WITH monthly AS (
  SELECT
    order_year,
    order_quarter,
    order_month,
    year_month,
    year_quarter,
    ROUND(SUM(sales), 2)                                                     AS monthly_revenue,
    ROUND(SUM(profit), 2)                                                    AS monthly_profit,
    ROUND(SAFE_DIVIDE(SUM(profit), SUM(sales)) * 100, 2)                    AS profit_margin_pct,
    COUNT(DISTINCT order_id)                                                 AS order_count,
    COUNT(DISTINCT customer_name)                                            AS unique_customers,
    SUM(quantity)                                                            AS units_sold,
    ROUND(SUM(shipping_cost), 2)                                            AS total_shipping_cost
  FROM `plasma-origin-497414-f2.superstore_sales.v_stg_superstore`
  GROUP BY order_year, order_quarter, order_month, year_month, year_quarter
)

SELECT
  order_year,
  order_quarter,
  order_month,
  year_month,
  year_quarter,
  monthly_revenue,
  monthly_profit,
  profit_margin_pct,
  order_count,
  unique_customers,
  units_sold,
  total_shipping_cost,

  -- YTD revenue resets every January
  ROUND(SUM(monthly_revenue) OVER (
    PARTITION BY order_year
    ORDER BY order_month
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  ), 2)                                                                      AS ytd_revenue,

  -- YTD profit resets every January
  ROUND(SUM(monthly_profit) OVER (
    PARTITION BY order_year
    ORDER BY order_month
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  ), 2)                                                                      AS ytd_profit,

  -- Month-over-month revenue growth (crosses year boundaries correctly)
  ROUND(SAFE_DIVIDE(
    monthly_revenue - LAG(monthly_revenue) OVER (ORDER BY order_year, order_month),
    LAG(monthly_revenue) OVER (ORDER BY order_year, order_month)
  ) * 100, 2)                                                                AS revenue_mom_pct

FROM monthly
ORDER BY order_year, order_month;
