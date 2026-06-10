-- =============================================================================
-- v_rpt_discount
-- BigQuery view: profitability impact of discounting by tier
--
-- Aggregates to one row per year-discount_tier-category-sub_category. Computes
-- the loss rate (share of unprofitable line items) at each discount level, which
-- surfaces the profit-destroying effect of high discounts. Used by the discount
-- impact analysis panel in the dashboard.
-- =============================================================================

CREATE OR REPLACE VIEW `plasma-origin-497414-f2.superstore_sales.v_rpt_discount` AS

SELECT
  order_year,
  discount_tier,
  category,
  sub_category,
  COUNT(DISTINCT order_id)                                                   AS order_count,
  ROUND(SUM(sales), 2)                                                      AS total_revenue,
  ROUND(SUM(profit), 2)                                                     AS total_profit,
  ROUND(SAFE_DIVIDE(SUM(profit), SUM(sales)) * 100, 2)                     AS profit_margin_pct,
  ROUND(AVG(discount) * 100, 2)                                            AS avg_discount_pct,
  SUM(quantity)                                                             AS units_sold,
  ROUND(SAFE_DIVIDE(SUM(profit), COUNT(DISTINCT order_id)), 2)             AS avg_profit_per_order,

  -- Share of individual line items that are unprofitable at this discount level
  ROUND(SAFE_DIVIDE(COUNTIF(profit < 0), COUNT(*)) * 100, 2)              AS loss_rate_pct

FROM `plasma-origin-497414-f2.superstore_sales.v_stg_superstore`
GROUP BY order_year, discount_tier, category, sub_category
ORDER BY order_year, category, discount_tier;
