"use client";

import { useDashboard } from "@/lib/DashboardContext";
import { Bell, Moon, Sun, Search, RefreshCw, Loader2, LogOut } from "lucide-react";
import { useState, useEffect } from "react";
import { DateRangePicker } from "@/components/DateRangePicker";
import { cn } from "@/lib/utils";

type Notification = {
  id: number;
  title: string;
  body: string;
  time: string;
  read: boolean;
  type: "warning" | "danger" | "success" | "info";
};

export function TopNav() {
  const { loggedInUser, account, contextLoading } = useDashboard();
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [showNotifications, setShowNotifications] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);

  useEffect(() => {
    if (document.documentElement.classList.contains("dark")) {
      setTheme("dark");
    }
  }, []);

  // Load and subscribe to notifications in localStorage
  useEffect(() => {
    const loadNotifs = () => {
      const saved = localStorage.getItem("ppcNotifications");
      if (saved) {
        setNotifications(JSON.parse(saved));
      } else {
        const defaultNotifs: Notification[] = [
          { id: 1, title: "Low Stock Warning", body: "ASIN B07X8Y54... is down to 8 units. Replenish soon.", time: "10m ago", read: false, type: "warning" },
          { id: 2, title: "High ACOS Alert", body: "Campaign 'SP-Socks-Exact' exceeded 45% ACOS today.", time: "1h ago", read: false, type: "danger" },
          { id: 3, title: "Manual Ingestion Success", body: "Successfully imported 142 campaigns and 439 keywords.", time: "3h ago", read: false, type: "success" },
          { id: 4, title: "Gemini Analysis Ready", body: "New AI recommendations generated for this week.", time: "5h ago", read: true, type: "info" }
        ];
        localStorage.setItem("ppcNotifications", JSON.stringify(defaultNotifs));
        setNotifications(defaultNotifs);
      }
    };
    loadNotifs();
    window.addEventListener("storage", loadNotifs);
    return () => window.removeEventListener("storage", loadNotifs);
  }, []);

  const toggleTheme = () => {
    if (theme === "light") {
      document.documentElement.classList.add("dark");
      setTheme("dark");
    } else {
      document.documentElement.classList.remove("dark");
      setTheme("light");
    }
  };

  const handleLogout = () => {
    localStorage.removeItem("ppcUser");
    localStorage.removeItem("ppcKeySlot");
    window.location.href = "/";
  };

  // Derive initials and label from logged-in user
  const isLkn = loggedInUser === "Lkn";
  const accountLabel = isLkn ? "LKN Account" : "Barm Account";
  const initials = isLkn ? "LK" : "BA";
  const avatarGradient = isLkn
    ? "from-indigo-500 to-violet-600"
    : "from-emerald-500 to-teal-600";

  return (
    <header className="flex items-center gap-3 px-6 py-3 bg-popover/80 backdrop-blur-xl border-b border-border sticky top-0 z-30 flex-wrap">
      {/* Workspace Switcher */}
      <div className="flex items-center gap-2 bg-slate-100 dark:bg-slate-900 border border-transparent dark:border-transparent px-3.5 py-2.5 rounded-xl text-xs font-black shadow-inner">
        {contextLoading ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-500" />
        ) : (
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse flex-shrink-0" />
        )}
        <span className="text-slate-700 dark:text-slate-300 uppercase tracking-wider">{accountLabel}</span>
        {account && !contextLoading && (
          <span className="text-[10px] text-slate-400 dark:text-slate-500 border-l border-slate-200 dark:border-slate-800 pl-2">
            {account.currency}
          </span>
        )}
      </div>

      {/* Global Search with Cmd/Ctrl+K shortcut hint */}
      <div className="relative flex-1 min-w-[200px] max-w-[360px]">
        <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500" />
        <input
          placeholder="Search workspace..."
          className="w-full bg-slate-100 dark:bg-slate-900 border border-transparent dark:border-transparent text-foreground pl-10 pr-12 py-2.5 rounded-xl text-xs font-semibold shadow-inner focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:bg-white dark:focus:bg-slate-950 transition-all"
        />
        <kbd className="absolute right-3.5 top-1/2 -translate-y-1/2 hidden sm:inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-[9px] font-black text-slate-400 dark:text-slate-500 shadow-sm pointer-events-none select-none">
          Ctrl K
        </kbd>
      </div>

      <div className="flex-grow" />

      {/* Date Range Picker */}
      <DateRangePicker />

      {/* Refresh */}
      <button
        onClick={() => window.location.reload()}
        className="w-10 h-10 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-500 dark:text-slate-400 flex items-center justify-center hover:border-indigo-500/50 hover:text-indigo-500 transition-colors shadow-sm focus:outline-none"
        title="Refresh data"
      >
        <RefreshCw className="w-4 h-4" />
      </button>

      {/* Notifications */}
      <div className="relative">
        <button
          onClick={() => {
            setShowNotifications(!showNotifications);
            const updated = notifications.map(n => ({ ...n, read: true }));
            localStorage.setItem("ppcNotifications", JSON.stringify(updated));
            setNotifications(updated);
          }}
          className="relative w-10 h-10 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-500 dark:text-slate-400 flex items-center justify-center hover:border-indigo-500/50 hover:text-indigo-500 transition-colors shadow-sm focus:outline-none"
          title="Notifications"
        >
          <Bell className="w-4 h-4" />
          {notifications.some(n => !n.read) && (
            <span className="absolute top-2.5 right-2.5 w-2 h-2 rounded-full bg-red-500 animate-pulse" />
          )}
        </button>

        {showNotifications && (
          <div className="absolute right-0 mt-2 w-80 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-xl p-4 z-50 text-xs font-semibold backdrop-blur-xl animate-in fade-in slide-in-from-top-2 duration-200">
            <div className="flex items-center justify-between pb-2 border-b border-slate-200 dark:border-slate-850 mb-3">
              <span className="font-extrabold text-slate-800 dark:text-white uppercase tracking-wider text-[10px]">System Alerts</span>
              <button
                onClick={() => {
                  localStorage.setItem("ppcNotifications", JSON.stringify([]));
                  setNotifications([]);
                }}
                className="text-[9px] text-slate-400 hover:text-slate-600 font-black uppercase tracking-wider transition-colors"
              >
                Clear All
              </button>
            </div>
            <div className="space-y-3.5 max-h-60 overflow-y-auto">
              {notifications.length === 0 ? (
                <p className="text-center text-slate-400 py-4 font-bold text-[10px]">NO ALERTS DETECTED</p>
              ) : (
                notifications.map(n => (
                  <div key={n.id} className={cn("p-3 rounded-xl border flex flex-col gap-1 transition-all", n.read ? "bg-slate-50/50 dark:bg-slate-900/10 border-slate-200/50 dark:border-slate-800/50" : "bg-indigo-500/5 border-indigo-500/20")}>
                    <div className="flex items-center justify-between">
                      <span className={cn("font-bold text-[11px]", 
                        n.type === "danger" ? "text-red-500" :
                        n.type === "warning" ? "text-amber-500" :
                        n.type === "success" ? "text-emerald-500" : "text-indigo-500"
                      )}>
                        {n.title}
                      </span>
                      <span className="text-[9px] text-slate-400 font-bold">{n.time}</span>
                    </div>
                    <p className="text-[11px] text-slate-600 dark:text-slate-400 font-medium leading-normal">{n.body}</p>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {/* Theme Toggle */}
      <button
        onClick={toggleTheme}
        className="w-10 h-10 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-500 dark:text-slate-400 flex items-center justify-center hover:border-indigo-500/50 hover:text-indigo-500 transition-colors shadow-sm focus:outline-none"
        title="Toggle theme"
      >
        {theme === "light" ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
      </button>

      {/* Unified Profile Logout */}
      <div className="relative group">
        <button
          onClick={handleLogout}
          title="Sign out of workspace"
          className="flex items-center gap-2 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800/80 border border-slate-200 dark:border-slate-800 px-3 py-2 rounded-xl transition-all shadow-sm focus:outline-none"
        >
          <div className={`w-6 h-6 rounded-lg bg-gradient-to-br ${avatarGradient} text-white flex items-center justify-center font-bold text-[10px] shadow-sm`}>
            {initials}
          </div>
          <span className="text-[10px] font-black text-slate-700 dark:text-slate-300 hidden md:inline uppercase tracking-wide">Sign Out</span>
        </button>
      </div>
    </header>
  );
}
