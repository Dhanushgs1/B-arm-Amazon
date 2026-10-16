// Recipients of the Consolidated Stock Sheet's "Send mail" button (user, 2026-10-16): one mail per
// kind, each with its own file (src/lib/consolidatedStockExport.ts consolidatedMailFiles).
import type { ConsolidatedMailKind } from "./consolidatedStockExport.ts";

export const CONSOLIDATED_MAIL_RECIPIENTS: Record<ConsolidatedMailKind, { to: string[]; cc: string[] }> = {
  nosales: {
    to: ["kaviyapriyabarm@gmail.com"],
    cc: ["aravindh.l@b-arm.com", "akshaya.v@b-arm.com", "manoj.j@b-arm.com", "dangibbs@b-arm.com", "nivetha@b-arm.com", "prinesh@b-arm.com",
      "sharmilambarm@gmail.com", "prashanthbarm@gmail.com", "jayaprakashbarm@gmail.com", "harshineebarm@gmail.com",
      "sruthisri@barmenterprises.com", "sriram@b-arm.com", "ceo@barmenterprises.com"],
  },
  runningout: {
    to: ["prashanthbarm@gmail.com", "sharmilambarm@gmail.com", "aravindh.l@b-arm.com"],
    cc: ["ceo@barmenterprises.com", "sriram@b-arm.com", "sruthisri@barmenterprises.com", "harshineebarm@gmail.com", "kaviyapriyabarm@gmail.com",
      "akshaya.v@b-arm.com", "prinesh@b-arm.com", "manoj.j@b-arm.com", "nivetha@b-arm.com"],
  },
  consolidated: {
    to: ["kaviyapriyabarm@gmail.com"],
    cc: ["sriram@b-arm.com", "sruthisri@barmenterprises.com", "ceo@barmenterprises.com", "sharmilambarm@gmail.com", "aravindh.l@b-arm.com",
      "akshaya.v@b-arm.com", "prinesh@b-arm.com", "nivetha@b-arm.com", "jayaprakashbarm@gmail.com", "harshineebarm@gmail.com", "mathumithabarm@gmail.com"],
  },
};
