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

  const getDefaultStart = () => {
    const d = new Date();
    d.setDate(d.getDate() - 29);
    return d.toISOString().slice(0, 10);
  };
  const getDefaultEnd = () => new Date().toISOString().slice(0, 10);

  const [startDate, setStartDate] = useState(getDefaultStart);
  const [endDate, setEndDate] = useState(getDefaultEnd);
  const [dateLabel, setDateLabel] = useState("Last 30 Days");

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
