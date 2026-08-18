import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// The "uploaded data only" exporters. These build workbooks for a HISTORICAL
// window out of the files the seller uploaded, so reaching the live SellerMate
// API would mix today's snapshot into a past period — which is exactly the bug
// that made FBA stock and Price disagree with the seller's own workbook while
// the sheet still looked complete. Enforced here rather than left as a comment,
// because the failure is silent: nothing on the face of the report says which
// rows came from live data.
//
// analysisReportExport.ts and amazonSalesExport.ts are deliberately NOT listed —
// they are the "LIVE" reports and are supposed to call the API.
const UPLOADED_DATA_EXPORTERS = [
  "src/lib/historicalAnalysisReportExport.ts",
  "src/lib/weeklySalesExport.ts",
  "src/lib/flipkartHistoricalReportExport.ts",
  "src/lib/flipkartWeeklySalesExport.ts",
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: UPLOADED_DATA_EXPORTERS,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/api",
              message:
                "This report must be built from uploaded data only — calling the live API would put today's snapshot into a historical window. Read the uploaded table via fetchAllRows instead.",
            },
            {
              name: "@/lib/analysisReportExport",
              importNames: ["fetchFullCatalog", "fetchInventoryByLocation"],
              message:
                "These fetch from the live API. Use the uploaded Price (All Listings) / Inventory Ledger tables instead — see historicalAnalysisReportExport.ts's header comment. Importing fcToState from this module is fine.",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
