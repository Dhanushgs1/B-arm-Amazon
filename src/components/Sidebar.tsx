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
  TrendingUp,
  Sliders,
  Wand2
} from "lucide-react";

const NAV_SECTIONS = [
  {
    label: "Workspace",
    items: [
      { id: "overview", label: "Overview", icon: LayoutDashboard },
      { id: "reports", label: "Reports", icon: BarChart3 },
    ],
  },
  {
    label: "Advertising",
    items: [
      { id: "campaigns", label: "Campaigns", icon: Megaphone },
      { id: "adgroups", label: "Ad Groups", icon: LayoutGrid },
      { id: "placements", label: "Placements", icon: Target },
      { id: "keywords", label: "Keywords", icon: KeyRound },
      { id: "searchterms", label: "Search Terms", icon: Search },
      { id: "bids", label: "Bid Adjustment", icon: Sliders },
      { id: "optimization", label: "Optimization", icon: Wand2 },
    ],
  },
  {
    label: "Catalog",
    items: [
      { id: "products", label: "Products", icon: Package },
      { id: "inventory", label: "Inventory", icon: Box },
      { id: "marketshare", label: "Market Share", icon: TrendingUp },
    ],
  },
  {
    label: "Intelligence",
    items: [
      { id: "ai", label: "AI Assistant", icon: Bot },
      { id: "settings", label: "Settings", icon: Settings },
    ],
  },
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
  const avatarGradient = isLkn ? "from-[#6D5EF8] to-[#8B5CF6]" : "from-emerald-500 to-teal-600";
  const initials = isLkn ? "LK" : "BA";

  const currentPage = pathname === "/dashboard" ? "overview" : (pathname || "").split("/").pop() || "overview";

  return (
    <aside
      className={cn(
        "flex-shrink-0 bg-slate-950 border-r border-slate-900 flex flex-col sticky top-0 h-screen z-40 transition-all duration-300 shadow-sm",
        isCollapsed ? "w-[64px]" : "w-[220px]"
      )}
    >
      {/* Sidebar Header / Logo */}
      <div className="flex items-center justify-between px-3.5 py-3 border-b border-slate-900 h-[60px]">
        <div className="flex items-center gap-2.5 overflow-hidden">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-[#6D5EF8] to-[#8B5CF6] flex items-center justify-center text-white shadow-md shadow-indigo-500/25 flex-shrink-0">
            <BarChart3 className="w-4 h-4 text-white" />
          </div>
          {!isCollapsed && (
            <div className="min-w-0 transition-opacity duration-300">
              <span className="font-extrabold text-[13.5px] text-white block tracking-tight">BARM AI</span>
              <small className="block font-bold text-indigo-400/90 text-[8px] uppercase tracking-widest -mt-1">
                Amazon Analytics
              </small>
            </div>
          )}
        </div>

        {/* Collapse Toggle Trigger */}
        <button
          onClick={toggleCollapse}
          className="w-5.5 h-5.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 flex items-center justify-center text-slate-400 hover:text-slate-300 transition-colors focus:outline-none cursor-pointer"
        >
          {isCollapsed ? <ChevronRight size={10} /> : <ChevronLeft size={10} />}
        </button>
      </div>

      {/* Nav Link List */}
      <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-2.5 scrollbar-none">
        {NAV_SECTIONS.map((section) => (
          <div key={section.label} className="space-y-0.5">
            {!isCollapsed && (
              <p className="px-2 pb-0.5 text-[9px] font-extrabold uppercase tracking-widest text-slate-500">
                {section.label}
              </p>
            )}
            {section.items.map((item) => {
              const isActive = currentPage === item.id;
              const Icon = item.icon;

              return (
                <div key={item.id} className="relative group">
                  <button
                    onClick={() => router.push(item.id === "overview" ? "/dashboard" : `/dashboard/${item.id}`)}
                    className={cn(
                      "w-full flex items-center rounded-xl text-[12px] font-bold transition-all duration-200 cursor-pointer",
                      isCollapsed ? "justify-center p-2" : "gap-2.5 px-2 py-1.5",
                      isActive
                        ? "bg-gradient-to-r from-[#6D5EF8] to-[#8B5CF6] text-white shadow-md shadow-indigo-500/20"
                        : "text-slate-400 hover:bg-white/5 hover:text-white hover:translate-x-0.5"
                    )}
                  >
                    <span className={cn(
                      "w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors",
                      isActive ? "bg-white/15" : "bg-slate-900 group-hover:bg-white/10"
                    )}>
                      <Icon className={cn("w-3.5 h-3.5", isActive ? "text-white" : "text-slate-400")} />
                    </span>
                    {!isCollapsed && <span className="truncate">{item.label}</span>}
                  </button>

                  {/* Tooltip shown only in collapsed view */}
                  {isCollapsed && (
                    <div className="absolute left-full ml-3 top-1/2 -translate-y-1/2 px-2.5 py-1.5 bg-slate-900 text-white text-[10px] font-black rounded-lg opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity duration-150 shadow-md border border-slate-700/30 whitespace-nowrap z-50">
                      {item.label}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </nav>


    </aside>
  );
}
