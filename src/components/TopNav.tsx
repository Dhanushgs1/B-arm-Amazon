"use client";

import { useDashboard } from "@/lib/DashboardContext";
import { Bell, Moon, Sun, RefreshCw, Loader2, LayoutGrid, Megaphone, Menu, type LucideIcon } from "lucide-react";
import { BrandLogo, type BrandId } from "@/components/BrandLogo";
import { useState, useEffect } from "react";
import { motion, useReducedMotion } from "framer-motion";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { DateRangePicker } from "@/components/DateRangePicker";

// Example entries an older version seeded into every browser. They were never real alerts, so they
// are removed wherever they are still stored.
const DEMO_TITLES = new Set(["Low Stock Warning", "High ACOS Alert", "Manual Ingestion Success", "Gemini Analysis Ready"]);
import { cn } from "@/lib/utils";
import { MARKETPLACE_META, UPLOAD_ONLY_TAB_META, getMarketplaceTab, isUploadOnlyTab, marketplaceHome, type MarketplaceTab } from "@/lib/marketplace";

// Overall first, then one tab per platform with its own brand mark. The old B-ARM website's
// WooCommerce history (/dashboard/barm) is off the navigation by the seller's choice (24 Oct 2026) —
// its page and data are kept and it is still linked from its row on the Overall tab.
// Google & Meta Ads is a page of the Shopify workspace (/dashboard/shopify/sources) with its own tab
// here (user, 12 Nov 2026), so Shopify is highlighted everywhere under /dashboard/shopify except there.
type SwitcherTab = { id: MarketplaceTab; key: string; label: string; brand?: BrandId; icon?: LucideIcon; href?: string; color?: string; tagline?: string };
const ADS_PATH = "/dashboard/shopify/sources";
const MARKETPLACE_TABS: SwitcherTab[] = [
  { id: "compare", key: "compare", label: "Overall", icon: LayoutGrid },
  { id: "amazon", key: "amazon", label: "Amazon", brand: "amazon" },
  { id: "flipkart", key: "flipkart", label: "Flipkart", brand: "flipkart" },
  { id: "meesho", key: "meesho", label: "Meesho", brand: "meesho" },
  { id: "shopify", key: "shopify", label: "Shopify", brand: "shopify" },
  { id: "shopify", key: "ads", label: "Google & Meta", icon: Megaphone, href: ADS_PATH, color: "#2563EB", tagline: "Google & Meta Ads · spend against Shopify orders" },
];
const onAdsPage = (pathname: string | null) => !!pathname && (pathname === ADS_PATH || pathname.startsWith(`${ADS_PATH}/`));

function MarketplaceSwitcher() {
  const pathname = usePathname();
  const activeTab = getMarketplaceTab(pathname);
  const reduceMotion = useReducedMotion();

  return (
    <nav
      aria-label="Marketplaces"
      className="flex items-center gap-1 bg-slate-100/80 dark:bg-slate-900 p-1 rounded-xl ring-1 ring-slate-200/70 dark:ring-slate-800 shrink-0 max-w-full overflow-x-auto scrollbar-none"
    >
      {MARKETPLACE_TABS.map((tab) => {
        const isActive = tab.key === "ads" ? onAdsPage(pathname) : activeTab === tab.id && !(tab.key === "shopify" && onAdsPage(pathname));
        const meta =
          tab.color ? { color: tab.color, tagline: tab.tagline ?? tab.label }
          : tab.id === "compare" ? null
          : isUploadOnlyTab(tab.id) ? UPLOAD_ONLY_TAB_META[tab.id]
          : MARKETPLACE_META[tab.id];
        const Icon = tab.icon;
        const targetHref =
          tab.href ? tab.href
          : tab.id === "compare" ? "/dashboard/compare"
          : isUploadOnlyTab(tab.id) ? UPLOAD_ONLY_TAB_META[tab.id].home
          : marketplaceHome(tab.id);

        return (
          <div key={tab.key} className="flex items-center flex-shrink-0">
            <Link
              href={targetHref}
              aria-current={isActive ? "page" : undefined}
              aria-label={tab.label}
              className={cn(
                "relative flex items-center gap-1.5 h-8 px-2 sm:px-2.5 rounded-lg text-[11px] font-black whitespace-nowrap transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60",
                isActive ? "text-white" : "text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-white/70 dark:hover:bg-slate-800/70"
              )}
              title={meta ? meta.tagline : "Overall — every platform's KPIs together"}
            >
              {/* One shared highlight that slides between marketplaces, in each one's own colour. */}
              {isActive && (
                <motion.span
                  layoutId="marketplace-switcher-active"
                  transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 34 }}
                  className={cn("absolute inset-0 rounded-lg shadow-sm", tab.id === "compare" && "bg-emerald-600")}
                  style={meta ? { background: `linear-gradient(90deg, ${meta.color}, ${meta.color}cc)`, boxShadow: `0 4px 14px -4px ${meta.color}80` } : undefined}
                />
              )}
              {/* Every mark sits on the same 20px white tile, so brand colours stay readable on
                  the active tab's coloured highlight and in dark mode. */}
              <span className={cn("relative flex items-center justify-center w-5 h-5 rounded-md flex-shrink-0", tab.brand ? "bg-white ring-1 ring-slate-200/80 dark:ring-0 shadow-sm" : "")}>
                {tab.brand ? <BrandLogo brand={tab.brand} size={14} /> : Icon ? <Icon className="w-3.5 h-3.5" /> : null}
              </span>
              <span className="relative hidden sm:inline">{tab.label}</span>
            </Link>
          </div>
        );
      })}
    </nav>
  );
}

type Notification = {
  id: number;
  title: string;
  body: string;
  time: string;
  read: boolean;
  type: "warning" | "danger" | "success" | "info";
};

interface TopNavProps {
  onOpenMobileNav?: () => void;
}

export function TopNav({ onOpenMobileNav }: TopNavProps = {}) {
  const { loggedInUser, contextLoading, lastDataDate } = useDashboard();
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
      let parsed: Notification[] | null = null;
      try { parsed = saved ? JSON.parse(saved) : null; } catch { parsed = null; }
      if (Array.isArray(parsed)) {
        const real = parsed.filter((n) => !DEMO_TITLES.has(n?.title));
        if (real.length !== parsed.length) localStorage.setItem("ppcNotifications", JSON.stringify(real));
        setNotifications(real);
      } else {
        setNotifications([]);
      }
    };
    loadNotifs();
    window.addEventListener("storage", loadNotifs);
    return () => window.removeEventListener("storage", loadNotifs);
  }, []);

  const toggleTheme = () => {
    const next = theme === "light" ? "dark" : "light";
    document.documentElement.classList.toggle("dark", next === "dark");
    setTheme(next);
    // Saved where the page's start-up script and Settings read it, so the choice survives a reload.
    try {
      const saved = JSON.parse(localStorage.getItem("ppcUserSettings") || "{}");
      localStorage.setItem("ppcUserSettings", JSON.stringify({ ...saved, theme: next }));
    } catch {
      localStorage.setItem("ppcUserSettings", JSON.stringify({ theme: next }));
    }
  };

  // Signed in through the B-ARM ERP (see /api/auth/sso): show links to the other B-ARM sites.
  const [ssoEmail, setSsoEmail] = useState<string | null>(null);
  useEffect(() => { try { setSsoEmail(localStorage.getItem("barmSsoEmail")); } catch { /* private mode */ } }, []);

  const handleLogout = async () => {
    // End the server session first (clears the HttpOnly cookie); only then drop local state.
    // If the request fails the cookie is still valid, so say so rather than pretend to sign out.
    try {
      const r = await fetch("/api/auth/logout", { method: "POST" });
      if (!r.ok) throw new Error(String(r.status));
    } catch {
      window.alert("Could not sign out. Check your connection and try again.");
      return;
    }
    localStorage.removeItem("barmSsoEmail");
    localStorage.removeItem("ppcUser");
    localStorage.removeItem("ppcKeySlot");
    window.location.href = "/";
  };

  // Derive initials and label from logged-in user
  const isLkn = loggedInUser === "Lkn";
  const accountLabel = isLkn ? "LKN" : "Barm";
  const initials = isLkn ? "LK" : "BA";
  const avatarGradient = isLkn
    ? "from-indigo-500 to-violet-600"
    : "from-emerald-500 to-teal-600";

  return (
    <header className="flex items-center gap-3 px-3 sm:px-6 py-3 bg-white/75 dark:bg-slate-950/70 backdrop-blur-xl backdrop-saturate-150 border-b border-slate-200/70 dark:border-slate-800/70 shadow-[0_1px_0_rgba(15,23,42,0.02)] sticky top-0 z-30 flex-wrap">
      {/* Mobile Sidebar Toggle */}
      <button
        onClick={onOpenMobileNav}
        className="w-10 h-10 flex-shrink-0 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-500 dark:text-slate-400 flex items-center justify-center hover:border-indigo-500/50 hover:text-indigo-500 transition-colors shadow-sm focus:outline-none md:hidden"
        title="Open menu"
        aria-label="Open menu"
      >
        <Menu className="w-4 h-4" />
      </button>

      {/* Workspace Switcher */}
      <div className="hidden sm:flex items-center gap-2 bg-white dark:bg-slate-900 ring-1 ring-slate-200/80 dark:ring-slate-800 px-3.5 py-2.5 rounded-xl text-xs font-black shadow-sm">
        {contextLoading ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-500" />
        ) : (
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse flex-shrink-0" />
        )}
        <span className="text-slate-700 dark:text-slate-300 uppercase tracking-wider">{accountLabel}</span>
      </div>

      {/* Marketplace Switcher — Overall / Amazon / Flipkart / Meesho / Shopify */}
      <MarketplaceSwitcher />

      <div className="flex-grow hidden sm:block" />

      {/* Date Range Picker */}
      <DateRangePicker lastDataDate={lastDataDate || undefined} />

      {/* Refresh */}
      <button
        onClick={() => window.location.reload()}
        className="w-10 h-10 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-500 dark:text-slate-400 flex items-center justify-center hover:border-indigo-500/50 hover:text-indigo-500 transition-colors shadow-sm focus:outline-none"
        title="Refresh data"
        aria-label="Refresh data"
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
          aria-label={notifications.some(n => !n.read) ? "Notifications (unread)" : "Notifications"}
          aria-expanded={showNotifications}
        >
          <Bell className="w-4 h-4" />
          {notifications.some(n => !n.read) && (
            <span className="absolute top-2.5 right-2.5 w-2 h-2 rounded-full bg-red-500 animate-pulse" />
          )}
        </button>

        {showNotifications && (
          <div className="absolute right-0 mt-2 w-80 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-xl p-4 z-50 text-xs font-semibold backdrop-blur-xl animate-in fade-in slide-in-from-top-2 duration-200">
            <div className="flex items-center justify-between pb-2 border-b border-slate-200 dark:border-slate-850 mb-3">
              <span className="font-extrabold text-slate-800 dark:text-white uppercase tracking-wider text-[10px]">Notifications</span>
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
                <p className="text-center text-slate-500 dark:text-slate-400 py-4 font-semibold text-[11px]">No notifications yet. Confirmations from Settings and uploads appear here.</p>
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
        aria-label={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
      >
        {theme === "light" ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
      </button>

      {/* Other B-ARM sites (one click, already signed in) */}
      {ssoEmail && (
        <div className="flex items-center gap-1.5">
          <a href="https://b-arm.org/" target="_blank" rel="noopener" title="Open the B-ARM ERP (b-arm.org)" aria-label="Open the B-ARM ERP (opens in a new tab)"
            className="h-10 px-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-[10px] font-black uppercase tracking-wide text-slate-500 dark:text-slate-400 flex items-center hover:border-indigo-500/50 hover:text-indigo-500 transition-colors shadow-sm">
            ERP
          </a>
          <a href="https://b-arm.org/?sso_to=hr" target="_blank" rel="noopener" title="Open the HR portal (hr.b-arm.org)" aria-label="Open the HR portal (opens in a new tab)"
            className="h-10 px-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-[10px] font-black uppercase tracking-wide text-slate-500 dark:text-slate-400 flex items-center hover:border-indigo-500/50 hover:text-indigo-500 transition-colors shadow-sm">
            HR
          </a>
        </div>
      )}

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
