"use client";

import { useDashboard } from "@/lib/DashboardContext";
import { Settings, Shield, RefreshCw, Key, HelpCircle, CheckCircle, Bell, Loader2, Mail, Send } from "lucide-react";
import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";

export default function SettingsPage() {
  const { account, loggedInUser } = useDashboard();
  const [activeTab, setActiveTab] = useState<"api" | "notifications" | "ingestion" | "security" | "support">("api");
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  // Form states
  const [emailAlerts, setEmailAlerts] = useState(true);
  const [slackAlerts, setSlackAlerts] = useState(false);
  const [slackUrl, setSlackUrl] = useState("");
  const [acosThreshold, setAcosThreshold] = useState(40);
  const [lowStockThreshold, setLowStockThreshold] = useState(15);
  const [syncSchedule, setSyncSchedule] = useState("6h");
  const [twoFactor, setTwoFactor] = useState(false);
  const [ipRestrict, setIpRestrict] = useState(false);
  const [whitelistIps, setWhitelistIps] = useState("");

  // Ingestion trigger states
  const [syncing, setSyncing] = useState(false);
  const [syncSuccess, setSyncSuccess] = useState(false);

  // Support form states
  const [supportSubmitting, setSupportSubmitting] = useState(false);
  const [supportSuccess, setSupportSuccess] = useState(false);
  const [ticketSubject, setTicketSubject] = useState("");
  const [ticketMsg, setTicketMsg] = useState("");

  // Load configurations
  useEffect(() => {
    const saved = localStorage.getItem("ppcUserSettings");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setEmailAlerts(parsed.emailAlerts ?? true);
        setSlackAlerts(parsed.slackAlerts ?? false);
        setSlackUrl(parsed.slackUrl ?? "");
        setAcosThreshold(parsed.acosThreshold ?? 40);
        setLowStockThreshold(parsed.lowStockThreshold ?? 15);
        setSyncSchedule(parsed.syncSchedule ?? "6h");
        setTwoFactor(parsed.twoFactor ?? false);
        setIpRestrict(parsed.ipRestrict ?? false);
        setWhitelistIps(parsed.whitelistIps ?? "");
      } catch (e) {
        console.error("Failed to parse settings", e);
      }
    }
  }, []);

  const handleSave = () => {
    setSaving(true);
    setTimeout(() => {
      setSaving(false);
      setSuccess(true);
      
      const config = {
        emailAlerts,
        slackAlerts,
        slackUrl,
        acosThreshold,
        lowStockThreshold,
        syncSchedule,
        twoFactor,
        ipRestrict,
        whitelistIps
      };
      
      localStorage.setItem("ppcUserSettings", JSON.stringify(config));

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

      setTimeout(() => setSuccess(false), 2500);
    }, 1000);
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

  return (
    <div className="max-w-4xl mx-auto space-y-8 pb-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight mb-0.5">Settings</h1>
        <p className="text-muted-foreground text-sm">
          Manage your SellerMate connections, alerts, schedules, and preferences
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Left Column Tabs */}
        <div className="space-y-1">
          <button
            onClick={() => setActiveTab("api")}
            className={cn("w-full text-left px-3 py-2.5 rounded-xl text-sm font-semibold flex items-center gap-2.5 transition-all", activeTab === "api" ? "bg-primary text-white shadow-md shadow-primary/20" : "text-muted-foreground hover:bg-muted hover:text-foreground")}
          >
            <Key size={16} /> API Integration
          </button>
          <button
            onClick={() => setActiveTab("notifications")}
            className={cn("w-full text-left px-3 py-2.5 rounded-xl text-sm font-semibold flex items-center gap-2.5 transition-all", activeTab === "notifications" ? "bg-primary text-white shadow-md shadow-primary/20" : "text-muted-foreground hover:bg-muted hover:text-foreground")}
          >
            <Bell size={16} /> Notification Alerts
          </button>
          <button
            onClick={() => setActiveTab("ingestion")}
            className={cn("w-full text-left px-3 py-2.5 rounded-xl text-sm font-semibold flex items-center gap-2.5 transition-all", activeTab === "ingestion" ? "bg-primary text-white shadow-md shadow-primary/20" : "text-muted-foreground hover:bg-muted hover:text-foreground")}
          >
            <RefreshCw size={16} /> Data Ingestion
          </button>
          <button
            onClick={() => setActiveTab("security")}
            className={cn("w-full text-left px-3 py-2.5 rounded-xl text-sm font-semibold flex items-center gap-2.5 transition-all", activeTab === "security" ? "bg-primary text-white shadow-md shadow-primary/20" : "text-muted-foreground hover:bg-muted hover:text-foreground")}
          >
            <Shield size={16} /> Security
          </button>
          <button
            onClick={() => setActiveTab("support")}
            className={cn("w-full text-left px-3 py-2.5 rounded-xl text-sm font-semibold flex items-center gap-2.5 transition-all", activeTab === "support" ? "bg-primary text-white shadow-md shadow-primary/20" : "text-muted-foreground hover:bg-muted hover:text-foreground")}
          >
            <HelpCircle size={16} /> Support & Help
          </button>
        </div>

        {/* Right Columns Config Form */}
        <div className="md:col-span-2 space-y-6">
          {/* TAB 1: API INTEGRATION */}
          {activeTab === "api" && (
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
          )}

          {/* TAB 2: NOTIFICATION PREFERENCES */}
          {activeTab === "notifications" && (
            <div className="glass rounded-2xl border border-border p-6 shadow-sm space-y-5">
              <h3 className="font-bold text-sm text-foreground">Alert Channels</h3>
              
              <div className="space-y-4">
                <div className="flex items-center justify-between py-1.5">
                  <div>
                    <p className="text-xs font-bold">Email Alerts</p>
                    <p className="text-[11px] text-muted-foreground">Send daily metrics updates and critical stockout warnings via email.</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={emailAlerts}
                    onChange={(e) => setEmailAlerts(e.target.checked)}
                    className="w-4 h-4 text-primary bg-background border-border rounded focus:ring-primary focus:outline-none cursor-pointer"
                  />
                </div>

                <div className="flex items-center justify-between py-1.5 border-t border-border/60">
                  <div>
                    <p className="text-xs font-bold">Slack Alerts</p>
                    <p className="text-[11px] text-muted-foreground">Send real-time alerts directly into your Slack channel.</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={slackAlerts}
                    onChange={(e) => setSlackAlerts(e.target.checked)}
                    className="w-4 h-4 text-primary bg-background border-border rounded focus:ring-primary focus:outline-none cursor-pointer"
                  />
                </div>

                {slackAlerts && (
                  <div className="space-y-1 animate-in fade-in slide-in-from-top-1 duration-150">
                    <label className="text-[10px] font-bold text-muted-foreground uppercase">Slack Webhook URL</label>
                    <input
                      type="text"
                      placeholder="https://hooks.slack.com/services/..."
                      value={slackUrl}
                      onChange={(e) => setSlackUrl(e.target.value)}
                      className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm focus:border-primary focus:outline-none"
                    />
                  </div>
                )}

                <div className="border-t border-border/60 pt-4 space-y-4">
                  <h4 className="text-xs font-bold text-foreground">Alert Thresholds</h4>
                  
                  <div className="space-y-2">
                    <div className="flex justify-between text-xs font-semibold">
                      <span className="text-muted-foreground">Notify when ACOS exceeds:</span>
                      <span className="text-primary font-bold">{acosThreshold}%</span>
                    </div>
                    <input
                      type="range"
                      min="10"
                      max="100"
                      value={acosThreshold}
                      onChange={(e) => setAcosThreshold(parseInt(e.target.value))}
                      className="w-full h-1 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
                    />
                  </div>

                  <div className="space-y-2 pt-2">
                    <div className="flex justify-between text-xs font-semibold">
                      <span className="text-muted-foreground">Notify when stock drops below:</span>
                      <span className="text-primary font-bold">{lowStockThreshold} units</span>
                    </div>
                    <input
                      type="range"
                      min="5"
                      max="100"
                      value={lowStockThreshold}
                      onChange={(e) => setLowStockThreshold(parseInt(e.target.value))}
                      className="w-full h-1 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: DATA INGESTION */}
          {activeTab === "ingestion" && (
            <div className="space-y-6">
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
                    <p className="text-[11px] text-muted-foreground">Select how often report data is fetched from Amazon API.</p>
                  </div>
                  <select
                    value={syncSchedule}
                    onChange={(e) => setSyncSchedule(e.target.value)}
                    className="bg-card border border-border text-foreground px-2 py-1 rounded-lg text-xs font-semibold focus:border-primary focus:outline-none"
                  >
                    <option value="3h">Every 3 Hours</option>
                    <option value="6h">Every 6 Hours</option>
                    <option value="12h">Every 12 Hours</option>
                    <option value="24h">Daily (24h)</option>
                  </select>
                </div>
              </div>

              <div className="glass rounded-2xl border border-border p-6 shadow-sm space-y-4">
                <h3 className="font-bold text-sm text-foreground">Trigger Live Ingestion</h3>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Normally reports are queued on a schedule. You can trigger a manual sync to pull the absolute latest PPC and inventory metrics from Amazon instantly.
                </p>
                <div className="flex items-center gap-3 pt-2">
                  <button
                    onClick={handleTriggerSync}
                    disabled={syncing}
                    className="px-4 py-2 bg-secondary hover:bg-muted text-foreground border border-border font-bold text-xs rounded-xl flex items-center gap-2 transition-colors disabled:opacity-50"
                  >
                    {syncing ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Ingesting Live Data...
                      </>
                    ) : (
                      <>
                        <RefreshCw size={14} /> Synchronize Now
                      </>
                    )}
                  </button>
                  {syncSuccess && (
                    <span className="text-xs text-green-600 dark:text-green-400 font-bold flex items-center gap-1.5 animate-pulse">
                      <CheckCircle size={14} /> Sync Successful!
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: SECURITY */}
          {activeTab === "security" && (
            <div className="glass rounded-2xl border border-border p-6 shadow-sm space-y-5">
              <h3 className="font-bold text-sm text-foreground">Security Settings</h3>
              
              <div className="space-y-4">
                <div className="flex items-center justify-between py-2">
                  <div>
                    <p className="text-xs font-bold">Two-Factor Authentication</p>
                    <p className="text-[11px] text-muted-foreground">Add extra layer of protection using an authenticator app (Google Auth, Duo, etc.).</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={twoFactor}
                    onChange={(e) => setTwoFactor(e.target.checked)}
                    className="w-4 h-4 text-primary bg-background border-border rounded focus:ring-primary focus:outline-none cursor-pointer"
                  />
                </div>

                <div className="flex items-center justify-between py-2 border-t border-border">
                  <div>
                    <p className="text-xs font-bold">IP Restrictions</p>
                    <p className="text-[11px] text-muted-foreground">Restrict dashboard access to selected whitelisted IP addresses.</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={ipRestrict}
                    onChange={(e) => setIpRestrict(e.target.checked)}
                    className="w-4 h-4 text-primary bg-background border-border rounded focus:ring-primary focus:outline-none cursor-pointer"
                  />
                </div>

                {ipRestrict && (
                  <div className="space-y-1 animate-in fade-in slide-in-from-top-1 duration-150">
                    <label className="text-[10px] font-bold text-muted-foreground uppercase">Whitelisted IPs (comma separated)</label>
                    <textarea
                      placeholder="e.g. 192.168.1.1, 203.0.113.50"
                      value={whitelistIps}
                      onChange={(e) => setWhitelistIps(e.target.value)}
                      className="w-full h-16 px-3 py-2 bg-background border border-border rounded-xl text-sm focus:border-primary focus:outline-none font-mono text-xs"
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 5: SUPPORT */}
          {activeTab === "support" && (
            <div className="space-y-6">
              <div className="glass rounded-2xl border border-border p-6 shadow-sm space-y-4">
                <h3 className="font-bold text-sm text-foreground">Support Documentation</h3>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Need help integrating your SP-API keys or setting up target harvesting? Review our knowledge base tutorials.
                </p>
                <div className="flex flex-wrap gap-2 text-xs">
                  <a href="https://docs.sellermate.ai" target="_blank" rel="noreferrer" className="px-3 py-1.5 border border-border bg-card rounded-lg hover:border-primary/50 text-foreground transition-all">Documentation Hub</a>
                  <a href="https://sellermate.ai/contact" target="_blank" rel="noreferrer" className="px-3 py-1.5 border border-border bg-card rounded-lg hover:border-primary/50 text-foreground transition-all">Contact Sales</a>
                </div>
              </div>

              <div className="glass rounded-2xl border border-border p-6 shadow-sm space-y-4">
                <h3 className="font-bold text-sm text-foreground">Submit a Ticket</h3>
                <form onSubmit={handleSupportSubmit} className="space-y-3">
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-muted-foreground uppercase">Subject</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g., API Key sync failing"
                      value={ticketSubject}
                      onChange={(e) => setTicketSubject(e.target.value)}
                      className="w-full px-3 py-2 bg-background border border-border rounded-xl text-xs focus:border-primary focus:outline-none"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-muted-foreground uppercase">Message / Issue Details</label>
                    <textarea
                      required
                      placeholder="Explain what's happening..."
                      value={ticketMsg}
                      onChange={(e) => setTicketMsg(e.target.value)}
                      className="w-full h-24 px-3 py-2 bg-background border border-border rounded-xl text-xs focus:border-primary focus:outline-none"
                    />
                  </div>
                  <div className="flex items-center gap-3 justify-end pt-1">
                    {supportSuccess && (
                      <span className="text-xs text-green-600 dark:text-green-400 font-bold flex items-center gap-1.5 animate-pulse">
                        <CheckCircle size={14} /> Ticket submitted!
                      </span>
                    )}
                    <button
                      type="submit"
                      disabled={supportSubmitting}
                      className="px-4 py-2 bg-primary hover:bg-opacity-95 text-white font-bold text-xs rounded-xl flex items-center gap-1.5 shadow-sm disabled:opacity-50"
                    >
                      {supportSubmitting ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Submitting...
                        </>
                      ) : (
                        <>
                          <Send size={12} /> Send Ticket
                        </>
                      )}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* Action buttons (only show for configurable pages: notifications, api, security) */}
          {activeTab !== "support" && activeTab !== "ingestion" && (
            <div className="flex items-center gap-3 justify-end">
              {success && (
                <span className="text-xs text-green-600 dark:text-green-400 font-bold flex items-center gap-1.5 animate-pulse">
                  <CheckCircle size={14} /> Settings saved!
                </span>
              )}
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-5 py-2.5 bg-primary text-white font-bold text-xs rounded-xl shadow-sm hover:opacity-95 transition-all flex items-center gap-2"
              >
                {saving ? "Saving..." : "Save Settings"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}        </button>
          </div>
        </div>
      </div>
    </div>
  );
}
