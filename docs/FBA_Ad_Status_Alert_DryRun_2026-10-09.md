# FBA ad status alert — read-only dry run

Run 2026-10-09T06:59:43.374Z · slot B · SellerMate ledger 2026-10-07 · rule: alert if < 8 eligible FCs have stock, or 8+ do and any is ≤ 20 units.
No email sent, no alert state written. Prior state rows: 0 stock, 0 data-gap (so this is a first-run baseline).

## Summary

| | Excluding VSNC (as deployed) | Including VSNC (what-if) |
|---|---:|---:|
| SKUs in scope | 309 | 309 |
| Evaluated | 152 | 152 |
| **Passing** | **0** | **0** |
| Failing: fewer than 8 FCs have stock | 71 | 71 |
| Failing: 8+ FCs, one or more ≤ 20 units | 81 | 81 |
| Missing data (not evaluated) | 157 | 157 |
| Partial data (some eligible FCs with unknown units) | 0 | 0 |
| Would be mailed on first run (failures + data gaps) | 152 + 157 | 152 + 157 |

Out of scope: 379 merchant-fulfilled (MFN) SKUs with no FBA ledger rows.
Confirmed zero stock (evaluated, every eligible ledger row reads 0 or no eligible row): 37 SKUs.

## VSNC

VSNC appears in the SellerMate ledger with **1798 units across 35 SKUs** (as-of 2026-10-07). It is **not in FBA warehouse details.xlsx at all** (neither Yes nor No), so it is excluded. Eligibility needs to be confirmed by the warehouse team.

Including VSNC changes the verdict for **0** SKU(s):

SKUs holding stock at VSNC: B-INSEM-KIT-PK5-3 430, B-INSEM-KIT-PK2-1 280, B-OVU-CASSETTE-PK5-1 192, B-IR-THERMO-WT-1 95, B-INSEM-KIT-PK5-1 65, B-OT-DT12-6 64, A013-1 57, B-INSEM-12CM-KIT-PK2-1 43, B-INSEM-12CM-KIT-PK5-1 38, B-ST-SK-1 38, B-INSEM-15CM-KIT-PK5-1 35, A011-1 35, B-OT-DT12-3 34, A014-M-1 34, B-INS-KIT-17CM-SUP2-PK5-1 29, B-OVU-STRIPS-PK10-3 29, B-ST-POLYGLACTIN-1 26, B-ST-NY-1 24, B-OVU-STRIPS-PK5-1 22, B-ST-PP-1 21, B-ST-NY-M-2 20, A011-2 20, B-ST-NY-2 20, B-INSEM-15CM-KIT-PK2-1 19, SMPF-01-5 17, B-INS-KIT-17CM-SUP2-PK2-1 16, B-NEPREG-CB-1 15, NASCOOL-SUCSYS-6 15, B-ST-POLYGLYCOLIC-1 13, SMPF-01-6 12, NASCOOL-SUCSYS-4 10, A013-M-1 8, B-NEPREG-CB-1PK-3 8, NASCOOL-SUCSYS-7 7, B-OVU-STRIPS-PK20-3 7

## Ledger locations not eligible

| Location | In sheet? | Units | SKUs |
|---|---|---:|---:|
| VSNC | not listed | 1798 | 35 |
| DEL2 | No | 11 | 12 |

## Passing SKUs (0)

None.

## Failing — fewer than 8 FCs have stock (71)

| SKU | FCs with stock | Stock by FC | Confirmed 0 | No data |
|---|---:|---|---|---|
| A011-1 | 0 | — | — | — |
| A011-2 | 0 | — | — | — |
| A013-1 | 0 | — | — | — |
| A013-M-1 | 0 | — | — | — |
| A014-M-1 | 0 | — | — | — |
| B-BBYASP-E-ZLY-Bl-1 | 0 | — | — | — |
| B-INS-KIT-17CM-SUP2-PK2-1 | 0 | — | — | — |
| B-INS-KIT-17CM-SUP2-PK5-1 | 0 | — | — | — |
| B-INSEM-12CM-KIT-PK2-1 | 0 | — | — | — |
| B-INSEM-12CM-KIT-PK5-1 | 0 | — | — | — |
| B-INSEM-15CM-KIT-PK2-1 | 0 | — | — | — |
| B-INSEM-15CM-KIT-PK5-1 | 0 | — | — | — |
| B-INSEM-KIT-PK2-1 | 0 | — | — | — |
| B-INSEM-KIT-PK5-1 | 0 | — | — | — |
| B-INSEM-KIT-PK5-3 | 0 | — | — | — |
| B-IR-THERMO-WT-1 | 0 | — | — | — |
| B-NEPREG-CB-1 | 0 | — | — | — |
| B-NEPREG-CB-1PK-3 | 0 | — | — | — |
| B-OT-DT12-3 | 0 | — | — | — |
| B-OT-DT12-6 | 0 | — | — | — |
| B-OVU-CASSETTE-PK5-1 | 0 | — | — | — |
| B-OVU-STRIPS-PK10-3 | 0 | — | — | — |
| B-OVU-STRIPS-PK20-3 | 0 | — | — | — |
| B-OVU-STRIPS-PK5-1 | 0 | — | — | — |
| B-POC-IR-THERMO(WH)-1 | 0 | — | BLR8 | — |
| B-ST-NY-1 | 0 | — | — | — |
| B-ST-NY-2 | 0 | — | — | — |
| B-ST-NY-M-2 | 0 | — | — | — |
| B-ST-POLYGLACTIN-1 | 0 | — | — | — |
| B-ST-POLYGLYCOLIC-1 | 0 | — | — | — |
| B-ST-PP-1 | 0 | — | — | — |
| B-ST-SK-1 | 0 | — | — | — |
| NASCOOL-SUCSYS-4 | 0 | — | — | — |
| NASCOOL-SUCSYS-6 | 0 | — | — | — |
| NASCOOL-SUCSYS-7 | 0 | — | — | — |
| SMPF-01-5 | 0 | — | — | — |
| SMPF-01-6 | 0 | — | — | — |
| B-5FLANGE-INSERTS-1 | 1 | BOM7 1 | — | — |
| B-ANTICHOK-YEL&BLUE-2 | 1 | BOM7 1 | — | — |
| B-BRESHE-SNOW-1 | 1 | MAA4 1 | — | — |
| B-BULB-CATH-PK10-3 | 1 | BBX1 1 | — | — |
| B-FLANGE-FINDER-KIT-1 | 1 | BBX1 1 | — | — |
| B-MANUAL-BREAST-PUMP-3 | 1 | CJB1 1 | — | — |
| BSMRD-2 | 1 | PNQ3 1 | — | — |
| A016-3 | 1 | DEL4 2 | — | — |
| B-ORAL-TRAINER-5HEAD-3 | 1 | HYD8 2 | — | — |
| B-EPSOM-250G-1 | 1 | BLR7 4 | — | — |
| B-OVU-STRIPS-PK10-5 | 1 | BLR7 5 | BLR8 | — |
| SC-LACTO-STR-PK25 | 1 | DEL5 5 | — | — |
| B-ANTICHOK-AUTO-2 | 2 | BLR7 1, CCX1 1 | — | — |
| B-ORAL-TRAINER-4HEAD-4 | 2 | BLR7 3, DEL5 2 | — | — |
| B-INSEM-KIT-PK5-4 | 2 | BBX1 11, CJB1 1 | — | — |
| B-SPEECH-COMBO-3HEADS-1 | 2 | BLR7 14, GAX1 4 | — | — |
| B-EWBP-BASE-PK-1 | 3 | LKO1 2, GAX1 1, JPX2 1 | — | — |
| B-SILVER-NURCUP-L-1 | 3 | CCX1 2, BOM7 1, HYD3 1 | DED4 | — |
| B-SILVER-NURCUP-R-1 | 3 | BOM7 2, NAX1 2, BLR7 1 | — | — |
| B-SHTS-B-9 | 3 | BBX1 3, LKO1 2, CCX1 1 | — | — |
| B-VD-TPE-PK5-2 | 3 | AMD2 7, HYD8 1, LDX1 1 | — | — |
| B-POSTPARTUM-MINI-KIT-1 | 3 | JPX1 6, BBX1 4, DEL4 2 | — | — |
| B-JAW-TRAINER-CLIP-1 | 3 | AMD2 12, BOM5 10, PAX1 8 | — | — |
| B-DIGITAL-STETHOSCOPE-1 | 4 | AMD2 3, CCX1 3, DED4 3, NAX1 3 | ATX1, PAX1 | — |
| B-SUTPRAC-PAD-6 | 4 | LKO1 9, PAX1 8, BOM5 6, HYD8 2 | — | — |
| B-EYE-PATCH-PK20-1 | 5 | BBX1 5, PAX1 5, GAX1 2, AMD2 1, NAX1 1 | LKO1 | — |
| B-LACBRA-P-1 | 5 | BLR7 5, HYD3 5, MAA4 3, BOM5 1, CCX1 1 | — | — |
| B-EYE-PATCH-DK-PK10-1 | 5 | BOM5 8, JPX1 5, BBX1 4, AMD2 3, PNQ3 2 | — | — |
| B-BRE-ESSEN-KIT-2 | 6 | LDX1 5, DEL4 2, GAX1 2, HYD8 2, LKO1 2, CCX2 1 | — | — |
| B-SHTS-PK-3 | 6 | LKO1 5, BOM5 4, BLR7 3, CCX1 3, HYD8 3, CJB1 2 | — | — |
| B-EYE-PATCH-JUN-S-PK10-1 | 6 | BBX1 5, BOM5 5, CJB1 5, LDX1 5, MAA4 5, PAX1 5 | BLR8 | — |
| B-NASALSUC-RECHARGE-1 | 7 | LDX1 4, BBX1 3, GAX1 3, CJB1 2, MAA4 2, PAX1 2, LKO1 1 | — | — |
| A017-1 | 7 | CCX1 5, CJB1 5, DED4 5, GAX1 5, LKO1 5, MAA4 5, BLR7 4 | — | — |
| B-BT-B-PK2-1 | 7 | BBX1 5, BOM7 5, CCX1 5, HYD3 5, JPX2 5, NAX1 5, PNQ3 4 | — | — |

## Failing — 8+ FCs, one or more at 20 units or less (81)

| SKU | FCs with stock | Affected FCs (≤ 20) | No data |
|---|---:|---|---|
| B-PPBELT-GREEN-1 | 8 | AMD2 3, BLR7 3, BOM5 3, CCX1 3, DED4 3, LKO1 3, NAX1 3, MAA4 4 | — |
| B-CT-Y-BUMP-1 | 8 | LDX1 1, HYD8 2, DEL4 3, GAX1 3, LKO1 4, BBX1 5, BOM5 5, PAX1 5 | — |
| B-LACBRA-G-1 | 8 | CCX1 2, BBX1 3, NAX1 3, AMD2 5, BLR7 5, DED4 5, HYD3 5, MAA4 5 | — |
| B-CH-PS-Bl-3 | 9 | HYD8 1, CJB1 2, AMD2 3, BLR7 3, BOM5 3, CCX1 3, DED4 3, HYD3 3, MAA4 4 | — |
| B-PPBELT-GREY-1 | 9 | BLR7 2, AMD2 3, CCX1 3, CJB1 3, LKO1 3, MAA4 3, DEL5 4, BOM5 5, HYD3 5 | — |
| BSRMT-5 | 9 | HYD3 3, PNQ3 3, CCX1 4, DEL5 4, AMD2 5, BLR7 5, GAX1 5, LKO1 5, MAA4 5 | — |
| A018 | 9 | PNQ3 3, BLR7 5, CCX1 5, CJB1 5, DED4 5, GAX1 5, HYD3 5, LKO1 5, MAA4 5 | — |
| B-IQ-PZ-A-1 | 9 | AMD2 5, BBX1 5, CJB1 5, DEL4 5, HYD8 5, LDX1 5, LKO1 5, MAA4 5, PAX1 5 | — |
| B-PREG-SALT-400G-1 | 9 | MAA4 2, CJB1 3, LDX1 4, BBX1 5, DEL4 5, HYD8 5, LKO1 5, PAX1 5, BLR8 12 | — |
| B-FOAM-LINER-COMBO-3 | 9 | BOM5 1, BBX1 3, CJB1 7, LKO1 7, NAX1 7, MAA4 10, HYD3 12, PNQ3 13, DEL4 20 | — |
| B-EPSOM-400G-1 | 10 | BOM5 1, DEL5 1, GAX1 1, PNQ3 1, BBX1 2, CCX2 2, JPX2 2, NAX1 2, HYD8 3, LDX1 3 | — |
| B-EPSOM-900G-1 | 10 | BOM5 1, BOM7 1, CCX2 1, GAX1 1, MAA4 1, NAX1 2, LDX1 4, BLR8 5, BBX1 6, LKO1 10 | — |
| B-SITZ-SALT-400G-1 | 10 | DEL4 4, PAX1 4, BBX1 5, LKO1 6, GAX1 7, LDX1 15, MAA4 16, CJB1 18 | — |
| B-ARTI-SPOON-1 | 11 | BOM5 1, DEL4 1, LKO1 2, NAX1 2, BLR7 3, CJB1 3, GAX1 3, JPX2 3, MAA4 3, HYD8 4, CCX1 5 | — |
| B-SHTS-BLK-7 | 11 | BLR8 1, MAA4 2, CCX1 3, CCX2 3, DEL4 4, AMD2 5, GAX1 5, LDX1 5, LKO1 5, BOM5 6, PNQ3 6 | — |
| B-IR-LP-200-1 | 11 | ATX1 1, BOM7 1, DED4 1, GAX1 2, JPX1 2, AMD2 4, BBX1 4, CCX2 7, HYD3 7, PAX1 7, NAX1 10 | — |
| B-CH-PS-P-4 | 11 | LKO1 1, LDX1 2, AMD2 3, BBX1 3, BLR8 3, GAX1 3, PAX1 4, BOM5 8, CJB1 8, DEL4 8, MAA4 8 | — |
| B-CT-R-BUMP-1 | 11 | DEL4 3, LDX1 3, BBX1 5, BLR8 5, BOM5 5, CJB1 5, GAX1 5, HYD8 5, LKO1 5, MAA4 5, PAX1 5 | — |
| A004-4 | 11 | DEL4 1, BOM5 2, CCX1 2, MAA4 2, BOM7 3, BBX1 8, LKO1 11, GAX1 13, AMD2 15, NAX1 20 | — |
| B-NEEMWOOD-COMB-1 | 11 | GAX1 2, HYD8 2, LDX1 2, CCX2 3, PAX1 4, MAA4 8, BBX1 9, CJB1 10, LKO1 15 | — |
| B-SUTPRAC-PAD-5 | 11 | BOM5 1, CJB1 2, AMD2 3, PAX1 5, CCX1 7, LKO1 12, HYD8 15, BLR8 17, BBX1 18, CCX2 18, MAA4 18 | — |
| B-NCD-L2202-A-3 | 11 | MAA4 3, DED4 4, JPX2 4, CJB1 5, AMD2 10, GAX1 11, NAX1 12, HYD3 18, BLR8 19, ATX1 20, LKO1 20 | — |
| A002-2 | 12 | HYD3 1, ATX1 2, BLR7 2, CCX2 3, BBX1 4, BLR8 5, HYD8 5, LKO1 5, NAX1 5, AMD2 7, CJB1 17, MAA4 19 | — |
| B-INST-BW-Bl-3 | 12 | CCX1 1, HYD8 1, LDX1 1, MAA4 1, NAX1 1, BBX1 3, CCX2 3, GAX1 5, LKO1 6, DED4 8 | — |
| B-CT-G-BUMP-1 | 12 | AMD2 1, BLR8 1, CCX1 1, BBX1 5, BLR7 16 | — |
| B-ICEMAXI-PADSICLES-1 | 13 | AMD2 1, BLR7 1, GAX1 2, BOM5 3, ATX1 4, DEL4 5, HYD3 6, PNQ3 7, CCX1 8, LKO1 8, BBX1 10, JPX1 10, NAX1 10 | — |
| B-EYE-PATCH-PK10-1 | 13 | PNQ3 1, BOM7 2, MAA4 3, BLR7 5, JPX2 7, AMD2 8, CCX2 8, GAX1 8, HYD3 8, LKO1 8, NAX1 8, BBX1 10, PAX1 10 | — |
| B-CH-PS-Y-3 | 14 | BOM7 1, CCX1 2, HYD8 2, AMD2 3, ATX1 3, BBX1 3, BLR8 3, DED4 3, GAX1 3, LKO1 3, MAA4 3, NAX1 3, PAX1 3, JPX1 4 | — |
| B-ERMT-DM-3 | 14 | BLR7 1, GAX1 1, AMD2 3, ATX1 3, BBX1 3, BOM5 3, CCX2 3, DEL4 3, HYD3 3, JPX1 3, LKO1 3, NAX1 3, DED4 5, PAX1 6 | — |
| B-VD-PLAS-TPE-1 | 14 | DEL4 1, HYD3 1, PNQ3 1, BLR8 3, HYD8 3, CCX2 4, JPX2 4, AMD2 5, BBX1 5, GAX1 5, NAX1 5, PAX1 5, LKO1 7, MAA4 7 | — |
| B-TEETHTUBE-GYR-1 | 14 | BLR7 1, JPX2 1, BOM5 2, BOM7 2, AMD2 3, BBX1 4, LDX1 4, PAX1 5, CJB1 6, GAX1 6, MAA4 6, NAX1 6, BLR8 9, HYD3 9 | — |
| B-CH-PS-B-2 | 14 | PNQ3 1, DEL5 2, GAX1 3, HYD8 3, MAA4 4, AMD2 8, LDX1 8, PAX1 9, BBX1 10, BOM7 12, CCX2 15, BLR8 17, BOM5 17 | — |
| A001-5 | 14 | ATX1 1, GAX1 2, AMD2 5, JPX1 6, NAX1 8, BOM5 9, LKO1 10, BBX1 11, DEL4 13, CJB1 16, PNQ3 16, HYD3 17 | — |
| B-CT-Y-6 | 14 | DEL5 2, PNQ3 6, BLR7 16, MAA4 16, LDX1 17, AMD2 18 | — |
| B-HRC-PK2-1 | 15 | BLR7 2, AMD2 3, ATX1 3, BBX1 3, BOM5 3, CCX1 3, DED4 3, GAX1 3, HYD3 3, JPX1 3, LKO1 3, MAA4 3, NAX1 3, PAX1 3, PNQ3 3 | — |
| B-CSECTION-KIT-15PCS-3 | 15 | HYD8 1, PNQ3 1, AMD2 2, CCX1 2, LDX1 2, BBX1 3, BOM7 3, JPX2 3, NAX1 3, PAX1 3, GAX1 4, CJB1 5, DEL4 5, LKO1 5, MAA4 5 | — |
| B-SHTS-PK-1 | 15 | DEL4 1, LDX1 2, MAA4 2, NAX1 2, DEL5 3, HYD8 3, JPX1 3, JPX2 3, LKO1 3, CJB1 4, GAX1 4, BLR7 5, CCX1 5, BOM5 6, HYD3 8 | — |
| B-ORAL-TRAINER-3HEAD-1 | 15 | CJB1 1, DED4 3, HYD3 3, JPX2 3, AMD2 4, BOM5 4, GAX1 4, PNQ3 4, BBX1 5, CCX1 5, NAX1 5, PAX1 5, LKO1 9, ATX1 10, BLR8 14 | — |
| B-CT-G-PK2-1 | 15 | JPX2 2, MAA4 2, AMD2 4, CCX1 4, DEL5 4, PAX1 4, NAX1 5, PNQ3 5, GAX1 6, BOM7 8, LDX1 8, BBX1 10, HYD3 11, LKO1 14, BLR8 19 | — |
| B-MENO-STRIPS-PK4-1 | 15 | BBX1 3, GAX1 3, PNQ3 3, PAX1 4, CCX1 5, CCX2 5, JPX1 5, AMD2 6, NAX1 6, HYD3 7, BLR8 9, DEL5 9, LDX1 11, BOM7 14, LKO1 16 | — |
| B-IQ-PZ-1 | 15 | CCX1 1, DEL4 1, PAX1 1, NAX1 3, BBX1 4, LDX1 4, GAX1 5, JPX1 5, LKO1 5, AMD2 7, HYD8 8, MAA4 10, BOM7 11, CJB1 11 | — |
| B-SENFDT-L-3 | 15 | CCX1 1, CJB1 3, LDX1 3, DED4 4, AMD2 5, BBX1 5, CCX2 5, GAX1 5, JPX1 5, NAX1 6, LKO1 7, BLR8 11, PAX1 11, HYD3 18 | — |
| B-JAWBITE-PK1-1 | 15 | ATX1 2, BLR8 3, GAX1 4, PAX1 7, CJB1 8, HYD3 10, BBX1 12, LDX1 12, CCX2 14, MAA4 19, BOM5 20 | — |
| B-MALE-FERTILITY-KIT-5 | 15 | JPX1 1, HYD8 2, MAA4 3, CJB1 5, GAX1 5, AMD2 7, BLR7 9, BOM5 10, ATX1 13, PAX1 14, BBX1 19, NAX1 20 | — |
| B-CH-PS-P-3 | 16 | BOM5 2, CCX1 2, DEL4 2, HYD8 2, AMD2 3, ATX1 3, BBX1 3, BLR8 3, DED4 3, GAX1 3, HYD3 3, JPX1 3, LKO1 3, MAA4 3, NAX1 3, PAX1 3 | — |
| B-HRC-PK1-1 | 16 | AMD2 3, ATX1 3, BBX1 3, BLR7 3, BOM5 3, CCX1 3, CJB1 3, DED4 3, GAX1 3, HYD3 3, JPX1 3, LKO1 3, MAA4 3, NAX1 3, PAX1 3, PNQ3 3 | — |
| B-HRC-PK3-1 | 16 | AMD2 3, ATX1 3, BBX1 3, BLR7 3, BOM5 3, CCX1 3, CJB1 3, DED4 3, GAX1 3, HYD3 3, JPX1 3, LKO1 3, MAA4 3, NAX1 3, PAX1 3, PNQ3 3 | — |
| B-HRC-PK4-1 | 16 | AMD2 3, ATX1 3, BBX1 3, BLR7 3, BOM5 3, CCX1 3, CJB1 3, DED4 3, GAX1 3, HYD3 3, JPX1 3, LKO1 3, MAA4 3, NAX1 3, PAX1 3, PNQ3 3 | — |
| B-HRC-PK5-1 | 16 | AMD2 3, ATX1 3, BBX1 3, BLR7 3, BOM5 3, CCX1 3, CJB1 3, DED4 3, GAX1 3, HYD3 3, JPX1 3, LKO1 3, MAA4 3, NAX1 3, PAX1 3, PNQ3 3 | — |
| B-HRC-PK2-MOQ2-1 | 16 | AMD2 3, ATX1 3, BBX1 3, BOM5 3, CCX1 3, CJB1 3, DED4 3, GAX1 3, HYD3 3, JPX1 3, LKO1 3, MAA4 3, NAX1 3, PAX1 3, PNQ3 3, BLR7 4 | — |
| B-CT-G-R-1 | 16 | BOM5 1, DEL5 1, HYD8 1, CJB1 2, BBX1 3, BOM7 4, NAX1 4, AMD2 5, BLR7 5, CCX2 5, GAX1 5, JPX2 5, LDX1 5, PAX1 5, LKO1 7, MAA4 13 | — |
| B-JAWBITE-PK2-3 | 16 | BOM7 1, HYD3 1, HYD8 1, GAX1 3, PNQ3 3, ATX1 4, BOM5 4, DED4 4, LKO1 4, MAA4 4, BBX1 5, CCX1 5, PAX1 5, JPX1 6, NAX1 7, AMD2 16 | — |
| B-CRACKNIP-SPRAY-100ML-1 | 16 | JPX2 1, NAX1 1, BLR8 2, CCX2 2, AMD2 3, BOM5 3, LDX1 3, LKO1 3, PAX1 3, PNQ3 4, BBX1 5, CJB1 6, GAX1 7, MAA4 7, HYD3 12, DEL5 13 | — |
| B-CT-B-1 | 16 | PNQ3 3, BBX1 4, GAX1 4, PAX1 4, DEL4 5, LDX1 5, BLR8 7, MAA4 8, NAX1 8, CCX2 9, CJB1 10, AMD2 12, BOM7 16, DED4 17 | — |
| B-MRD-WT-2 | 16 | CCX1 3, JPX1 8, CJB1 9, LDX1 9, MAA4 9, BBX1 10, GAX1 11, AMD2 14, PAX1 15, BOM7 18, CCX2 19, DED4 19, NAX1 20 | — |
| B-SENFDT-5 | 17 | CCX1 1, PNQ3 1, ATX1 3, BLR7 3, BOM5 3, CCX2 3, DEL4 3, LDX1 3, GAX1 4, HYD8 4, MAA4 4, AMD2 5, BBX1 5, JPX1 5, PAX1 5, LKO1 6, NAX1 12 | — |
| B-IBHEAL-4 | 17 | MAA4 2, PNQ3 2, BBX1 3, AMD2 4, BOM7 4, CJB1 4, JPX2 4, LKO1 4, PAX1 4, LDX1 5, NAX1 5, CCX1 7, GAX1 7, DEL4 8, HYD3 8, BLR8 14, DED4 16 | — |
| B-CH-PS-Iv-4 | 17 | LDX1 1, ATX1 2, CCX2 2, CJB1 3, DED4 3, AMD2 4, BLR8 5, JPX1 5, BBX1 6, BLR7 7, GAX1 7, HYD3 7, MAA4 7, PAX1 8, BOM7 11, LKO1 16 | — |
| A010 | 17 | PNQ3 1, JPX2 2, AMD2 4, CCX2 4, DEL4 4, ATX1 5, HYD3 5, CJB1 7, NAX1 7, PAX1 7, BBX1 9, HYD8 10, BOM5 11, GAX1 11, MAA4 16 | — |
| BRmtz | 17 | CCX1 2, DEL5 2, BOM5 4, CCX2 4, JPX1 4, NAX1 4, PAX1 5, GAX1 8, LKO1 8, CJB1 10, MAA4 10, HYD3 11, BBX1 12, BOM7 12, LDX1 12, BLR8 17 | — |
| B-SENFDT-1 | 17 | BLR8 1, CJB1 7, GAX1 8, PAX1 8, PNQ3 9, AMD2 10, CCX2 10, JPX1 10, BOM5 11, LDX1 12, BBX1 15, NAX1 15, DEL4 16, BLR7 20 | — |
| B-BULB-10.5-INSEM-PK2-1 | 17 | CCX1 4, BBX1 6, BOM7 6, HYD3 8, JPX1 8, ATX1 10, CCX2 15, BOM5 16, GAX1 18, NAX1 20 | — |
| B-CONCEP-CUP-1 | 18 | BOM7 2, HYD3 2, DED4 3, PAX1 3, BOM5 4, CCX2 4, LDX1 4, GAX1 5, CCX1 6, JPX1 6, NAX1 6, BBX1 7, DEL4 10, HYD8 10, MAA4 13, LKO1 15, CJB1 17, BLR8 20 | — |
| B-BIDET-ATTACHMENT-1 | 18 | BOM7 3, ATX1 4, BLR7 6, HYD3 6, AMD2 8, CJB1 8, CCX2 9, JPX2 9, NAX1 9, BBX1 10, BOM5 10, GAX1 10, PAX1 10, PNQ3 10, DEL4 11, BLR8 12, MAA4 13, LKO1 15 | — |
| B-HYDRO-PAD-PK4-1 | 18 | JPX2 1, JPX1 3, LDX1 3, BBX1 4, CCX1 4, GAX1 5, NAX1 6, HYD3 7, BLR7 10, PAX1 10, DEL5 13, PNQ3 15, BOM7 16, BLR8 20, LKO1 20 | — |
| B-TB-G | 18 | AMD2 3, HYD3 4, MAA4 4, PAX1 5, PNQ3 5, JPX1 7, GAX1 8, NAX1 9, ATX1 13, BOM7 13, BBX1 16, CJB1 17, DEL4 17, BOM5 18, HYD8 19, BLR7 20 | — |
| B-CT-R-1 | 18 | ATX1 1, BOM7 2, NAX1 2, BLR8 3, CJB1 5, LKO1 6, LDX1 7, CCX2 8, AMD2 9, PAX1 11, BBX1 14, GAX1 14, DEL4 16, MAA4 19 | — |
| A006-2 | 18 | ATX1 2, LKO1 3, BBX1 4, NAX1 5, CJB1 6, CCX2 10, LDX1 11, AMD2 15, PNQ3 16, BOM5 17, DEL5 17, GAX1 17, JPX1 19, PAX1 20 | — |
| B-HYDRO-PAD-PK2-3 | 18 | BLR8 2, AMD2 5, BBX1 5, CCX2 8, GAX1 8, JPX1 10, NAX1 12, PAX1 12, LDX1 16, CCX1 18, PNQ3 19 | — |
| B-BBYASP-E-ZLY-Y-1 | 19 | JPX1 1, HYD8 2, MAA4 2, CJB1 3, HYD3 3, JPX2 3, BLR7 4, GAX1 4, AMD2 5, ATX1 5, BBX1 5, PAX1 5, NAX1 7, PNQ3 10, BOM5 12, CCX1 13, LKO1 16, BLR8 17 | — |
| B-TONGUE-TIP-3PC-1 | 19 | CJB1 3, BBX1 5, JPX2 5, PNQ3 10, PAX1 14, DED4 15, GAX1 15, BOM7 16, MAA4 18 | — |
| B-BULB-10.5-INSEM-PK5-1 | 19 | GAX1 7, LDX1 7, CCX1 16, ATX1 17, BBX1 18, NAX1 19 | — |
| B-PERI-WAND-MAS-1 | 20 | BOM7 2, HYD3 2, JPX2 2, ATX1 3, BLR7 3, JPX1 3, LDX1 3, NAX1 4, AMD2 5, BBX1 5, CCX1 5, LKO1 5, PAX1 5, PNQ3 5, BLR8 7, DEL5 7, BOM5 8, MAA4 8, CJB1 9, GAX1 10 | — |
| B-BT-B1-1 | 20 | AMD2 1, BLR8 1, JPX2 1, MAA4 4, BBX1 5, DEL5 5, BOM5 6, DEL4 7, JPX1 7, PAX1 7, PNQ3 8, BLR7 11, CCX1 12, GAX1 12, HYD8 12, NAX1 13, LKO1 14, CJB1 15, ATX1 18 | — |
| A005-1 | 20 | BOM5 1, DEL5 1, ATX1 2, DED4 2, GAX1 4, HYD3 6, LDX1 8, BBX1 9, PAX1 10, CJB1 11, DEL4 11, MAA4 12, LKO1 13, BLR8 15, PNQ3 15, CCX1 17, NAX1 18 | — |
| B-CT-G-8 | 21 | HYD8 1, BOM5 3, JPX2 3, JPX1 5, ATX1 7, BOM7 8, NAX1 8, AMD2 10, BBX1 13, GAX1 13, CCX1 14, CCX2 15, DED4 16, LDX1 19, DEL5 20 | — |
| A003-9 | 21 | DED4 1, HYD3 5, DEL4 6, PAX1 6, CCX1 9, PNQ3 11, LDX1 14, BBX1 15, DEL5 16, AMD2 18, BLR8 18, NAX1 19 | — |
| A019-14 | 21 | BLR7 1, GAX1 1, LKO1 1, HYD8 2, JPX1 5, JPX2 6, DEL4 7, PAX1 12, CJB1 13, BBX1 18 | — |
| B-CT-G-1 | 21 | LDX1 13, NAX1 13, JPX1 14, BBX1 15, GAX1 17 | — |
| B-SENBR-1 | 22 | BLR8 1, CCX2 1, BOM7 7, JPX1 20 | — |
| A015 | 23 | BOM7 1, CJB1 1, DED4 1, PNQ3 7, BLR7 9, GAX1 9, NAX1 12, AMD2 13, HYD3 13, LDX1 13 | — |

## Data-quality warnings — missing SellerMate data (157)

| SKU | ASIN | Channel | Detail |
|---|---|---|---|
| SCG-B-1 | B0C4NS517J | FBA | no FBA ledger rows |
| B-SENBR-2 | B0DDTTPKJ3 | FBA | no FBA ledger rows |
| GS-BARE | B0C14SBTW2 | FBA | no FBA ledger rows |
| SCGSB1-1 | B0C77GTLTB | FBA | no FBA ledger rows |
| A015-1 | B0CXJ4BQN1 | FBA | no FBA ledger rows |
| A015-2 | B0CXJ4BQN1 | FBA | no FBA ledger rows |
| A019-15 | B0D6KNHZQW | FBA | no FBA ledger rows |
| B-BULB-CATH-PK4-3 | B0GG3JCVZG | FBA | no FBA ledger rows |
| B-CT-Y-3 | B0CMH9CH9S | FBA | no FBA ledger rows |
| A004-3 | B0CZTM3GCF | FBA | no FBA ledger rows |
| A004-5 | B0CZTM3GCF | FBA | no FBA ledger rows |
| A019-11 | B0D3TFTJNB | FBA | no FBA ledger rows |
| B-TB-G-2 | B0DBD7NDH4 | FBA | no FBA ledger rows |
| B-TB-G-3 | B0DBD7NDH4 | FBA | no FBA ledger rows |
| B-CT-R-7 | B0CWG8DHVQ | FBA | no FBA ledger rows |
| B-CT-G-6 | B0CVMQF8H8 | FBA | no FBA ledger rows |
| B-RMT-SPORTS-US | B0FFB6MFJT | FBA | no FBA ledger rows |
| SCG-100S100L-2 | B0CY88QGHG | FBA | no FBA ledger rows |
| SCG-100S100L-4 | B0CY88QGHG | FBA | no FBA ledger rows |
| B-BBYASP-E-ZLY-Y-2 | B0DGXFDL8Y | FBA | no FBA ledger rows |
| B-CH-PS-Iv-3 | B0D5VG7S5H | FBA | no FBA ledger rows |
| A002 | B0D6G26L4Q | FBA | no FBA ledger rows |
| A002-1 | B0D6G26L4Q | FBA | no FBA ledger rows |
| B-FAT-L1E-3 | B0CM12PK99 | FBA | no FBA ledger rows |
| B-REF-THERMO-1 | B0FPRG2D32 | FBA | no FBA ledger rows |
| B-CT-Y-8 | B0HD6B2DHF | FBA | no FBA ledger rows |
| M-IQ-PZ-A-1 | B0DNPZ58FP | FBA | no FBA ledger rows |
| SC25 | B0CB43HLX7 | FBA | no FBA ledger rows |
| SC50 | B0CB42N5F1 | FBA | no FBA ledger rows |
| SC-GLUCO-50S25L-4 | B0GTF86JH3 | FBA | no FBA ledger rows |
| B-CH-PS-Y-2 | B0D9W52PG1 | FBA | no FBA ledger rows |
| B-CH-PS-Bl-2 | B0DB26F3FC | FBA | no FBA ledger rows |
| GLUCO-STRIPS-PK100-1 | B0CLS4JGNG | FBA | no FBA ledger rows |
| SCGS25SL-2 | B0C617K38T | FBA | no FBA ledger rows |
| B-BBYASP-SYR-PK4-1 | B0DYDV5KCZ | FBA | no FBA ledger rows |
| GS10S10L | B0C6179J5D | FBA | no FBA ledger rows |
| GS10S10L-5 | B0GT9W585R | FBA | no FBA ledger rows |
| B-ST-SK-2-0-30MM-1 | B0FWCPMY6D | FBA | no FBA ledger rows |
| B-ST-PP-4-0-30MM-1 | B0FXMPC3JX | FBA | no FBA ledger rows |
| GLUCO-STRIPS-PK150-1 | B0H5QXNKCV | FBA | no FBA ledger rows |
| GS50S50L-5 | B0GTF1XPYJ | FBA | no FBA ledger rows |
| B-ST-NY-2-0-30MM-1 | B0FW4NC1C7 | FBA | no FBA ledger rows |
| B-ST-PP-2-0-30MM-1 | B0FXMCFDPK | FBA | no FBA ledger rows |
| B-ST-SK-4-0-30MM-1 | B0FXLTW713 | FBA | no FBA ledger rows |
| BRmtz-8 | B0DJVK5J7F | FBA | no FBA ledger rows |
| B-ST-NY-4-0-30MM-1 | B0FWBYYGR2 | FBA | no FBA ledger rows |
| B-SENFDT-L-5 | B0GG4T9G7H | FBA | no FBA ledger rows |
| B-CT-B-2 | B0CZHR9FMT | FBA | no FBA ledger rows |
| SC-LACTO-25S25L-4 | B0D39NVV9C | FBA | no FBA ledger rows |
| SC-LACTO-25S25L-6 | B0F143NFQL | FBA | no FBA ledger rows |
| B-BBYASP-SYR-3 | B0D4YFQFTH | FBA | no FBA ledger rows |
| B-BBYASP-SYR-PK2-1 | B0F24S98DD | FBA | no FBA ledger rows |
| B-MESHNEB-3MODES-1 | B0F9PCG89J | FBA | no FBA ledger rows |
| B-SUTPRAC-KIT-2 | B0CKBN22BK | FBA | no FBA ledger rows |
| B-SUTPRAC-KIT-5 | B0GJDDCCQ5 | FBA | no FBA ledger rows |
| B-LIPTRAINER-G-1 | B0F8ZWFK76 | FBA | no FBA ledger rows |
| B-UTI-3PARA-PK3-1 | B0H2DYZCVK | FBA | no FBA ledger rows |
| B-IBHEAL-2 | B0CJY2J839 | FBA | no FBA ledger rows |
| B-SUTPRAC-KIT-3TOOL-1 | B0DVTCBGMS | FBA | no FBA ledger rows |
| B-SUTPRAC-KIT-3TOOL-4 | B0GJ6FM6W2 | FBA | no FBA ledger rows |
| B-ST-SK-M-1 | B0D7HYNXDZ | FBA | no FBA ledger rows |
| B-PFM-BLW-MEM-1 | B0GTM9QD7H | FBA | no FBA ledger rows |
| MT-IV-PK25-3 | B0CHM848SS | FBA | no FBA ledger rows |
| SC-LACTO-STR-PK50-1 | B0D2DFQPS1 | FBA | no FBA ledger rows |
| BSRMT-4 | B0D31SS4DC | FBA | no FBA ledger rows |
| B-SPEECH-COMBO-5HEADS-1 | B0GV3SBS2F | FBA | no FBA ledger rows |
| B-JAW-TRAINER-CLIP-3 | B0H5VSG8CC | FBA | no FBA ledger rows |
| B-BP-MON-CS80B-2 | B0HFX167DH | FBA | no FBA ledger rows |
| B-ST-NY-2-0-24MM-1 | B0FW5DKXP8 | FBA | no FBA ledger rows |
| B-BBYASP-E-ZLY-Bl-3 | B0GC5WC2DV | FBA | no FBA ledger rows |
| B-UTI-3PARA-PK3-3 | B0HLQ4S5B8 | FBA | no FBA ledger rows |
| B-ERMT-DM-1 | B0DKJWVZMC | FBA | no FBA ledger rows |
| B-ORAL-TRAINER-4HEAD-1 | B0FCM4QZB5 | FBA | no FBA ledger rows |
| B-B-NASAL-ASPIRATOR-(M&L)-1 | B0HL53GGMZ | FBA | no FBA ledger rows |
| BMN132B-3 | B0D543QKSX | FBA | no FBA ledger rows |
| BMN132B-4 | B0D76DFB9S | FBA | no FBA ledger rows |
| GLUCO-STRIPS-PK200-1 | B0H5R6H1MR | FBA | no FBA ledger rows |
| B-MENS-TENS-UNIT-1 | B0HCYTFSNR | FBA | no FBA ledger rows |
| BMN132-1 | B0C6GZNL1Q | FBA | no FBA ledger rows |
| BMN132-2 | B0C6GZNL1Q | FBA | no FBA ledger rows |
| BMN132-3 | B0C6GZNL1Q | FBA | no FBA ledger rows |
| M-KIDMICRO-PK-1 | B0DP2YNSGP | FBA | no FBA ledger rows |
| BMN132-5 | B0FVFQP8DT | FBA | no FBA ledger rows |
| M-KIDMICRO-PK-6 | B0GBYDW399 | FBA | no FBA ledger rows |
| B-BP-MON-3 | B0GZGSCFBT | FBA | no FBA ledger rows |
| B-SUTPRAC-KIT-GL | B0DVTBPZF9 | FBA | no FBA ledger rows |
| B-SUTPRAC-KIT-GL-4 | B0GJCN3C59 | FBA | no FBA ledger rows |
| B-CT-Y | B0CZTBBBP5 | FBA | no FBA ledger rows |
| B-FETAL-DOPPLER-1 | B0GDT571XQ | FBA | no FBA ledger rows |
| BSMRD | B0BW3H52M7 | FBA | no FBA ledger rows |
| SONM-ANTICHOK-7 | B0C6WQPYMC | FBA | no FBA ledger rows |
| NMRD-2 | B0CGZX44XX | FBA | no FBA ledger rows |
| SONM-ANTICHOK-1 | B0CH3JW1V8 | FBA | no FBA ledger rows |
| B-NCD-RK-6000FL-2 | B0CJYB35CK | FBA | no FBA ledger rows |
| BMN123-1 | B0CLS1PKFR | FBA | no FBA ledger rows |
| B-SUTPRAC-PAD-3 | B0CM66S5TQ | FBA | no FBA ledger rows |
| B-CT-B-3 | B0D1GKNHMC | FBA | no FBA ledger rows |
| B-BBYASP-HP-3 | B0D1TJG7QF | FBA | no FBA ledger rows |
| NMRD | B0D22VRZP5 | FBA | no FBA ledger rows |
| BMN123-3 | B0D28G8QK1 | FBA | no FBA ledger rows |
| BMN123-6 | B0D28XN4F5 | FBA | no FBA ledger rows |
| B-CCS3-4 | B0D2NRXX2X | FBA | no FBA ledger rows |
| B-MCA-2 | B0D2RRYL8N | FBA | no FBA ledger rows |
| SONM-PKFLW-W-BLE-2 | B0D3QLHSSP | FBA | no FBA ledger rows |
| RMT-I6E6-1 | B0D3TPRQBX | FBA | no FBA ledger rows |
| RMT-I6E6-2 | B0D4F2YWDV | FBA | no FBA ledger rows |
| B-CH-PS-B-3 | B0D5TWL1CW | FBA | no FBA ledger rows |
| B-CH-PS-Br | B0D5TXB6KR | FBA | no FBA ledger rows |
| B-CH-PS-Br-4 | B0D5YJTGW2 | FBA | no FBA ledger rows |
| SONM-ANTICHOK-5 | B0D6KBCBYQ | FBA | no FBA ledger rows |
| B-MCA-4 | B0D73S8B2C | FBA | no FBA ledger rows |
| B-BLACMAS-G-1 | B0DC6WWDH3 | FBA | no FBA ledger rows |
| B-BLACMAS-DP-1 | B0DC6X8LW2 | FBA | no FBA ledger rows |
| B-INST-BW-R-1 | B0DHVVKCJZ | FBA | no FBA ledger rows |
| B-GSM-1 | B0DM22R59T | FBA | no FBA ledger rows |
| B-BTJW-B1-1 | B0DM9FJC82 | FBA | no FBA ledger rows |
| B-MRD-FIL-2 | B0DMP1RZ76 | FBA | no FBA ledger rows |
| M-KIDMICRO-WT-1 | B0DP2ZCW6R | FBA | no FBA ledger rows |
| B-ANTI-C-MASS | B0DS8MZNWP | FBA | no FBA ledger rows |
| B-EGSM-1 | B0DTKN4GQK | FBA | no FBA ledger rows |
| B-BRESHE-50ML-1 | B0DX74D177 | FBA | no FBA ledger rows |
| B-SENBK-INS-3 | B0DZX76TCX | FBA | no FBA ledger rows |
| B-VD-TPE-PK5-1 | B0F244FLDG | FBA | no FBA ledger rows |
| B-ORALSWAB-PK100-1 | B0F4KCJN7P | FBA | no FBA ledger rows |
| B-IR-THERMO-BK-1 | B0F5HR74KY | FBA | no FBA ledger rows |
| B-BP-MON-W-BLE-1 | B0F6C56G2J | FBA | no FBA ledger rows |
| B-THERA-PUTTY-Bl-1 | B0F9FVV2ZZ | FBA | no FBA ledger rows |
| B-AIR-PURIFIER-1 | B0F9Y64LZJ | FBA | no FBA ledger rows |
| B-EWBP-TNK-1 | B0FCMXYX3J | FBA | no FBA ledger rows |
| B-MALE-FERTILITY-KIT-SUP1-1 | B0FD3N3D6N | FBA | no FBA ledger rows |
| B-EYE-PATCH-PK30-1 | B0FM8JFLVF | FBA | no FBA ledger rows |
| B-EYE-PATCH-WT-PK20-1 | B0FMP39KCW | FBA | no FBA ledger rows |
| B-EYE-PATCH-WT-PK10-1 | B0FMP3J3S5 | FBA | no FBA ledger rows |
| B-EYE-PATCH-WT-PK30-1 | B0FMP48K7K | FBA | no FBA ledger rows |
| B-EWBP-4 | B0FN7XL6QX | FBA | no FBA ledger rows |
| B-HANG-THERMO-1 | B0FNRSVBF9 | FBA | no FBA ledger rows |
| B-FER-LUBRICANT-50ML-1 | B0FP9DTV6S | FBA | no FBA ledger rows |
| B-SITZ-TUB-1 | B0FQ62FCT1 | FBA | no FBA ledger rows |
| SONM-PKFLW-W-BLE-8 | B0G14FVM89 | FBA | no FBA ledger rows |
| A016-5 | B0G34269WW | FBA | no FBA ledger rows |
| B-ANTI-C-MASS-GREEN-1 | B0GF2CLSHS | FBA | no FBA ledger rows |
| B-NASAL-WASH-POWDER-1 | B0GF2Z46F6 | FBA | no FBA ledger rows |
| B-ANTI-CHOK-BLK&RED-2 | B0GPQXNJQ1 | FBA | no FBA ledger rows |
| B-ORAL-SWAB-PK50-3 | B0GQ49MGVS | FBA | no FBA ledger rows |
| B-SUTPRAC-PAD-NORMAL-1 | B0GQTV6MZW | FBA | no FBA ledger rows |
| B-ORALSWAB-WT-PK50-1 | B0GR8XX5NR | FBA | no FBA ledger rows |
| B-ORALSWAB-WT-PK100-1 | B0GRTQV8Z4 | FBA | no FBA ledger rows |
| B-MENO-CASSETTE-PK3-1 | B0GS33L59Y | FBA | no FBA ledger rows |
| B-FOAM-LINER-COMBO-1 | B0GS9CTNPS | FBA | no FBA ledger rows |
| B-IR-ROG-LP-200-3 | B0GZKNJ46L | FBA | no FBA ledger rows |
| B-HUMAN-CUBE-1 | B0H4L3TZ4Z | FBA | no FBA ledger rows |
| B-INFLATE-DONUT-PLW-1 | B0H4YTF58X | FBA | no FBA ledger rows |
| B-INSEM-KIT-PK2-2 | B0H6Q4VS9R | FBA | no FBA ledger rows |
| B-INST-BW-Bl-5 | B0H7RMG5DG | FBA | no FBA ledger rows |
| B-BP-MON-5 | B0HH39MFFX | FBA | no FBA ledger rows |
| B-IR-THERMO-AD801-1 | B0HJWSMRC7 | FBA | no FBA ledger rows |
| B-CSECTION-(GREEN BELT)15PCS-1 | B0HLVNXXTS | FBA | no FBA ledger rows |
