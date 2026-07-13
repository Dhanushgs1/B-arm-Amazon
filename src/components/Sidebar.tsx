"use client";

import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { useDashboard } from "@/lib/DashboardContext";
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

  const isLkn = loggedInUser === "Lkn";
  const avatarGradient = isLkn ? "from-indigo-500 to-violet-600" : "from-emerald-500 to-teal-600";
  const initials = isLkn ? "LK" : "BA";

  // Simple current page detection
  const currentPage = pathname === "/dashboard" ? "overview" : (pathname || "").split("/").pop() || "overview";

  return (
    <aside className="w-[240px] flex-shrink-0 bg-popover/80 backdrop-blur-xl border-r border-border flex flex-col sticky top-0 h-screen z-40">
      <div className="flex items-center gap-3 p-5 pb-4 font-extrabold text-[15px]">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-accent flex items-center justify-center text-white text-[14px] font-black shadow-lg">
          P
        </div>
        <div>
          PPC Command
          <small className="block font-medium text-muted-foreground text-[11px] mt-0.5">
            Enterprise Analytics
          </small>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-2 space-y-1">
        {NAV.map((item) => {
          const isActive = currentPage === item.id;
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={() => router.push(item.id === "overview" ? "/dashboard" : `/dashboard/${item.id}`)}
              className={cn(
                "w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-semibold transition-all duration-200",
                isActive
                  ? "bg-gradient-to-r from-primary to-accent text-white shadow-md shadow-primary/20"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <Icon className={cn("w-4 h-4", isActive ? "text-white" : "text-muted-foreground")} />
              {item.label}
            </button>
          );
        })}
      </nav>

      <div className="p-4 border-t border-border">
        <div className="flex items-center gap-2.5">
          <div className={`w-8 h-8 rounded-full bg-gradient-to-br ${avatarGradient} text-white flex items-center justify-center font-bold text-xs flex-shrink-0`}>
            {initials}
          </div>
          <div className="min-w-0">
            <p className="text-xs font-bold text-foreground truncate">{loggedInUser}</p>
            <p className="text-[11px] text-muted-foreground truncate">{account?.name?.split(" ").slice(0, 2).join(" ") || "Loading..."}</p>
          </div>
        </div>
      </div>
    </aside>
  );
}
