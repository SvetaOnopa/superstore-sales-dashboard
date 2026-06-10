-- =============================================================================
-- v_rpt_exec_summary
-- BigQuery view: annual executive summary metrics
--
-- Aggregates order-level data to one row per year. Produces the headline KPIs
-- (revenue, profit, margin, orders, customers, avg order value) plus YoY growth
-- rates computed with LAG() window functions. This view is the primary source
-- for the KPI cards and annual performance table in the dashboard.
-- =============================================================================

CREATE OR REPLACE VIEW `plasma-origin-497414-f2.superstore_sales.v_rpt_exec_summary` AS

WITH annual AS (
  SELECT
    order_year,
    ROUND(SUM(sales), 2)                                                     AS total_revenue,
    ROUND(SUM(profit), 2)                                                    AS total_profit,
    ROUND(SAFE_DIVIDE(SUM(profit), SUM(sales)) * 100, 2)                    AS profit_margin_pct,
    COUNT(DISTINCT order_id)                                                 AS total_orders,
    COUNT(DISTINCT customer_name)                                            AS unique_customers,
    ROUND(SAFE_DIVIDE(SUM(sales),  COUNT(DISTINCT order_id)),    2)         AS avg_order_value,
    ROUND(SAFE_DIVIDE(SUM(sales),  COUNT(DISTINCT customer_name)), 2)       AS revenue_per_customer,
    ROUND(SUM(shipping_cost), 2)                                            AS total_shipping_cost,
    ROUND(SAFE_DIVIDE(SUM(shipping_cost), SUM(sales)) * 100, 2)            AS shipping_cost_pct,
    ROUND(AVG(discount) * 100, 2)                                           AS avg_discount_pct,
    SUM(quantity)                                                            AS total_units_sold
  FROM `plasma-origin-497414-f2.superstore_sales.v_stg_superstore`
  GROUP BY order_year
)

SELECT
  a.order_year,
  a.total_revenue,
  a.total_profit,
  a.profit_margin_pct,
  a.total_orders,
  a.unique_customers,
  a.avg_order_value,
  a.revenue_per_customer,
  a.total_shipping_cost,
  a.shipping_cost_pct,
  a.avg_discount_pct,
  a.total_units_sold,

  -- YoY growth rates (NULL for 2022 — first year, no prior year)
  ROUND(SAFE_DIVIDE(
    a.total_revenue - LAG(a.total_revenue) OVER (ORDER BY a.order_year),
    LAG(a.total_revenue) OVER (ORDER BY a.order_year)
  ) * 100, 2)                                                                AS revenue_yoy_pct,

  ROUND(SAFE_DIVIDE(
    a.total_profit - LAG(a.total_profit) OVER (ORDER BY a.order_year),
    LAG(a.total_profit) OVER (ORDER BY a.order_year)
  ) * 100, 2)                                                                AS profit_yoy_pct,

  ROUND(SAFE_DIVIDE(
    a.total_orders - LAG(a.total_orders) OVER (ORDER BY a.order_year),
    LAG(a.total_orders) OVER (ORDER BY a.order_year)
  ) * 100, 2)                                                                AS orders_yoy_pct,

  ROUND(SAFE_DIVIDE(
    a.unique_customers - LAG(a.unique_customers) OVER (ORDER BY a.order_year),
    LAG(a.unique_customers) OVER (ORDER BY a.order_year)
  ) * 100, 2)                                                                AS customers_yoy_pct

FROM annual a
ORDER BY a.order_year;
