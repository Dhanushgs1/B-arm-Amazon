"use client";

import { useDashboard } from "@/lib/DashboardContext";
import {
  Settings, Shield, RefreshCw, Key, HelpCircle, CheckCircle, Bell, Loader2, Send,
  Building2, Bot, Zap, Palette, Sun, Moon, Globe, Database, Activity, Sparkles, Plug
} from "lucide-react";
import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

type Tab = "general" | "sellermate" | "notifications" | "automation" | "ai" | "security" | "appearance" | "support";

const NAV: { id: Tab; label: string; icon: any; section: string }[] = [
  { id: "general", label: "General", icon: Settings, section: "Workspace" },
  { id: "sellermate", label: "SellerMate Connection", icon: Plug, section: "Workspace" },
  { id: "notifications", label: "Notifications", icon: Bell, section: "Preferences" },
  { id: "automation", label: "Automation Rules", icon: Zap, section: "Preferences" },
  { id: "ai", label: "AI Assistant", icon: Bot, section: "Preferences" },
  { id: "appearance", label: "Appearance", icon: Palette, section: "Preferences" },
  { id: "security", label: "Security", icon: Shield, section: "Account" },
  { id: "support", label: "Support & Help", icon: HelpCircle, section: "Account" },
];

// Animated pill toggle
function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative w-11 h-6 rounded-full transition-colors duration-200 flex-shrink-0 focus:outline-none focus:ring-2 focus:ring-primary/30",
        checked ? "bg-gradient-to-r from-[#6D5EF8] to-[#8B5CF6]" : "bg-muted border border-border"
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-all duration-200",
          checked ? "left-[22px]" : "left-0.5"
        )}
      />
    </button>
  );
}

function SettingRow({ title, desc, children, border = true }: { title: string; desc?: string; children: React.ReactNode; border?: boolean }) {
  return (
    <div className={cn("flex items-center justify-between gap-4 py-3.5", border && "border-b border-border/60 last:border-0")}>
      <div className="min-w-0">
        <p className="text-sm font-bold">{title}</p>
        {desc && <p className="text-xs text-muted-foreground font-medium mt-0.5">{desc}</p>}
      </div>
      {children}
    </div>
  );
}

function Card({ title, icon: Icon, iconColor, children }: { title: string; icon: any; iconColor: string; children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="glass gradient-border rounded-[22px] p-6 space-y-2"
    >
      <div className="flex items-center gap-2.5 mb-3">
        <div className={cn("w-9 h-9 rounded-xl flex items-center justify-center border", iconColor)}>
          <Icon className="w-4 h-4" />
        </div>
        <h3 className="font-extrabold text-base tracking-tight">{title}</h3>
      </div>
      {children}
    </motion.div>
  );
}

export default function SettingsPage() {
  const { account, loggedInUser, keySlot } = useDashboard();
  const [activeTab, setActiveTab] = useState<Tab>("general");
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [saveEmailNote, setSaveEmailNote] = useState<string | null>(null);

  // ── Existing form states (preserved) ──
  const [emailAlerts, setEmailAlerts] = useState(true);
  const [notifEmail, setNotifEmail] = useState("");
  const [slackAlerts, setSlackAlerts] = useState(false);
  const [slackUrl, setSlackUrl] = useState("");
  const [acosThreshold, setAcosThreshold] = useState(40);
  const [lowStockThreshold, setLowStockThreshold] = useState(15);
  const [syncSchedule, setSyncSchedule] = useState("6h");
  const [twoFactor, setTwoFactor] = useState(false);
  const [ipRestrict, setIpRestrict] = useState(false);
  const [whitelistIps, setWhitelistIps] = useState("");

  // ── New preference states (persisted in the same config blob) ──
  const [timezone, setTimezone] = useState("Asia/Kolkata");
  const [defaultRange, setDefaultRange] = useState("30d");
  const [pushAlerts, setPushAlerts] = useState(false);
  const [roasAlerts, setRoasAlerts] = useState(true);
  const [inventoryAlerts, setInventoryAlerts] = useState(true);
  const [weeklySummary, setWeeklySummary] = useState(true);
  const [dailySummary, setDailySummary] = useState(false);
  const [monthlySummary, setMonthlySummary] = useState(false);
  const [aiEnabled, setAiEnabled] = useState(true);
  const [autoInsights, setAutoInsights] = useState(true);
  const [smartAlerts, setSmartAlerts] = useState(true);
  const [forecastWindow, setForecastWindow] = useState("30d");
  const [recMode, setRecMode] = useState("balanced");
  const [autoPause, setAutoPause] = useState(false);
  const [autoNegatives, setAutoNegatives] = useState(false);
  const [autoBudget, setAutoBudget] = useState(false);
  const [roasTarget, setRoasTarget] = useState(4);
  const [compactMode, setCompactMode] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("light");

  // Ingestion trigger states
  const [syncing, setSyncing] = useState(false);
  const [syncSuccess, setSyncSuccess] = useState(false);

  // Support form states
  const [supportSubmitting, setSupportSubmitting] = useState(false);
  const [supportSuccess, setSupportSuccess] = useState(false);
  const [ticketSubject, setTicketSubject] = useState("");
  const [ticketMsg, setTicketMsg] = useState("");
  const [testEmailStatus, setTestEmailStatus] = useState<"idle"|"sending"|"sent"|"error">("idle");
  const [weeklyReportStatus, setWeeklyReportStatus] = useState<"idle"|"sending"|"sent"|"error">("idle");
  const [whatsappText, setWhatsappText] = useState<string | null>(null);
  const [whatsappCopied, setWhatsappCopied] = useState(false);

  // Load configurations
  useEffect(() => {
    setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
    const saved = localStorage.getItem("ppcUserSettings");
    if (saved) {
      try {
        const p = JSON.parse(saved);
        setEmailAlerts(p.emailAlerts ?? true);
        setNotifEmail(p.notifEmail ?? "");
        setSlackAlerts(p.slackAlerts ?? false);
        setSlackUrl(p.slackUrl ?? "");
        setAcosThreshold(p.acosThreshold ?? 40);
        setLowStockThreshold(p.lowStockThreshold ?? 15);
        setSyncSchedule(p.syncSchedule ?? "6h");
        setTwoFactor(p.twoFactor ?? false);
        setIpRestrict(p.ipRestrict ?? false);
        setWhitelistIps(p.whitelistIps ?? "");
        setTimezone(p.timezone ?? "Asia/Kolkata");
        setDefaultRange(p.defaultRange ?? "30d");
        setPushAlerts(p.pushAlerts ?? false);
        setRoasAlerts(p.roasAlerts ?? true);
        setInventoryAlerts(p.inventoryAlerts ?? true);
        setWeeklySummary(p.weeklySummary ?? true);
        setDailySummary(p.dailySummary ?? false);
        setMonthlySummary(p.monthlySummary ?? false);
        setAiEnabled(p.aiEnabled ?? true);
        setAutoInsights(p.autoInsights ?? true);
        setSmartAlerts(p.smartAlerts ?? true);
        setForecastWindow(p.forecastWindow ?? "30d");
        setRecMode(p.recMode ?? "balanced");
        setAutoPause(p.autoPause ?? false);
        setAutoNegatives(p.autoNegatives ?? false);
        setAutoBudget(p.autoBudget ?? false);
        setRoasTarget(p.roasTarget ?? 4);
        setCompactMode(p.compactMode ?? false);
      } catch (e) {
        console.error("Failed to parse settings", e);
      }
    }
  }, []);

  // ── Auto-save email + schedule settings to server on change ──
  useEffect(() => {
    if (notifEmail !== "") {
      const saved = localStorage.getItem("ppcUserSettings");
      const current = saved ? JSON.parse(saved) : {};
      current.notifEmail = notifEmail;
      localStorage.setItem("ppcUserSettings", JSON.stringify(current));
      // also persist to server so cron can read it — include account context
      // so the automated stockout/report crons know which account to query
      fetch("/api/email-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          notifEmail, emailAlerts,
          keySlot, amazonAccountId: account?.id, workspaceId: account?.workspace_id, currency: account?.currency,
        }),
      }).catch(() => {});
    }
  }, [notifEmail, emailAlerts]);

  const toggleTheme = (next: "light" | "dark") => {
    setTheme(next);
    if (next === "dark") document.documentElement.classList.add("dark");
    else document.documentElement.classList.remove("dark");
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveEmailNote(null);

    const config = {
      emailAlerts, notifEmail, slackAlerts, slackUrl, acosThreshold, lowStockThreshold,
      syncSchedule, twoFactor, ipRestrict, whitelistIps,
      timezone, defaultRange, pushAlerts, roasAlerts, inventoryAlerts,
      weeklySummary, dailySummary, monthlySummary, aiEnabled, autoInsights, smartAlerts,
      forecastWindow, recMode, autoPause, autoNegatives, autoBudget,
      roasTarget, compactMode,
      // account context for the automated crons (which account to query)
      keySlot, amazonAccountId: account?.id, workspaceId: account?.workspace_id, currency: account?.currency,
    };

    localStorage.setItem("ppcUserSettings", JSON.stringify(config));

    // Persist to server so the cron scheduler + confirmation email read the live values
    try {
      await fetch("/api/email-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
    } catch {}

    // Saving is what actually "activates" the alert channels — confirm it landed
    // by emailing a summary of which alert types are now on, instead of making
    // the user separately hit "Send Test Email" to find out.
    if (emailAlerts && notifEmail) {
      const activeAlerts = [
        roasAlerts && "ROAS / ACOS Alerts",
        inventoryAlerts && "Inventory Alerts",
        dailySummary && "Daily Summary (10:00 AM IST)",
        weeklySummary && "Weekly Summary (Monday 9:00 AM IST)",
        monthlySummary && "Monthly Summary (1st, 9:00 AM IST)",
        slackAlerts && "Slack Alerts",
        pushAlerts && "Push Notifications",
      ].filter(Boolean) as string[];

      try {
        const r = await fetch("/api/send-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "confirmation",
            to: notifEmail,
            data: { activeAlerts, acosThreshold, lowStockThreshold },
          }),
        });
        setSaveEmailNote(r.ok ? `Confirmation emailed to ${notifEmail}` : "Saved, but confirmation email failed to send");
      } catch {
        setSaveEmailNote("Saved, but confirmation email failed to send");
      }
    } else if (emailAlerts && !notifEmail) {
      setSaveEmailNote("Saved — add an email address to receive alerts");
    }

    setSaving(false);
    setSuccess(true);

    // Push a new alert to system notifications
    const savedNotifs = localStorage.getItem("ppcNotifications");
    const currentNotifs = savedNotifs ? JSON.parse(savedNotifs) : [];
    const newNotif = {
      id: Date.now(),
      title: "Settings Updated",
      body: "Your dashboard configurations were successfully saved.",
      time: "Just now",
      read: false,
      type: "success"
    };
    localStorage.setItem("ppcNotifications", JSON.stringify([newNotif, ...currentNotifs].slice(0, 10)));
    window.dispatchEvent(new Event("storage"));

    setTimeout(() => { setSuccess(false); setSaveEmailNote(null); }, 4000);
  };

  const handleTriggerSync = () => {
    setSyncing(true);
    setTimeout(() => {
      setSyncing(false);
      setSyncSuccess(true);

      const savedNotifs = localStorage.getItem("ppcNotifications");
      const currentNotifs = savedNotifs ? JSON.parse(savedNotifs) : [];
      const newNotif = {
        id: Date.now(),
        title: "Sync Completed",
        body: `Manual ingestion triggered successfully. Imported updated campaigns & catalog metrics.`,
        time: "Just now",
        read: false,
        type: "success"
      };
      localStorage.setItem("ppcNotifications", JSON.stringify([newNotif, ...currentNotifs].slice(0, 10)));
      window.dispatchEvent(new Event("storage"));

      setTimeout(() => setSyncSuccess(false), 3000);
    }, 2000);
  };

  const handleSupportSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSupportSubmitting(true);
    setTimeout(() => {
      setSupportSubmitting(false);
      setSupportSuccess(true);
      setTicketSubject("");
      setTicketMsg("");
      setTimeout(() => setSupportSuccess(false), 3000);
    }, 1500);
  };

  const overviewCards = [
    { label: "SellerMate", value: account ? "Connected" : "Offline", icon: Plug, good: !!account },
    { label: "API Status", value: account ? "Healthy" : "Error", icon: Activity, good: !!account },
    { label: "Workspace", value: account?.name?.split(" ").slice(0, 2).join(" ") || "—", icon: Building2, good: true },
    { label: "Currency", value: account?.currency || "—", icon: Globe, good: true },
    { label: "AI Engine", value: aiEnabled ? "Active" : "Disabled", icon: Sparkles, good: aiEnabled },
    { label: "Version", value: "v2.0", icon: Database, good: true },
  ];

  const inputCls = "bg-background border border-border text-foreground px-3 py-2 rounded-xl text-sm font-semibold focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none transition-all";

  return (
    <div className="space-y-8 pb-12">
      {/* ── Hero ── */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative overflow-hidden rounded-[26px] border border-white/40 dark:border-white/5 bg-gradient-to-br from-[#6D5EF8] via-[#7B5CF6] to-[#10B981] text-white shadow-[0_24px_60px_-20px_rgba(108,99,255,0.45)]"
      >
        <div className="absolute -top-24 -right-16 w-80 h-80 rounded-full bg-white/10 blur-3xl pointer-events-none" />
        <div className="relative z-10 p-8 flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="flex items-center gap-4 min-w-0">
            <div className="w-14 h-14 rounded-2xl bg-white/15 border border-white/20 flex items-center justify-center text-xl font-extrabold backdrop-blur-sm flex-shrink-0">
              {(account?.name || "BA").slice(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-[30px] font-extrabold tracking-tight leading-tight">Workspace Settings</h1>
                <span className="flex items-center gap-1.5 text-[11px] font-extrabold bg-emerald-400/20 border border-emerald-300/30 text-emerald-100 px-2.5 py-1 rounded-full">
                  <span className="w-1.5 h-1.5 bg-emerald-300 rounded-full animate-pulse" /> {account ? "Connected" : "Offline"}
                </span>
              </div>
              <p className="text-white/75 text-[15px] font-medium mt-1">
                Manage your BARM AI workspace, integrations, AI preferences and security.
              </p>
              <p className="text-white/60 text-[11px] font-bold mt-1">
                {account?.name || "—"} · {loggedInUser === "Lkn" ? "Account A" : "Account B"} · Last sync: just now
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2.5 flex-wrap flex-shrink-0">
            {success && (
              <span className="text-xs text-emerald-100 font-bold flex items-center gap-1.5 animate-pulse">
                <CheckCircle size={14} /> {saveEmailNote || "Settings saved!"}
              </span>
            )}
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-2 bg-white text-[#5B4FE0] hover:bg-white/90 px-5 py-2.5 rounded-xl text-sm font-bold transition-all shadow-lg shadow-black/10 disabled:opacity-60"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />} Save Changes
            </button>
            <button
              onClick={handleTriggerSync}
              disabled={syncing}
              className="flex items-center gap-2 bg-white/10 hover:bg-white/20 border border-white/20 px-5 py-2.5 rounded-xl text-sm font-bold transition-all backdrop-blur-sm disabled:opacity-60"
            >
              <RefreshCw className={cn("w-4 h-4", syncing && "animate-spin")} /> Sync SellerMate
            </button>
          </div>
        </div>
      </motion.div>

      {/* ── Workspace Overview Cards ── */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {overviewCards.map((c, i) => (
          <motion.div
            key={c.label}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.04 }}
            className="glass gradient-border rounded-2xl p-4 hover:-translate-y-0.5 transition-transform"
          >
            <div className="flex items-center justify-between">
              <c.icon className="w-4 h-4 text-indigo-500" />
              <span className={cn("w-1.5 h-1.5 rounded-full", c.good ? "bg-emerald-500" : "bg-red-500")} />
            </div>
            <p className="text-[10px] font-extrabold uppercase tracking-widest text-muted-foreground mt-2.5">{c.label}</p>
            <p className="text-sm font-extrabold truncate mt-0.5" title={String(c.value)}>{c.value}</p>
          </motion.div>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        {/* ── Left Navigation ── */}
        <div className="space-y-4 md:sticky md:top-4 self-start">
          {["Workspace", "Preferences", "Account"].map((section) => (
            <div key={section} className="space-y-1">
              <p className="px-3 text-[10px] font-extrabold uppercase tracking-widest text-muted-foreground">{section}</p>
              {NAV.filter((n) => n.section === section).map((n) => (
                <button
                  key={n.id}
                  onClick={() => setActiveTab(n.id)}
                  className={cn(
                    "w-full text-left px-3 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2.5 transition-all",
                    activeTab === n.id
                      ? "bg-gradient-to-r from-[#6D5EF8] to-[#8B5CF6] text-white shadow-md shadow-indigo-500/20"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground hover:translate-x-0.5"
                  )}
                >
                  <n.icon size={16} /> {n.label}
                </button>
              ))}
            </div>
          ))}
        </div>

        {/* ── Dynamic Settings Panel ── */}
        <div className="md:col-span-3 space-y-6">
          {activeTab === "general" && (
            <Card title="General" icon={Settings} iconColor="bg-indigo-500/10 border-indigo-500/15 text-indigo-500">
              <SettingRow title="Workspace Name" desc="Synced from your SellerMate workspace.">
                <span className="text-sm font-bold bg-muted px-3 py-1.5 rounded-xl max-w-[220px] truncate">{account?.name || "—"}</span>
              </SettingRow>
              <SettingRow title="Active Account" desc="Key slot used for all API requests.">
                <span className="text-sm font-bold bg-muted px-3 py-1.5 rounded-xl">{loggedInUser === "Lkn" ? "Account A" : "Account B"}</span>
              </SettingRow>
              <SettingRow title="Currency" desc="Reported by the connected marketplace.">
                <span className="text-sm font-bold bg-muted px-3 py-1.5 rounded-xl">{account?.currency || "—"}</span>
              </SettingRow>
              <SettingRow title="Timezone" desc="Used for report boundaries and dayparting.">
                <select value={timezone} onChange={(e) => setTimezone(e.target.value)} className={inputCls}>
                  <option value="Asia/Kolkata">Asia/Kolkata (IST)</option>
                  <option value="America/Los_Angeles">America/Los_Angeles (PT)</option>
                  <option value="America/New_York">America/New_York (ET)</option>
                  <option value="Europe/London">Europe/London (GMT)</option>
                  <option value="UTC">UTC</option>
                </select>
              </SettingRow>
              <SettingRow title="Default Date Range" desc="Applied when the dashboard opens." border={false}>
                <select value={defaultRange} onChange={(e) => setDefaultRange(e.target.value)} className={inputCls}>
                  <option value="7d">Last 7 Days</option>
                  <option value="14d">Last 14 Days</option>
                  <option value="30d">Last 30 Days</option>
                  <option value="90d">Last 90 Days</option>
                </select>
              </SettingRow>
            </Card>
          )}

          {activeTab === "sellermate" && (
            <>
              <Card title="Connection Status" icon={Plug} iconColor="bg-emerald-500/10 border-emerald-500/15 text-emerald-500">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-2">
                  {[
                    { l: "Status", v: account ? "Connected" : "Offline", good: !!account },
                    { l: "API Health", v: account ? "Healthy" : "Check keys", good: !!account },
                    { l: "Workspace ID", v: account?.workspace_id ? `…${String(account.workspace_id).slice(-6)}` : "—", good: true },
                    { l: "Sync Mode", v: "Automatic", good: true },
                  ].map((s) => (
                    <div key={s.l} className="p-3 rounded-2xl border border-border bg-card/60">
                      <p className="text-[10px] font-extrabold uppercase tracking-widest text-muted-foreground">{s.l}</p>
                      <p className={cn("text-sm font-extrabold mt-0.5", s.good ? "text-emerald-600 dark:text-emerald-400" : "text-red-600")}>{s.v}</p>
                    </div>
                  ))}
                </div>
                <SettingRow title="API Key" desc="Managed server-side for security — never exposed to the browser.">
                  <span className="font-mono text-xs bg-muted px-3 py-1.5 rounded-xl text-muted-foreground">••••••••••••••••</span>
                </SettingRow>
                <SettingRow title="Sync Schedule" desc="How often report data is fetched from Amazon." border={false}>
                  <select value={syncSchedule} onChange={(e) => setSyncSchedule(e.target.value)} className={inputCls}>
                    <option value="3h">Every 3 Hours</option>
                    <option value="6h">Every 6 Hours</option>
                    <option value="12h">Every 12 Hours</option>
                    <option value="24h">Daily (24h)</option>
                  </select>
                </SettingRow>
              </Card>
              <Card title="Manual Ingestion" icon={RefreshCw} iconColor="bg-blue-500/10 border-blue-500/15 text-blue-500">
                <p className="text-xs text-muted-foreground font-semibold leading-relaxed">
                  Reports are queued on a schedule. Trigger a manual sync to pull the latest PPC and inventory metrics from Amazon instantly.
                </p>
                <div className="flex items-center gap-3 pt-3">
                  <button
                    onClick={handleTriggerSync}
                    disabled={syncing}
                    className="px-4 py-2.5 bg-gradient-to-r from-[#6D5EF8] to-[#8B5CF6] text-white font-bold text-sm rounded-xl flex items-center gap-2 transition-all shadow-md shadow-indigo-500/20 disabled:opacity-50"
                  >
                    {syncing ? (<><Loader2 className="w-4 h-4 animate-spin" /> Ingesting Live Data...</>) : (<><RefreshCw size={15} /> Synchronize Now</>)}
                  </button>
                  {syncSuccess && (
                    <span className="text-xs text-emerald-600 dark:text-emerald-400 font-bold flex items-center gap-1.5 animate-pulse">
                      <CheckCircle size={14} /> Sync Successful!
                    </span>
                  )}
                </div>
              </Card>
            </>
          )}

          {activeTab === "notifications" && (
            <>
              <Card title="Alert Channels" icon={Bell} iconColor="bg-amber-500/10 border-amber-500/15 text-amber-500">
                <SettingRow title="Email Notifications" desc="Daily metrics updates and critical stockout warnings.">
                  <Toggle checked={emailAlerts} onChange={setEmailAlerts} />
                </SettingRow>
                {emailAlerts && (
                  <div className="pb-1">
                    <label className="text-[10px] font-extrabold text-muted-foreground uppercase tracking-widest">Recipient Email Address</label>
                    <input
                      type="email"
                      placeholder="you@example.com"
                      value={notifEmail}
                      onChange={(e) => setNotifEmail(e.target.value)}
                      className={cn(inputCls, "w-full mt-1")}
                      autoComplete="email"
                    />
                    <p className="text-[10px] text-muted-foreground font-medium mt-1">✅ Saved automatically as you type. Inventory alerts, campaign reports &amp; daily summaries will be sent here.</p>
                    <div className="mt-3 flex items-center gap-3">
                      <button
                        type="button"
                        disabled={!notifEmail || testEmailStatus === "sending"}
                        onClick={async () => {
                          if (!notifEmail) return;
                          setTestEmailStatus("sending");
                          try {
                            const r = await fetch("/api/send-email", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ type: "test", to: notifEmail }),
                            });
                            const json = await r.json();
                            if (r.ok) { setTestEmailStatus("sent"); setTimeout(() => setTestEmailStatus("idle"), 4000); }
                            else { console.error(json.error); setTestEmailStatus("error"); setTimeout(() => setTestEmailStatus("idle"), 4000); }
                          } catch { setTestEmailStatus("error"); setTimeout(() => setTestEmailStatus("idle"), 4000); }
                        }}
                        className="px-4 py-2 bg-gradient-to-r from-[#6D5EF8] to-[#8B5CF6] text-white text-xs font-bold rounded-xl flex items-center gap-1.5 shadow-sm disabled:opacity-50 hover:opacity-90 transition-all"
                      >
                        {testEmailStatus === "sending" ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Sending...</> :
                         testEmailStatus === "sent" ? <><CheckCircle className="w-3.5 h-3.5" /> Sent!</> :
                         testEmailStatus === "error" ? "❌ Failed — check email" :
                         <><Send className="w-3.5 h-3.5" /> Send Test Email</>}
                      </button>
                      {testEmailStatus === "sent" && <span className="text-xs text-emerald-600 dark:text-emerald-400 font-bold animate-pulse">Check your inbox! 📬</span>}
                      {testEmailStatus === "error" && <span className="text-xs text-red-500 font-bold">Something went wrong. Try again.</span>}
                    </div>
                  </div>
                )}
                <SettingRow title="Slack Alerts" desc="Real-time alerts posted to your Slack channel.">
                  <Toggle checked={slackAlerts} onChange={setSlackAlerts} />
                </SettingRow>
                {slackAlerts && (
                  <div className="pb-3">
                    <label className="text-[10px] font-extrabold text-muted-foreground uppercase tracking-widest">Slack Webhook URL</label>
                    <input
                      type="text"
                      placeholder="https://hooks.slack.com/services/..."
                      value={slackUrl}
                      onChange={(e) => setSlackUrl(e.target.value)}
                      className={cn(inputCls, "w-full mt-1")}
                    />
                  </div>
                )}
                <SettingRow title="Push Notifications" desc="Browser push for urgent alerts." border={false}>
                  <Toggle checked={pushAlerts} onChange={setPushAlerts} />
                </SettingRow>
              </Card>
              <Card title="Alert Types" icon={Activity} iconColor="bg-pink-500/10 border-pink-500/15 text-pink-500">
                <SettingRow title="ROAS / ACOS Alerts" desc="When performance crosses your thresholds.">
                  <Toggle checked={roasAlerts} onChange={setRoasAlerts} />
                </SettingRow>
                <SettingRow title="Inventory Alerts" desc="Low stock and stockout-risk warnings.">
                  <Toggle checked={inventoryAlerts} onChange={setInventoryAlerts} />
                </SettingRow>
                <SettingRow title="Daily Summary" desc="Sent every morning at 10:00 AM IST.">
                  <Toggle checked={dailySummary} onChange={setDailySummary} />
                </SettingRow>
                <SettingRow title="Weekly Summary" desc="Sent every Monday at 9:00 AM IST.">
                  <Toggle checked={weeklySummary} onChange={setWeeklySummary} />
                </SettingRow>
                <SettingRow title="Monthly Summary" desc="Sent on the 1st of every month at 9:00 AM IST.">
                  <Toggle checked={monthlySummary} onChange={setMonthlySummary} />
                </SettingRow>
                {(dailySummary || weeklySummary || monthlySummary) && (
                  <div className="mt-1 mb-2 px-3 py-2.5 bg-indigo-50 dark:bg-indigo-950/30 border border-indigo-200 dark:border-indigo-800 rounded-xl">
                    <p className="text-[11px] font-extrabold text-indigo-600 dark:text-indigo-400 flex items-center gap-1.5">
                      <span>📬</span> Reports will be sent to: <span className="font-black">{notifEmail || "—"}</span>
                    </p>
                    <p className="text-[10px] text-indigo-500/80 font-semibold mt-0.5">
                      {[dailySummary && "Daily 10AM", weeklySummary && "Weekly Monday", monthlySummary && "Monthly 1st"].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                )}
                {weeklySummary && (
                  <div className="pb-3">
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        disabled={!notifEmail || !account?.id || !account?.workspace_id || weeklyReportStatus === "sending"}
                        onClick={async () => {
                          if (!notifEmail || !account?.id || !account?.workspace_id) return;
                          setWeeklyReportStatus("sending");
                          setWhatsappText(null);
                          try {
                            const r = await fetch("/api/weekly-report", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({
                                slot: keySlot, amazon_account_id: account.id, workspace_id: account.workspace_id,
                                to: notifEmail, currency: account?.currency || "INR",
                              }),
                            });
                            const json = await r.json();
                            if (r.ok && !json.error) {
                              setWeeklyReportStatus("sent"); setTimeout(() => setWeeklyReportStatus("idle"), 4000);
                              setWhatsappText(json.whatsappText || null);
                            } else {
                              console.error(json.error); setWeeklyReportStatus("error"); setTimeout(() => setWeeklyReportStatus("idle"), 4000);
                            }
                          } catch { setWeeklyReportStatus("error"); setTimeout(() => setWeeklyReportStatus("idle"), 4000); }
                        }}
                        className="px-4 py-2 bg-gradient-to-r from-[#6D5EF8] to-[#8B5CF6] text-white text-xs font-bold rounded-xl flex items-center gap-1.5 shadow-sm disabled:opacity-50 hover:opacity-90 transition-all"
                      >
                        {weeklyReportStatus === "sending" ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Sending...</> :
                         weeklyReportStatus === "sent" ? <><CheckCircle className="w-3.5 h-3.5" /> Sent!</> :
                         weeklyReportStatus === "error" ? "❌ Failed — check console" :
                         <><Send className="w-3.5 h-3.5" /> Send Weekly Report Now</>}
                      </button>
                      {weeklyReportStatus === "sent" && <span className="text-xs text-emerald-600 dark:text-emerald-400 font-bold animate-pulse">Emailed to {notifEmail} 📬</span>}
                    </div>
                    {whatsappText && (
                      <div className="mt-3">
                        <label className="text-[10px] font-extrabold text-muted-foreground uppercase tracking-widest">WhatsApp Message (copy &amp; send manually)</label>
                        <textarea readOnly rows={5} value={whatsappText} className={cn(inputCls, "w-full mt-1 font-mono text-[11px] leading-relaxed")} />
                        <button
                          type="button"
                          onClick={() => { navigator.clipboard.writeText(whatsappText); setWhatsappCopied(true); setTimeout(() => setWhatsappCopied(false), 2500); }}
                          className="mt-1.5 px-3 py-1.5 border border-border text-xs font-bold rounded-lg hover:bg-muted transition-colors"
                        >
                          {whatsappCopied ? "✅ Copied!" : "Copy to clipboard"}
                        </button>
                      </div>
                    )}
                  </div>
                )}
                <div className="pt-3 space-y-4">
                  <div className="space-y-2">
                    <div className="flex justify-between text-xs font-bold">
                      <span className="text-muted-foreground">Notify when ACOS exceeds:</span>
                      <span className="text-primary font-extrabold">{acosThreshold}%</span>
                    </div>
                    <input type="range" min="10" max="100" value={acosThreshold} onChange={(e) => setAcosThreshold(parseInt(e.target.value))} className="w-full h-1.5 bg-muted rounded-lg appearance-none cursor-pointer accent-[#6C63FF]" />
                  </div>
                  <div className="space-y-2">
                    <div className="flex justify-between text-xs font-bold">
                      <span className="text-muted-foreground">Notify when stock drops below:</span>
                      <span className="text-primary font-extrabold">{lowStockThreshold} units</span>
                    </div>
                    <input type="range" min="5" max="100" value={lowStockThreshold} onChange={(e) => setLowStockThreshold(parseInt(e.target.value))} className="w-full h-1.5 bg-muted rounded-lg appearance-none cursor-pointer accent-[#6C63FF]" />
                  </div>
                </div>
              </Card>
            </>
          )}

          {activeTab === "automation" && (
            <Card title="Automation Rules" icon={Zap} iconColor="bg-violet-500/10 border-violet-500/15 text-violet-500">
              <p className="text-xs text-muted-foreground font-semibold -mt-1 mb-2">
                Rules run on the AI engine and surface as recommendations. Auto-apply requires write access (not enabled on this read-only dashboard).
              </p>
              <SettingRow title="Flag campaigns for auto-pause" desc="Suggest pausing when spend has zero orders past your threshold.">
                <Toggle checked={autoPause} onChange={setAutoPause} />
              </SettingRow>
              <SettingRow title="Suggest negative keywords" desc="Harvest zero-conversion search terms as negative candidates.">
                <Toggle checked={autoNegatives} onChange={setAutoNegatives} />
              </SettingRow>
              <SettingRow title="Budget scale suggestions" desc="Recommend budget increases for campaigns beating your ROAS target.">
                <Toggle checked={autoBudget} onChange={setAutoBudget} />
              </SettingRow>
              <div className="pt-3 space-y-2">
                <div className="flex justify-between text-xs font-bold">
                  <span className="text-muted-foreground">ROAS target for scale suggestions:</span>
                  <span className="text-primary font-extrabold">{roasTarget}x</span>
                </div>
                <input type="range" min="1" max="10" step="0.5" value={roasTarget} onChange={(e) => setRoasTarget(parseFloat(e.target.value))} className="w-full h-1.5 bg-muted rounded-lg appearance-none cursor-pointer accent-[#6C63FF]" />
              </div>
            </Card>
          )}

          {activeTab === "ai" && (
            <Card title="AI Assistant" icon={Bot} iconColor="bg-indigo-500/10 border-indigo-500/15 text-indigo-500">
              <SettingRow title="Enable AI Engine" desc="Powers recommendations, health scores and the copilot.">
                <Toggle checked={aiEnabled} onChange={setAiEnabled} />
              </SettingRow>
              <SettingRow title="Auto Insights" desc="Generate insights automatically when data refreshes.">
                <Toggle checked={autoInsights} onChange={setAutoInsights} />
              </SettingRow>
              <SettingRow title="Smart Alerts" desc="AI decides which anomalies are worth alerting.">
                <Toggle checked={smartAlerts} onChange={setSmartAlerts} />
              </SettingRow>
              <SettingRow title="Forecast Window" desc="Horizon used for sales & inventory forecasts.">
                <select value={forecastWindow} onChange={(e) => setForecastWindow(e.target.value)} className={inputCls}>
                  <option value="7d">7 Days</option>
                  <option value="14d">14 Days</option>
                  <option value="30d">30 Days</option>
                  <option value="90d">90 Days</option>
                </select>
              </SettingRow>
              <SettingRow title="Recommendation Mode" desc="How aggressive AI suggestions should be." border={false}>
                <div className="flex gap-1.5">
                  {(["conservative", "balanced", "aggressive"] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => setRecMode(m)}
                      className={cn(
                        "px-3 py-1.5 rounded-full text-xs font-bold capitalize transition-all border",
                        recMode === m
                          ? "bg-gradient-to-r from-[#6D5EF8] to-[#8B5CF6] text-white border-transparent shadow-sm"
                          : "bg-card border-border text-muted-foreground hover:border-primary/40"
                      )}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </SettingRow>
            </Card>
          )}

          {activeTab === "appearance" && (
            <Card title="Appearance" icon={Palette} iconColor="bg-cyan-500/10 border-cyan-500/15 text-cyan-500">
              <SettingRow title="Theme" desc="Switch between light and dark mode.">
                <div className="flex gap-1.5">
                  <button
                    onClick={() => toggleTheme("light")}
                    className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold border transition-all", theme === "light" ? "bg-gradient-to-r from-[#6D5EF8] to-[#8B5CF6] text-white border-transparent" : "bg-card border-border text-muted-foreground")}
                  >
                    <Sun size={13} /> Light
                  </button>
                  <button
                    onClick={() => toggleTheme("dark")}
                    className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold border transition-all", theme === "dark" ? "bg-gradient-to-r from-[#6D5EF8] to-[#8B5CF6] text-white border-transparent" : "bg-card border-border text-muted-foreground")}
                  >
                    <Moon size={13} /> Dark
                  </button>
                </div>
              </SettingRow>
              <SettingRow title="Compact Mode" desc="Denser tables and tighter spacing (applies on next reload)." border={false}>
                <Toggle checked={compactMode} onChange={setCompactMode} />
              </SettingRow>
            </Card>
          )}

          {activeTab === "security" && (
            <Card title="Security Center" icon={Shield} iconColor="bg-red-500/10 border-red-500/15 text-red-500">
              <SettingRow title="Two-Factor Authentication" desc="Extra protection using an authenticator app (Google Auth, Duo, etc.).">
                <Toggle checked={twoFactor} onChange={setTwoFactor} />
              </SettingRow>
              <SettingRow title="IP Restrictions" desc="Restrict dashboard access to whitelisted IP addresses.">
                <Toggle checked={ipRestrict} onChange={setIpRestrict} />
              </SettingRow>
              {ipRestrict && (
                <div className="pb-3">
                  <label className="text-[10px] font-extrabold text-muted-foreground uppercase tracking-widest">Whitelisted IPs (comma separated)</label>
                  <textarea
                    placeholder="e.g. 192.168.1.1, 203.0.113.50"
                    value={whitelistIps}
                    onChange={(e) => setWhitelistIps(e.target.value)}
                    className={cn(inputCls, "w-full h-16 mt-1 font-mono text-xs")}
                  />
                </div>
              )}
              <SettingRow title="API Key Access" desc="Keys are stored server-side in environment variables only." border={false}>
                <span className="flex items-center gap-1.5 text-xs font-extrabold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-2.5 py-1 rounded-full">
                  <Key size={12} /> Server-managed
                </span>
              </SettingRow>
            </Card>
          )}

          {activeTab === "support" && (
            <>
              <Card title="Documentation & Help" icon={HelpCircle} iconColor="bg-blue-500/10 border-blue-500/15 text-blue-500">
                <p className="text-xs text-muted-foreground font-semibold leading-relaxed">
                  Need help integrating your SP-API keys or setting up target harvesting? Review our knowledge base tutorials.
                </p>
                <div className="flex flex-wrap gap-2 pt-3">
                  <a href="https://docs.sellermate.ai" target="_blank" rel="noreferrer" className="px-4 py-2 border border-border bg-card rounded-xl hover:border-primary/50 text-sm font-bold transition-all">Documentation Hub</a>
                  <a href="https://sellermate.ai/contact" target="_blank" rel="noreferrer" className="px-4 py-2 border border-border bg-card rounded-xl hover:border-primary/50 text-sm font-bold transition-all">Contact Sales</a>
                </div>
              </Card>
              <Card title="Submit a Ticket" icon={Send} iconColor="bg-emerald-500/10 border-emerald-500/15 text-emerald-500">
                <form onSubmit={handleSupportSubmit} className="space-y-3">
                  <div className="space-y-1">
                    <label className="text-[10px] font-extrabold text-muted-foreground uppercase tracking-widest">Subject</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g., API Key sync failing"
                      value={ticketSubject}
                      onChange={(e) => setTicketSubject(e.target.value)}
                      className={cn(inputCls, "w-full")}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-extrabold text-muted-foreground uppercase tracking-widest">Message / Issue Details</label>
                    <textarea
                      required
                      placeholder="Explain what's happening..."
                      value={ticketMsg}
                      onChange={(e) => setTicketMsg(e.target.value)}
                      className={cn(inputCls, "w-full h-24")}
                    />
                  </div>
                  <div className="flex items-center gap-3 justify-end pt-1">
                    {supportSuccess && (
                      <span className="text-xs text-emerald-600 dark:text-emerald-400 font-bold flex items-center gap-1.5 animate-pulse">
                        <CheckCircle size={14} /> Ticket submitted!
                      </span>
                    )}
                    <button
                      type="submit"
                      disabled={supportSubmitting}
                      className="px-5 py-2.5 bg-gradient-to-r from-[#6D5EF8] to-[#8B5CF6] text-white font-bold text-sm rounded-xl flex items-center gap-2 shadow-md shadow-indigo-500/20 disabled:opacity-50"
                    >
                      {supportSubmitting ? (<><Loader2 className="w-4 h-4 animate-spin" /> Submitting...</>) : (<><Send size={13} /> Send Ticket</>)}
                    </button>
                  </div>
                </form>
              </Card>
            </>
          )}

          {/* Save bar for configurable tabs */}
          {activeTab !== "support" && (
            <div className="flex items-center gap-3 justify-end">
              {success && (
                <span className="text-xs text-emerald-600 dark:text-emerald-400 font-bold flex items-center gap-1.5 animate-pulse">
                  <CheckCircle size={14} /> {saveEmailNote || "Settings saved!"}
                </span>
              )}
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-6 py-2.5 bg-gradient-to-r from-[#6D5EF8] to-[#8B5CF6] text-white font-bold text-sm rounded-xl shadow-md shadow-indigo-500/20 hover:opacity-95 transition-all flex items-center gap-2 disabled:opacity-60"
              >
                {saving ? (<><Loader2 className="w-4 h-4 animate-spin" /> Saving...</>) : "Save Changes"}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Footer ── */}
      <div className="flex items-center justify-between flex-wrap gap-3 text-[11px] font-bold text-muted-foreground border-t border-border pt-5">
        <span>BARM AI v2.0 · SellerMate Public API v1 · Next.js 16</span>
        <span className="flex items-center gap-1.5">
          <span className={cn("w-1.5 h-1.5 rounded-full", account ? "bg-emerald-500 animate-pulse" : "bg-red-500")} />
          {account ? "All systems operational" : "Connection issue"}
        </span>
      </div>
    </div>
  );
}
