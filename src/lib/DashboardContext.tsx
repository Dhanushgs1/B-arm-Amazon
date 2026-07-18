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

  // Use local date (not UTC) to avoid timezone shift bugs
  const getLocalDateStr = (d: Date = new Date()) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };

  const getDefaultStart = () => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('ppc_startDate') : null;
    if (saved) return saved;
    const d = new Date();
    d.setDate(d.getDate() - 29);
    return getLocalDateStr(d);
  };
  const getDefaultEnd = () => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('ppc_endDate') : null;
    if (saved) return saved;
    return getLocalDateStr();
  };
  const getDefaultLabel = () => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('ppc_dateLabel') : null;
    return saved || "Last 30 Days";
  };

  const [startDate, setStartDate] = useState(getDefaultStart);
  const [endDate, setEndDate] = useState(getDefaultEnd);
  const [dateLabel, setDateLabel] = useState(getDefaultLabel);

  // Load user context (workspace + account IDs) for a given slot
  const loadContext = async (slot: "A" | "B") => {
    setContextLoading(true);
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
      }
    } catch (e) {
      console.error("Failed to load user context:", e);
    } finally {
      setContextLoading(false);
    }
  };

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
