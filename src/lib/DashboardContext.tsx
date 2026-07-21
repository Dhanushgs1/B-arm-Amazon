"use client";

import React, { createContext, useContext, useState, useEffect } from "react";
import { mcp } from "@/lib/api";

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
};

const DashboardContext = createContext<DashboardState | undefined>(undefined);

export function DashboardProvider({ children }: { children: React.ReactNode }) {
  const [keySlot, setKeySlotState] = useState<"A" | "B">("A");
  const [loggedInUser, setLoggedInUser] = useState<string>("Lkn");
  const [account, setAccount] = useState<Account | null>(null);
  const [contextLoading, setContextLoading] = useState(true);
  const [contextError, setContextError] = useState<string | null>(null);

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

  useEffect(() => {
    const savedStart = localStorage.getItem('ppc_startDate');
    const savedEnd = localStorage.getItem('ppc_endDate');
    const savedLabel = localStorage.getItem('ppc_dateLabel');

    if (savedStart) {
      setStartDate(savedStart);
    } else {
      const d = new Date();
      d.setDate(d.getDate() - 29);
      setStartDate(getLocalDateStr(d));
    }
    setEndDate(savedEnd || getLocalDateStr());
    setDateLabel(savedLabel || "Last 30 Days");
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
      console.error("Failed to load user context:", e);
      setContextError(e?.message || "Could not reach the data service.");
    } finally {
      setContextLoading(false);
    }
  };

  const retryContext = () => loadContext(keySlot);

  useEffect(() => {
    const savedUser = localStorage.getItem("ppcUser") || "Lkn";
    const slot: "A" | "B" = savedUser === "Barm" ? "B" : "A";
    setLoggedInUser(savedUser);
    setKeySlotState(slot);
    loadContext(slot);
  }, []);


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
