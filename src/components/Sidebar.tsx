"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { useDashboard } from "@/lib/DashboardContext";
import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
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
  Wand2,
  ShoppingCart,
  Boxes,
  GitCompare,
  Store,
  UploadCloud,
  Star,
  type LucideIcon
} from "lucide-react";
import { MARKETPLACE_META, getMarketplaceTab } from "@/lib/marketplace";

interface SidebarNavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  path?: string;
}

interface SidebarNavSection {
  label: string;
  items: SidebarNavItem[];
}

const NAV_SECTIONS: SidebarNavSection[] = [
  {
    label: "Workspace",
    items: [
      { id: "overview", label: "Overview", icon: LayoutDashboard },
      { id: "upload", label: "Upload", icon: UploadCloud },
      { id: "reports", label: "Download", icon: BarChart3 },
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
      { id: "ratings-reviews", label: "⭐ Ratings & Reviews Intelligence", icon: Star },
      { id: "ai", label: "AI Assistant", icon: Bot },
      { id: "settings", label: "Settings", icon: Settings },
    ],
  },
];

// Flipkart doesn't expose an ads API the way Amazon Ads does, so it gets a
// lighter nav — Overview, Orders, Inventory, Sales — instead of trying to
// mirror every Amazon Advertising page.
function marketplaceNavSections(marketplace: "flipkart"): SidebarNavSection[] {
  const mName = MARKETPLACE_META[marketplace].label;
  return [
    {
      label: `${mName} Workspace`,
      items: [
        { id: "overview", label: "Overview", icon: LayoutDashboard, path: `/dashboard/${marketplace}` },
        { id: "upload", label: "Upload", icon: UploadCloud, path: `/dashboard/${marketplace}/upload` },
        { id: "reports", label: "Download", icon: BarChart3, path: `/dashboard/${marketplace}/reports` },
      ],
    },
    {
      label: `${mName} Advertising`,
      items: [
        { id: "campaigns", label: "Campaigns", icon: Megaphone, path: `/dashboard/${marketplace}/campaigns` },
        { id: "adgroups", label: "Ad Groups", icon: LayoutGrid, path: `/dashboard/${marketplace}/adgroups` },
        { id: "placements", label: "Placements", icon: Target, path: `/dashboard/${marketplace}/placements` },
        { id: "keywords", label: "Keywords", icon: KeyRound, path: `/dashboard/${marketplace}/keywords` },
        { id: "searchterms", label: "Search Terms", icon: Search, path: `/dashboard/${marketplace}/searchterms` },
        { id: "bids", label: "Bid Adjustment", icon: Sliders, path: `/dashboard/${marketplace}/bids` },
        { id: "optimization", label: "Rules & Optimization", icon: Wand2, path: `/dashboard/${marketplace}/optimization` },
      ],
    },
    {
      label: `${mName} Catalog`,
      items: [
        { id: "products", label: "Products", icon: Package, path: `/dashboard/${marketplace}/products` },
        { id: "inventory", label: "Inventory", icon: Boxes, path: `/dashboard/${marketplace}/inventory` },
        { id: "marketshare", label: "Market Share", icon: TrendingUp, path: `/dashboard/${marketplace}/marketshare` },
      ],
    },
    {
      label: "Intelligence & Workspace",
      items: [
        { id: "ratings-reviews", label: "⭐ Ratings & Reviews Intelligence", icon: Star, path: `/dashboard/${marketplace}/ratings-reviews` },
        { id: "ai", label: "AI Assistant", icon: Bot, path: `/dashboard/${marketplace}/ai` },
        { id: "compare", label: "Combined Overall View", icon: GitCompare, path: "/dashboard/compare" },
        { id: "settings", label: "Settings", icon: Settings, path: "/dashboard/settings" },
      ],
    },
  ];
}

const COMPARE_NAV_SECTIONS: SidebarNavSection[] = [
  {
    label: "Combined Workspace",
    items: [
      { id: "compare", label: "Combined Overall View", icon: GitCompare, path: "/dashboard/compare" },
    ],
  },
  {
    label: "Switch Marketplace",
    items: [
      { id: "amazon", label: "Amazon Analytics", icon: ShoppingCart, path: "/dashboard" },
      { id: "flipkart", label: "Flipkart Analytics", icon: Store, path: "/dashboard/flipkart" },
    ],
  },
  {
    label: "Intelligence & Settings",
    items: [
      { id: "ai", label: "✨ AI Assistant", icon: Bot, path: "/dashboard/ai" },
      { id: "optimization", label: "Amazon Rules Engine", icon: Wand2, path: "/dashboard/optimization" },
      { id: "settings", label: "Settings", icon: Settings, path: "/dashboard/settings" },
    ],
  },
];


interface SidebarProps {
  mobileOpen?: boolean;
  onCloseMobile?: () => void;
}

export function Sidebar({ mobileOpen = false, onCloseMobile }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { loggedInUser, account } = useDashboard();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const marketplace = getMarketplaceTab(pathname);

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

  const sections =
    marketplace === "flipkart"
      ? marketplaceNavSections(marketplace)
      : marketplace === "compare"
      ? COMPARE_NAV_SECTIONS
      : NAV_SECTIONS;

  const marketplaceRoot = marketplace === "flipkart" ? `/dashboard/${marketplace}` : null;
  const currentPage =
    pathname === "/dashboard" || pathname === marketplaceRoot
      ? "overview"
      : (pathname || "").split("/").pop() || "overview";

  const sidebarTagline =
    marketplace === "amazon" ? "Amazon Analytics"
    : marketplace === "compare" ? "Marketplace Comparison"
    : `${MARKETPLACE_META[marketplace].label} Analytics`;

  // Shared nav body — rendered once for the always-in-flow desktop sidebar
  // and once inside the mobile overlay drawer (which is never "collapsed").
  const renderNavBody = (collapsed: boolean, closeOnNavigate: boolean) => (
    <>
      {/* Sidebar Header / Logo */}
      <div className="flex items-center justify-between px-3.5 py-3 border-b border-slate-900 h-[60px]">
        <div className="flex items-center gap-2.5 overflow-hidden">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-[#6D5EF8] to-[#8B5CF6] flex items-center justify-center text-white shadow-md shadow-indigo-500/25 flex-shrink-0">
            <BarChart3 className="w-4 h-4 text-white" />
          </div>
          {!collapsed && (
            <div className="min-w-0 transition-opacity duration-300">
              <span className="font-extrabold text-[13.5px] text-white block tracking-tight">{isLkn ? "LKN AI" : "Marketplace360"}</span>
              <small className="block font-bold text-indigo-400/90 text-[8px] uppercase tracking-widest -mt-1 truncate">
                {sidebarTagline}
              </small>
            </div>
          )}
        </div>

        {/* Collapse Toggle Trigger — desktop only, no-op concept on the mobile drawer */}
        {closeOnNavigate ? (
          <button
            onClick={onCloseMobile}
            className="w-5.5 h-5.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 flex items-center justify-center text-slate-400 hover:text-slate-300 transition-colors focus:outline-none cursor-pointer"
          >
            <ChevronLeft size={10} />
          </button>
        ) : (
          <button
            onClick={toggleCollapse}
            className="w-5.5 h-5.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 flex items-center justify-center text-slate-400 hover:text-slate-300 transition-colors focus:outline-none cursor-pointer"
          >
            {collapsed ? <ChevronRight size={10} /> : <ChevronLeft size={10} />}
          </button>
        )}
      </div>

      {/* Nav Link List */}
      <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-2.5 scrollbar-none">
        {sections.map((section) => (
          <div key={section.label} className="space-y-0.5">
            {!collapsed && (
              <p className="px-2 pb-0.5 text-[9px] font-extrabold uppercase tracking-widest text-slate-500">
                {section.label}
              </p>
            )}
            {section.items.map((item) => {
              const isActive = currentPage === item.id;
              const Icon = item.icon;

              const targetHref = item.path || (item.id === "overview" ? "/dashboard" : `/dashboard/${item.id}`);

              return (
                <div key={item.id} className="relative group">
                  <Link
                    href={targetHref}
                    onClick={() => {
                      if (closeOnNavigate) onCloseMobile?.();
                    }}
                    className={cn(
                      "w-full flex items-center rounded-xl text-[12px] font-bold transition-all duration-200 cursor-pointer",
                      collapsed ? "justify-center p-2" : "gap-2.5 px-2 py-1.5",
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
                    {!collapsed && <span className="truncate">{item.label}</span>}
                  </Link>

                  {/* Tooltip shown only in collapsed view */}
                  {collapsed && (
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

      {/* Pinned AI CTA */}
      <div className={cn("px-2 pb-3 pt-2 border-t border-slate-800", collapsed && "flex justify-center")}>
        <Link
          href="/dashboard/ai"
          className={cn(
            "flex items-center rounded-xl transition-all duration-200 font-black text-[11px] bg-gradient-to-r from-indigo-600 to-violet-700 text-white hover:from-indigo-500 hover:to-violet-600 shadow-md shadow-indigo-500/20",
            collapsed ? "justify-center p-2 w-10 h-10" : "gap-2.5 px-3 py-2 w-full"
          )}
          onClick={() => { if (closeOnNavigate) onCloseMobile?.(); }}
          title="AI Assistant"
        >
          <span className="w-5 h-5 rounded-lg bg-white/20 flex items-center justify-center flex-shrink-0">
            <Bot className="w-3 h-3 text-white" />
          </span>
          {!collapsed && <span>✨ AI Assistant</span>}
        </Link>
      </div>
    </>
  );

  return (
    <>
      {/* Desktop sidebar — always in the layout flow from md breakpoint up */}
      <aside
        className={cn(
          "hidden md:flex bg-slate-950 border-r border-slate-900 flex-col sticky top-0 h-screen z-40 transition-all duration-300 shadow-sm",
          isCollapsed ? "w-[64px]" : "w-[220px]"
        )}
      >
        {renderNavBody(isCollapsed, false)}
      </aside>

      {/* Mobile drawer — only mounted while open, avoids fighting Tailwind's transform utilities */}
      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              key="sidebar-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/50 z-40 md:hidden"
              onClick={onCloseMobile}
            />
            <motion.aside
              key="sidebar-drawer"
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ duration: 0.25, ease: "easeOut" }}
              className="fixed inset-y-0 left-0 w-[240px] bg-slate-950 border-r border-slate-900 flex flex-col h-screen z-50 shadow-2xl md:hidden"
            >
              {renderNavBody(false, true)}
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
