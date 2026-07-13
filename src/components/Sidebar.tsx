"use client";

import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { useDashboard } from "@/lib/DashboardContext";
import { useState, useEffect } from "react";
import {
  LayoutDashboard,
  Megaphone,
  LayoutGrid,
  Target,
  Package,
  KeyRound,
  Search,
  Box,
  BarChart3,
  Bot,
  Settings,
  ChevronLeft,
  ChevronRight,
  Database,
  Cpu
} from "lucide-react";

const NAV = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "campaigns", label: "Campaigns", icon: Megaphone },
  { id: "adgroups", label: "Ad Groups", icon: LayoutGrid },
  { id: "placements", label: "Placements", icon: Target },
  { id: "products", label: "Products", icon: Package },
  { id: "keywords", label: "Keywords", icon: KeyRound },
  { id: "searchterms", label: "Search Terms", icon: Search },
  { id: "inventory", label: "Inventory", icon: Box },
  { id: "reports", label: "Reports", icon: BarChart3 },
  { id: "ai", label: "AI Assistant", icon: Bot },
  { id: "settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { loggedInUser, account } = useDashboard();
  const [isCollapsed, setIsCollapsed] = useState(false);

  // Load collapse state from local storage on mount
  useEffect(() => {
    const saved = localStorage.getItem("ppcSidebarCollapsed");
    if (saved) {
      setIsCollapsed(saved === "true");
    }
  }, []);

  const toggleCollapse = () => {
    const nextVal = !isCollapsed;
    setIsCollapsed(nextVal);
    localStorage.setItem("ppcSidebarCollapsed", String(nextVal));
  };

  const isLkn = loggedInUser === "Lkn";
  const avatarGradient = isLkn ? "from-indigo-500 to-violet-600" : "from-emerald-500 to-teal-600";
  const initials = isLkn ? "LK" : "BA";

  const currentPage = pathname === "/dashboard" ? "overview" : (pathname || "").split("/").pop() || "overview";

  return (
    <aside
      className={cn(
        "flex-shrink-0 bg-white dark:bg-slate-950 border-r border-slate-200/60 dark:border-slate-800/60 flex flex-col sticky top-0 h-screen z-40 transition-all duration-300 shadow-sm",
        isCollapsed ? "w-[78px]" : "w-[260px]"
      )}
    >
      {/* Sidebar Header / Logo */}
      <div className="flex items-center justify-between p-5 border-b border-slate-200/60 dark:border-slate-800/60 h-16">
        <div className="flex items-center gap-3 overflow-hidden">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#6366F1] to-[#7C3AED] flex items-center justify-center text-white shadow-md shadow-indigo-500/20 flex-shrink-0">
            <BarChart3 className="w-4 h-4 text-white" />
          </div>
          {!isCollapsed && (
            <div className="min-w-0 transition-opacity duration-300">
              <span className="font-extrabold text-[14px] text-slate-800 dark:text-white block tracking-tight">BARM AI</span>
              <small className="block font-bold text-indigo-500/80 text-[9px] uppercase tracking-widest -mt-0.5">
                Amazon SaaS
              </small>
            </div>
          )}
        </div>

        {/* Collapse Toggle Trigger */}
        <button
          onClick={toggleCollapse}
          className="w-6 h-6 rounded-lg bg-slate-50 dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-800 flex items-center justify-center text-slate-400 hover:text-slate-600 transition-colors focus:outline-none"
        >
          {isCollapsed ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
        </button>
      </div>

      {/* Nav Link List */}
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1 scrollbar-thin">
        {NAV.map((item) => {
          const isActive = currentPage === item.id;
          const Icon = item.icon;
          
          return (
            <div key={item.id} className="relative group">
              <button
                onClick={() => router.push(item.id === "overview" ? "/dashboard" : `/dashboard/${item.id}`)}
                className={cn(
                  "w-full flex items-center rounded-xl text-xs font-bold transition-all duration-200",
                  isCollapsed ? "justify-center p-2.5" : "gap-3 px-3 py-2.5",
                  isActive
                    ? "bg-gradient-to-r from-[#6366F1] to-[#7C3AED] text-white shadow-md shadow-indigo-500/10"
                    : "text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-900/60 hover:text-slate-800 dark:hover:text-white"
                )}
              >
                <Icon className={cn("w-4 h-4 flex-shrink-0", isActive ? "text-white" : "text-slate-400 dark:text-slate-500")} />
                {!isCollapsed && <span className="truncate">{item.label}</span>}
              </button>

              {/* Tooltip shown only in collapsed view */}
              {isCollapsed && (
                <div className="absolute left-full ml-3 top-1/2 -translate-y-1/2 px-2.5 py-1.5 bg-slate-900 dark:bg-slate-800 text-white text-[10px] font-black rounded-lg opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity duration-150 shadow-md border border-slate-700/30 whitespace-nowrap z-50">
                  {item.label}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* Sidebar Footer Details */}
      <div className="p-4 border-t border-slate-200/60 dark:border-slate-800/60 bg-slate-50/50 dark:bg-slate-950/20">
        {/* System Health / API Quotas (Only shown when expanded) */}
        {!isCollapsed && (
          <div className="mb-4">
            {/* AI Engine Status */}
            <div className="flex items-center justify-between text-[9px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">
              <span className="flex items-center gap-1"><Cpu size={10} /> Prediction Engine</span>
              <span className="text-emerald-500 flex items-center gap-1">
                <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />
                ONLINE
              </span>
            </div>
          </div>
        )}

        {/* User Account / Profile Info */}
        <div className="flex items-center gap-2.5">
          <div className={`w-8 h-8 rounded-xl bg-gradient-to-br ${avatarGradient} text-white flex items-center justify-center font-bold text-xs flex-shrink-0 shadow-sm`}>
            {initials}
          </div>
          {!isCollapsed && (
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-black text-slate-800 dark:text-white truncate uppercase tracking-wide">
                {loggedInUser} Account
              </p>
              <p className="text-[10px] text-slate-400 dark:text-slate-500 font-bold truncate leading-none mt-0.5">
                {account?.name?.split(" ").slice(0, 2).join(" ") || "Loading..."}
              </p>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
