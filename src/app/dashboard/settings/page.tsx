"use client";

import { useDashboard } from "@/lib/DashboardContext";
import { Settings, Shield, RefreshCw, Key, HelpCircle, CheckCircle } from "lucide-react";
import { useState } from "react";

export default function SettingsPage() {
  const { account, loggedInUser } = useDashboard();
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleSave = () => {
    setSaving(true);
    setTimeout(() => {
      setSaving(false);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2000);
    }, 1000);
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8 pb-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight mb-0.5">Settings</h1>
        <p className="text-muted-foreground text-sm">
          Manage your SellerMate connections and API credentials
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Left Column Tabs */}
        <div className="space-y-1">
          <button className="w-full text-left px-3 py-2 rounded-xl text-sm font-semibold bg-primary text-white shadow-md shadow-primary/20 flex items-center gap-2.5">
            <Key size={16} /> API Integration
          </button>
          <button className="w-full text-left px-3 py-2 rounded-xl text-sm font-semibold text-muted-foreground hover:bg-muted hover:text-foreground flex items-center gap-2.5 transition-colors">
            <Shield size={16} /> Security
          </button>
          <button className="w-full text-left px-3 py-2 rounded-xl text-sm font-semibold text-muted-foreground hover:bg-muted hover:text-foreground flex items-center gap-2.5 transition-colors">
            <RefreshCw size={16} /> Data Ingestion
          </button>
          <button className="w-full text-left px-3 py-2 rounded-xl text-sm font-semibold text-muted-foreground hover:bg-muted hover:text-foreground flex items-center gap-2.5 transition-colors">
            <HelpCircle size={16} /> Support
          </button>
        </div>

        {/* Right Columns Config Form */}
        <div className="md:col-span-2 space-y-6">
          <div className="glass rounded-2xl border border-border p-6 shadow-sm space-y-5">
            <h3 className="font-bold text-sm text-foreground">API Credentials</h3>
            
            <div className="space-y-1">
              <label className="text-xs font-bold text-muted-foreground uppercase">Active Account</label>
              <div className="p-3 bg-muted border border-border rounded-xl text-sm font-semibold text-foreground">
                {account?.name || "B-ARM"} ({loggedInUser === "Lkn" ? "Account A" : "Account B"})
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-bold text-muted-foreground uppercase">API Key (Locked)</label>
              <input
                type="password"
                disabled
                value="••••••••••••••••••••••••••••••••••••••••"
                className="w-full px-3 py-2 bg-muted border border-border rounded-xl text-sm text-muted-foreground cursor-not-allowed"
              />
              <p className="text-[10px] text-muted-foreground">For security, API keys are managed server-side and cannot be edited from the dashboard.</p>
            </div>
          </div>

          <div className="glass rounded-2xl border border-border p-6 shadow-sm space-y-5">
            <h3 className="font-bold text-sm text-foreground">Sync Settings</h3>
            
            <div className="flex items-center justify-between py-2 border-b border-border">
              <div>
                <p className="text-xs font-bold">Auto Ingestion</p>
                <p className="text-[11px] text-muted-foreground">SellerMate syncs data automatically in the background.</p>
              </div>
              <span className="px-2 py-0.5 rounded-full bg-green-500/10 text-green-700 dark:text-green-400 font-bold text-[10px]">Active</span>
            </div>

            <div className="flex items-center justify-between py-2">
              <div>
                <p className="text-xs font-bold">Sync Schedule</p>
                <p className="text-[11px] text-muted-foreground">How often reports are updated from Amazon SP-API.</p>
              </div>
              <span className="font-semibold text-xs text-foreground">Every 6 Hours</span>
            </div>
          </div>

          <div className="flex items-center gap-3 justify-end">
            {success && (
              <span className="text-xs text-green-600 dark:text-green-400 font-bold flex items-center gap-1.5 animate-pulse">
                <CheckCircle size={14} /> Settings saved!
              </span>
            )}
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-5 py-2.5 bg-[#0f172a] hover:bg-slate-800 text-white font-bold text-xs rounded-xl shadow-sm transition-colors flex items-center gap-2"
            >
              {saving ? "Saving..." : "Save Settings"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
