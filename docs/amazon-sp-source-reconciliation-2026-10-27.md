# Amazon SP data: source rule and manual-report reconciliation (27 Oct 2026)

Covers the Historical Analysis Report for **23 Sep – 22 Oct 2026** (30 days) and **16 – 22 Oct 2026** (7 days),
the source-separation change in commit `6a4e63d`, and the comparison against the seller's manual
workbook `Amazon ad performance 23.09 - 22.10 (1).xlsx`.

## Source rule (user, 27 Oct 2026)

Only the **7-Day Ad Spend Report** may use the daily combined "Last 7 days" upload. Every other report
reads the dedicated Upload-page cards only:

| Data | Card | Table |
|---|---|---|
| Sponsored Products | Sponsored Products — Advertised Product report | `barm_amazon_sp_advertised_product` |
| Sponsored Brands | Sponsored Brands — Campaign report | `barm_amazon_sb_campaign` |
| Sponsored Display | Sponsored Display — Campaign report | `barm_amazon_sd_campaign` |

| Reader | Source after `6a4e63d` |
|---|---|
| 7-Day Ad Spend Report (app + Supabase function) | `barm_daily_am_ads`, plus SB/SD card rows for campaign-days the daily file lacks |
| Historical Analysis, Weekly Sales / Amazon Sales loader, live Analysis, weekly email | Card rows only (`amazonAdSourceRules.ts`) |
| High ACOS daily email | `barm_daily_am_ads` — kept on its daily workflow by decision; flagged for review |
| Overall page, Flipkart | Unchanged |

The combined upload no longer writes the SP, SB/SD or Amazon Orders card tables. Rows it wrote before the
change are still in those tables (660 SP rows, 9 SB rows for 23–25 Oct); every card reader skips them.
Deleting them is a separate production data change that needs a backup and approval.

## SP units: dashboard vs manual — NOT reconciled

| | Manual workbook | Dashboard (card data) |
|---|---|---|
| Advertised SKU Units, 30 days | 3,056 | 3,354 |
| Advertised SKU Units, 7 days | 728 | 790 |
| Total Units | sum of the SKU's Advertised SKU Units | same rule — differs only because Advertised SKU Units differs |

**The manual workbook's SP source is unavailable, so this gap cannot be resolved.** No calculation was
changed and no value was hard-coded to force a match. What was checked:

- The dashboard is an exact sum of the stored SP card rows (`7 Day Total Units`), and every stored row equals
  the raw Amazon line saved with it.
- No single Amazon column or rule over the stored rows gives 3,056 / 728 (`7 Day Total Units`,
  `7 Day Advertised SKU Units`, `7 Day Total Orders`, spend-only rows, the daily copy, and their combinations).
- 100+ earlier snapshots were rebuilt (every saved Ad Spend Report in Downloads and in Supabase Storage, and
  older Historical reports). For 18 campaign × SKU rows (30 days) and 13 rows (7 days) the manual value is
  **below the lowest value any snapshot ever recorded**, so no mix of stored data can produce it.
- The manual's unit cells are pasted values, not formulas, so the workbook does not say where they came from.

To close it, the raw Amazon file the manual pivot was built from is needed, or the manual must be rebuilt
from the same SP card file the dashboard holds.

### The SP card data the dashboard uses

Supabase stores the uploaded rows, not the file, and the Upload page keeps file names only in the browser
session — so the file name cannot be recovered. A scan of 439 spreadsheets saved on this PC since
20 Sep 2026 found no SP export covering this range. The data is identified by its fingerprint instead:

| Property | Value |
|---|---|
| Rows (Amazon "Date" column format = SP card) | 10,250 |
| Date range | 23 Sep – 22 Oct 2026 (the card upload deletes rows outside its file's range, so the last file covered exactly this) |
| Last written | 26 Oct 2026, 09:59:51 UTC (15:29 IST), with the SB and SD card uploads (09:59:42 / 09:59:54 UTC) |
| `7 Day Total Units` | 3,354 (30 days) / 790 (7 days) |
| Spend | ₹443,663.80 |

## Spend per SKU

Historical 30-day Spend+Tax, 23 Sep – 22 Oct:

| | Spend+Tax |
|---|---|
| Old dashboard (before `6a4e63d`) | ₹577,074.45 |
| New dashboard | ₹577,014.62 |
| Manual workbook | ₹577,010.28 |

Pre-tax, the new total is SP card ₹443,663.80 + SB card ₹42,094.23 + SD card ₹3,237.41 = ₹488,995.44, all of it
allocated to SKUs (₹0 unmapped).

**Old → new: −₹59.83** = the −₹50.70 pre-tax difference × 1.18. The old report counted the seller's per-SKU
split of Brand spend from the daily upload; the new one counts the SB card's figure for the same campaign-days.
Across the 90 split campaign-days the split totals ₹28,790.66 and the card ₹28,739.96:

| Campaign | Split − card (pre-tax) | Effect per mapped SKU (Spend+Tax) |
|---|---|---|
| Insemination kit-Brand ads- 7/3/2026 09:29:33.167 | ₹22.72 | −₹4.47 on each of its 6 SKUs |
| IR Therapy Lamp - Brand AD | ₹25.98 | −₹7.66 on each of its 4 SKUs |
| Chewy Tube - Brand ad | ₹2.00 | see below |
| All other split campaigns | ₹0.00 | — |

SKU-level changes old → new:

| SKUs | Change (Spend+Tax) | Why |
|---|---|---|
| B-CT-G-8, B-CT-G-9 | −₹285.33 each | Chewy Tube Brand spend now split equally over its 8 mapped SKUs (no weights → equal shares); the seller's split gave these two more |
| B-CT-R-1, B-CT-R-6, B-CT-R-7, B-CT-Y-1, B-CT-Y-3, B-CT-Y-6 | +₹94.72 each | Same equal split |
| B-SPEECH-COMBO-3HEADS / -1 | +₹26.01 / −₹26.01 | Flat Teether Display campaign now split 65/35 by the approved mapping; the old report used Amazon's 22 Oct SD lines (79/21). Net ₹0 |
| IR lamp SKUs (4) | −₹7.66 each | Card vs split rounding (table above) |
| Insemination kit SKUs (6) | −₹4.47 each | Card vs split rounding (table above) |

**New vs manual:** ₹4.34 apart in total. The manual already uses the card figure for the IR lamp and
insemination-kit Brand campaigns (both match the new report to the paisa). The remaining differences are
Chewy Tube (the manual uses its own uneven split: B-CT-G-8/-9 +₹381.33 each vs the new report, the other six
−₹127.11 each), Flat Teether (the manual keeps the 22 Oct split) and B-BULB-10.5-INSEM-PK5-1 (₹4.34, the same
in the old report — not caused by this change).

## Campaign-to-SKU mappings added (live, 27 Oct 2026)

19 rows in `barm_amazon_campaign_sku_map`, tagged `raw.source = "Display mapping 2026-10-27"` (delete rows with
that tag to roll back). All 18 Sponsored Display campaigns are now mapped; 0 duplicate campaign × SKU pairs.
Evidence: Amazon's own SD lines (100% of spend on one SKU) for 15 campaigns; Flat Teether 65/35 and
"Insemination kit-Dispaly ads" → B-INSEM-KIT-PK5-1 by user decision; the ₹3.68 campaign by the seller's own
split of 1 Oct 2026.
