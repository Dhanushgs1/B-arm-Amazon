"use client";

import { useDashboard } from "@/lib/DashboardContext";
import { Bell, Moon, Sun, Search, RefreshCw, Loader2, LogOut } from "lucide-react";
import { useState, useEffect } from "react";
import { DateRangePicker } from "@/components/DateRangePicker";

export function TopNav() {
  const { loggedInUser, account, contextLoading } = useDashboard();
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    if (document.documentElement.classList.contains("dark")) {
      setTheme("dark");
    }
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
    // Hard reload clears all React Query cache
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
      {/* Account Badge — locked to logged-in user, no switcher */}
      <div className="flex items-center gap-2 bg-card border border-border text-foreground px-3 py-1.5 rounded-lg text-sm shadow-sm">
        {contextLoading ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
        ) : (
          <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse flex-shrink-0" />
        )}
        <span className="font-semibold">{accountLabel}</span>
        {account && !contextLoading && (
          <span className="text-xs text-muted-foreground border-l border-border pl-2">
            {account.currency}
          </span>
        )}
      </div>

      {/* Global Search */}
      <div className="relative flex-1 min-w-[200px] max-w-[400px]">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input
          placeholder="Search campaigns, ASINs, keywords..."
          className="w-full bg-card border border-border text-foreground pl-9 pr-4 py-1.5 rounded-lg text-sm shadow-sm hover:border-primary/50 focus:border-primary focus:outline-none transition-colors"
        />
      </div>

      <div className="flex-1" />

      {/* Date Range Picker */}
      <DateRangePicker />

      {/* Refresh */}
      <button
        onClick={() => window.location.reload()}
        className="w-9 h-9 rounded-lg border border-border bg-card text-foreground flex items-center justify-center hover:border-primary/50 transition-colors shadow-sm"
        title="Refresh data"
      >
        <RefreshCw className="w-4 h-4" />
      </button>

      {/* Notifications */}
      <button className="relative w-9 h-9 rounded-lg border border-border bg-card text-foreground flex items-center justify-center hover:border-primary/50 transition-colors shadow-sm">
        <Bell className="w-4 h-4" />
        <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-destructive" />
      </button>

      {/* Theme Toggle */}
      <button
        onClick={toggleTheme}
        className="w-9 h-9 rounded-lg border border-border bg-card text-foreground flex items-center justify-center hover:border-primary/50 transition-colors shadow-sm"
        title="Toggle theme"
      >
        {theme === "light" ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
      </button>

      {/* Profile + Logout */}
      <div className="flex items-center gap-2">
        <div className={`w-9 h-9 rounded-full bg-gradient-to-br ${avatarGradient} text-white flex items-center justify-center font-bold text-xs cursor-pointer shadow-md`}>
          {initials}
        </div>
        <button
          onClick={handleLogout}
          title="Logout"
          className="w-9 h-9 rounded-lg border border-border bg-card text-muted-foreground flex items-center justify-center hover:border-red-400 hover:text-red-500 transition-colors shadow-sm"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}
