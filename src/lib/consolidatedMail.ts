// Recipients of the Consolidated Stock Sheet's "Send mail" button: one mail per kind, each with its own
// file (src/lib/consolidatedStockExport.ts consolidatedMailFiles). List from the user, 2026-11-18
// (kavinilavan@ and manoj.j@ removed: manoj.j@b-arm.com bounces "Address not found").
import type { ConsolidatedMailKind } from "./consolidatedStockExport.ts";

export const CONSOLIDATED_MAIL_RECIPIENTS: Record<ConsolidatedMailKind, { to: string[]; cc: string[] }> = {
  nosales: {
    to: ["kaviyapriyabarm@gmail.com", "akshaya.v@b-arm.com", "prinesh@b-arm.com", "nivetha@b-arm.com",
      "jayaprakashbarm@gmail.com", "dangibbs@b-arm.com"],
    cc: ["sriram@b-arm.com", "sruthisri@barmenterprises.com", "ceo@barmenterprises.com"],
  },
  runningout: {
    to: ["sharmilambarm@gmail.com", "aravindh.l@b-arm.com"],
    cc: ["sriram@b-arm.com", "sruthisri@barmenterprises.com", "ceo@barmenterprises.com", "kaviyapriyabarm@gmail.com",
      "akshaya.v@b-arm.com", "prinesh@b-arm.com", "nivetha@b-arm.com", "jayaprakashbarm@gmail.com", "dangibbs@b-arm.com",
      "mathumithabarm@gmail.com", "chandru.m@b-arm.com"],
  },
  consolidated: {
    to: ["kaviyapriyabarm@gmail.com", "sharmilambarm@gmail.com", "aravindh.l@b-arm.com", "akshaya.v@b-arm.com",
      "prinesh@b-arm.com", "nivetha@b-arm.com", "jayaprakashbarm@gmail.com", "dangibbs@b-arm.com",
      "harshineebarm@gmail.com", "mathumithabarm@gmail.com", "chandru.m@b-arm.com"],
    cc: ["sriram@b-arm.com", "sruthisri@barmenterprises.com", "ceo@barmenterprises.com"],
  },
};
