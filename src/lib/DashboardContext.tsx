"use client";

import React, { createContext, useContext, useState, useEffect, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
import { mcp } from "@/lib/api";
import { getMarketplaceTab } from "@/lib/marketplace";

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
  lastDataDate: string | null;
  setLastDataDate: (date: string | null) => void;
};

const DashboardContext = createContext<DashboardState | undefined>(undefined);

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
  const [lastDataDate, setLastDataDate] = useState<string | null>(null);

  useEffect(() => {
    const savedStart = localStorage.getItem('ppc_startDate');
    const savedEnd = localStorage.getItem('ppc_endDate');
    const savedLabel = localStorage.getItem('ppc_dateLabel');

    // If the saved label is "Yesterday" (single-day with often no data),
    // automatically reset to Last 30 Days so the dashboard opens with useful data.
    const staleSingleDay = savedLabel === 'Yesterday' || savedLabel === 'Today';

    if (savedStart && !staleSingleDay) {
      setStartDate(savedStart);
    } else {
      const d = new Date();
      d.setDate(d.getDate() - 29);
      setStartDate(getLocalDateStr(d));
    }
    setEndDate((!staleSingleDay && savedEnd) ? savedEnd : getLocalDateStr());
    setDateLabel((!staleSingleDay && savedLabel) ? savedLabel : 'Last 30 Days');

    // Clear the stale single-day entry so the next reload is clean
    if (staleSingleDay) {
      localStorage.removeItem('ppc_startDate');
      localStorage.removeItem('ppc_endDate');
      localStorage.removeItem('ppc_dateLabel');
    }
  }, []);

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
        setLastDataDate,
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
