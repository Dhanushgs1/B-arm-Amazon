"use client";

import React, { createContext, useContext, useState, useEffect, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
import { mcp } from "@/lib/api";
import { getMarketplaceTab, type MarketplaceTab } from "@/lib/marketplace";
import { fetchChannelLastDataDate } from "@/lib/channelLastDataDate";
import { supabase } from "@/lib/supabaseClient";

type Account = {
  id: string;
  name: string;
  workspace_id: string;
  currency: string;
};

type DashboardState = {
  keySlot: "A" | "B";
  loggedInUser: string;    // "Lkn" or "Barm"
  startDate: string;
  endDate: string;
  dateLabel: string;
  setDateRange: (start: string, end: string, label: string) => void;
  account: Account | null;
  contextLoading: boolean;
  contextError: string | null;
  retryContext: () => void;
  selectedCampaignName: string | null;
  selectedAsin: string | null;
  setSelectedCampaignName: (name: string | null) => void;
  setSelectedAsin: (asin: string | null) => void;
  /** Last date with data for the active marketplace tab — see channelLastDataDate.ts. */
  lastDataDate: string | null;
};

const DashboardContext = createContext<DashboardState | undefined>(undefined);

// Presets whose label describes a window relative to now ("Last 7 Days") rather
// than a fixed one ("1 Aug 2026 – 7 Aug 2026", written by the custom picker).
// Only these get re-anchored on restore; a custom range means what it says.
// Keep in sync with PRESETS in components/DateRangePicker.tsx.
const RELATIVE_PRESET_DAYS: Record<string, number> = {
  "Last 7 Days": 7,
  "Last 14 Days": 14,
  "Last 30 Days": 30,
  "Last 60 Days": 60,
  "Last 90 Days": 90,
};

export function DashboardProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [keySlot, setKeySlotState] = useState<"A" | "B">("A");
  const [loggedInUser, setLoggedInUser] = useState<string>("Lkn");
  const [account, setAccount] = useState<Account | null>(null);
  const [contextLoadingRaw, setContextLoading] = useState(true);
  const [contextErrorRaw, setContextError] = useState<string | null>(null);

  // The user context comes from SellerMate, which only ever serves the AMAZON
  // side. Anywhere else, calling it can only produce a failure nobody can act
  // on — and it did: every Flipkart page, and the LOGIN page (which this
  // provider also wraps, and which no marketplace owns), logged "Internal Proxy
  // Error: fetch failed" and popped Next's dev error overlay whenever SellerMate
  // was unreachable. The layout already gates the connection banner and the bid
  // prefetcher on the marketplace; this gates the request that feeds them, and
  // additionally requires being on a dashboard route at all.
  const onDashboard = (pathname || "").startsWith("/dashboard");
  const needsAmazonContext = onDashboard && getMarketplaceTab(pathname) !== "flipkart";

  // Derived, not effect-assigned: on a Flipkart route the Amazon context is not
  // "loading" and not "failed", it is simply not applicable. Storing that as
  // state would mean a setState inside an effect on every navigation.
  const contextLoading = needsAmazonContext ? contextLoadingRaw : false;
  const contextError = needsAmazonContext ? contextErrorRaw : null;

  // Use local date (not UTC) to avoid timezone shift bugs
  const getLocalDateStr = (d: Date = new Date()) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };

  // Server has no `window` and its clock may differ from the client's by the
  // time hydration runs, so computing "today" during the initial render (used
  // for both SSR and client hydration) causes a hydration mismatch. Render a
  // fixed placeholder on first pass, then resolve the real value client-side
  // in a useEffect below.
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [dateLabel, setDateLabel] = useState("Last 30 Days");
  // The date-range presets end on the last date that actually has data for the ACTIVE tab
  // (Meesho/BARM: their orders table; Flipkart/Amazon: the date most of their sources reach —
  // see channelLastDataDate.ts), so each tab gets its own date instead of one shared one.
  const activeTab: MarketplaceTab | null = onDashboard ? getMarketplaceTab(pathname) : null;
  const [lastDataDateByTab, setLastDataDateByTab] = useState<Partial<Record<MarketplaceTab, string | null>>>({});
  const lastDataDate = activeTab ? lastDataDateByTab[activeTab] ?? null : null;
  useEffect(() => {
    if (!activeTab || activeTab in lastDataDateByTab) return;
    let cancelled = false;
    fetchChannelLastDataDate(activeTab).then((d) => {
      if (!cancelled) setLastDataDateByTab((prev) => ({ ...prev, [activeTab]: d }));
    });
    return () => { cancelled = true; };
  }, [activeTab, lastDataDateByTab]);

  useEffect(() => {
    const savedStart = localStorage.getItem('ppc_startDate');
    const savedEnd = localStorage.getItem('ppc_endDate');
    const savedLabel = localStorage.getItem('ppc_dateLabel');

    // If the saved label is "Yesterday" (single-day with often no data),
    // automatically reset to Last 30 Days so the dashboard opens with useful data.
    const staleSingleDay = savedLabel === 'Yesterday' || savedLabel === 'Today';

    // Default the window to end yesterday, not today — today's marketplace
    // data is normally still incomplete when the dashboard is first opened,
    // same reasoning applyPreset uses (lastDataDate over "now") for presets.
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const defaultStart = new Date(yesterday);
    defaultStart.setDate(defaultStart.getDate() - 29);

    if (savedStart && !staleSingleDay) {
      setStartDate(savedStart);
    } else {
      setStartDate(getLocalDateStr(defaultStart));
    }
    setEndDate((!staleSingleDay && savedEnd) ? savedEnd : getLocalDateStr(yesterday));
    setDateLabel((!staleSingleDay && savedLabel) ? savedLabel : 'Last 30 Days');

    // Clear the stale single-day entry so the next reload is clean
    if (staleSingleDay) {
      localStorage.removeItem('ppc_startDate');
      localStorage.removeItem('ppc_endDate');
      localStorage.removeItem('ppc_dateLabel');
    }
  }, []);

  // The effect above restores the saved *absolute* dates together with the saved
  // label. For a relative label that goes stale: pick "Last 7 Days" today, come
  // back in a fortnight, and the header still reads "Last 7 Days" over a window
  // that ended two weeks ago. Re-anchor it once per tab per last-data date,
  // using the same rule the picker itself uses (end at the last date that
  // actually has data for the active tab) — so switching from Amazon to BARM
  // moves a "Last 14 Days" window to BARM's own last date.
  const reanchoredRef = useRef<string | null>(null);
  useEffect(() => {
    const key = `${activeTab}|${lastDataDate}`;
    if (reanchoredRef.current === key || !lastDataDate) return;
    const days = RELATIVE_PRESET_DAYS[dateLabel];
    if (!days) return;
    reanchoredRef.current = key;

    const [y, m, d] = lastDataDate.split("-").map(Number);
    const end = new Date(y, m - 1, d);
    const start = new Date(end);
    start.setDate(end.getDate() - (days - 1));
    const nextStart = getLocalDateStr(start);
    const nextEnd = getLocalDateStr(end);
    if (nextStart === startDate && nextEnd === endDate) return;

    setStartDate(nextStart);
    setEndDate(nextEnd);
    localStorage.setItem('ppc_startDate', nextStart);
    localStorage.setItem('ppc_endDate', nextEnd);
  }, [activeTab, lastDataDate, dateLabel, startDate, endDate]);

  // Mirror the selected end date into public."ACOS Intervals" (scripts/acos_intervals_table.sql),
  // so acos_interval_summary_v follows whatever date the dashboard is on — the same way
  // "Intervals" drives product_forecast_summary_v. BARM only: the table holds BARM's ad spend
  // window, and an LKN session must not move it. Debounced so restore + re-anchor on load, or
  // clicking through the picker, end in one write.
  useEffect(() => {
    if (!onDashboard || loggedInUser !== "Barm" || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return;
    const t = setTimeout(() => {
      supabase.rpc("set_acos_interval", { p_report_date: endDate }).then(({ error }) => {
        if (error) console.error("[DashboardContext] set_acos_interval failed:", error);
      });
    }, 800);
    return () => clearTimeout(t);
  }, [onDashboard, loggedInUser, endDate]);

  // Load user context (workspace + account IDs) for a given slot
  const loadContext = async (slot: "A" | "B") => {
    setContextLoading(true);
    setContextError(null);
    setAccount(null);
    try {
      const ctx = await mcp("get_user_context", {}, slot);
      if (ctx?.accounts?.[0]) {
        const acc = ctx.accounts[0];
        setAccount({
          id: acc.id,
          name: acc.name,
          workspace_id: acc.workspace_id,
          currency: acc.currency || "USD",
        });
      } else {
        setContextError("No Amazon account found for this workspace.");
      }
    } catch (e: any) {
      // warn, not error: this condition is already fully surfaced in the UI by
      // ConnectionBanner (red banner naming the error, with a Retry button), and
      // console.error additionally triggers Next's dev "Console Error" overlay —
      // an unactionable popup on top of the actionable banner. The message still
      // reaches the console for debugging.
      console.warn("Failed to load user context:", e);
      setContextError(e?.message || "Could not reach the data service.");
    } finally {
      setContextLoading(false);
    }
  };

  const retryContext = () => {
    loadedSlotRef.current = keySlot;
    loadContext(keySlot);
  };

  /** Which slot the context has already been fetched for, so navigating between
   *  Amazon pages doesn't refetch and a Flipkart detour doesn't lose it. */
  const loadedSlotRef = useRef<"A" | "B" | null>(null);
  const [sessionSlot, setSessionSlot] = useState<"A" | "B" | null>(null);

  useEffect(() => {
    const savedUser = localStorage.getItem("ppcUser");
    if (!savedUser) {
      // No session — visiting a /dashboard/* URL directly (bookmark, email link,
      // typed URL) used to silently fall back to "Lkn" and load its data instead
      // of asking the visitor to log in. Send unauthenticated visitors to login.
      if (pathname?.startsWith("/dashboard")) {
        // Leave contextLoading at its default true — the redirect below unmounts
        // this tree shortly, so any dashboard page briefly re-rendered in the
        // meantime shows its loading spinner instead of empty/broken content.
        router.replace("/");
      } else {
        setContextLoading(false);
      }
      return;
    }
    const slot: "A" | "B" = savedUser === "Barm" ? "B" : "A";
    setLoggedInUser(savedUser);
    setKeySlotState(slot);
    setSessionSlot(slot);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch the SellerMate context the first time a route that actually uses it is
  // shown. Landing straight on a Flipkart page therefore makes no SellerMate
  // call at all; navigating from there to an Amazon page fetches it then. The
  // ref keeps it to one call per slot for the whole session.
  useEffect(() => {
    if (!sessionSlot || !needsAmazonContext) return;
    if (loadedSlotRef.current === sessionSlot) return;
    loadedSlotRef.current = sessionSlot;
    loadContext(sessionSlot);
  }, [sessionSlot, needsAmazonContext]);


  const [selectedCampaignName, setSelectedCampaignName] = useState<string | null>(null);
  const [selectedAsin, setSelectedAsin] = useState<string | null>(null);

  const setDateRange = (start: string, end: string, label: string) => {
    setStartDate(start);
    setEndDate(end);
    setDateLabel(label);
    if (typeof window !== 'undefined') {
      localStorage.setItem('ppc_startDate', start);
      localStorage.setItem('ppc_endDate', end);
      localStorage.setItem('ppc_dateLabel', label);
    }
  };

  return (
    <DashboardContext.Provider
      value={{
        keySlot,
        loggedInUser,
        startDate,
        endDate,
        dateLabel,
        setDateRange,
        account,
        contextLoading,
        contextError,
        retryContext,
        selectedCampaignName,
        selectedAsin,
        setSelectedCampaignName,
        setSelectedAsin,
        lastDataDate,
      }}
    >
      {children}
    </DashboardContext.Provider>
  );
}

export function useDashboard() {
  const context = useContext(DashboardContext);
  if (!context) throw new Error("useDashboard must be used within a DashboardProvider");
  return context;
}
