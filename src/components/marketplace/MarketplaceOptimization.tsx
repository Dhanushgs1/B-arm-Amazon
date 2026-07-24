"use client";

import { useState, useMemo } from "react";
import { motion } from "framer-motion";
import { 
  MARKETPLACE_META, 
  generateMarketplaceRules, 
  generateMarketplaceCampaigns,
  type MarketplaceId, 
  type MarketplaceRule 
} from "@/lib/marketplace";
import { PageHero } from "@/components/PageHero";
import { KPICard } from "@/components/KPICard";
import { 
  Wand2, 
  Plus, 
  Play, 
  CheckCircle2, 
  ShieldCheck, 
  TrendingUp, 
  AlertTriangle, 
  Moon, 
  Ban, 
  Sliders, 
  Sparkles, 
  Clock, 
  Trash2, 
  RefreshCw,
  X
} from "lucide-react";
import { cn } from "@/lib/utils";

interface MarketplaceOptimizationProps {
  marketplace: Exclude<MarketplaceId, "amazon">;
}

export function MarketplaceOptimization({ marketplace }: MarketplaceOptimizationProps) {
  const meta = MARKETPLACE_META[marketplace];
  const [rules, setRules] = useState<MarketplaceRule[]>(() => generateMarketplaceRules(marketplace));
  const [filterType, setFilterType] = useState<string>("all");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [runningRuleId, setRunningRuleId] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Form State for New Rule Modal
  const [ruleName, setRuleName] = useState("");
  const [ruleType, setRuleType] = useState<MarketplaceRule["type"]>("roas");
  const [conditionVal, setConditionVal] = useState("35");
  const [actionType, setActionType] = useState("reduce_bid");

  const campaigns = useMemo(() => generateMarketplaceCampaigns(marketplace), [marketplace]);

  const activeRulesCount = rules.filter((r) => r.enabled).length;

  const triggerToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  const toggleRule = (id: string) => {
    setRules((prev) =>
      prev.map((r) => {
        if (r.id === id) {
          const next = !r.enabled;
          triggerToast(`Rule "${r.name}" is now ${next ? "ACTIVE" : "PAUSED"}`);
          return { ...r, enabled: next };
        }
        return r;
      })
    );
  };

  const deleteRule = (id: string) => {
    setRules((prev) => prev.filter((r) => r.id !== id));
    triggerToast("Rule deleted successfully.");
  };

  const handleRunRuleNow = (rule: MarketplaceRule) => {
    setRunningRuleId(rule.id);
    setTimeout(() => {
      setRunningRuleId(null);
      triggerToast(`Successfully executed "${rule.name}" across ${campaigns.length} active campaigns. 3 adjustments applied!`);
    }, 1200);
  };

  const handleCreateRule = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ruleName.trim()) return;

    let condStr = "";
    let actStr = "";

    if (ruleType === "roas") {
      condStr = `If Campaign ACOS > ${conditionVal}% over 7 days`;
      actStr = actionType === "reduce_bid" ? "Reduce bid by 12% automatically" : "Pause Campaign";
    } else if (ruleType === "stock") {
      condStr = `If Stock < ${conditionVal} units`;
      actStr = "Pause Ads for low stock SKU";
    } else if (ruleType === "rto") {
      condStr = `If Product RTO Rate > ${conditionVal}%`;
      actStr = "Pause Smart Ad Campaign for SKU";
    } else if (ruleType === "negative") {
      condStr = `If Clicks >= ${conditionVal} & Orders = 0`;
      actStr = "Add to Negative Exact Keyword list";
    } else {
      condStr = `Night Window (01:00 AM - 06:00 AM)`;
      actStr = `Lower bids by ${conditionVal}%`;
    }

    const newRule: MarketplaceRule = {
      id: `${marketplace.slice(0, 2)}-rule-${Date.now()}`,
      name: ruleName,
      type: ruleType,
      condition: condStr,
      action: actStr,
      enabled: true,
      frequency: "Daily at 02:00 AM",
      lastExecuted: "Just now",
      impactEstimate: "Est. Savings ₹4,500/mo",
      marketplace,
    };

    setRules([newRule, ...rules]);
    setIsModalOpen(false);
    setRuleName("");
    triggerToast(`New rule "${newRule.name}" created and enabled!`);
  };

  const filteredRules = rules.filter((r) => {
    if (filterType === "active") return r.enabled;
    if (filterType === "paused") return !r.enabled;
    if (filterType !== "all") return r.type === filterType;
    return true;
  });

  return (
    <motion.div 
      initial={{ opacity: 0 }} 
      animate={{ opacity: 1 }} 
      transition={{ duration: 0.4 }}
      className="space-y-6 pb-12"
    >
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-6 right-6 z-50 bg-white dark:bg-slate-900 text-slate-900 dark:text-white px-4 py-3 rounded-xl shadow-2xl border border-slate-200 dark:border-indigo-500/30 flex items-center gap-3 animate-in fade-in slide-in-from-bottom-4 duration-300">
          <CheckCircle2 className="w-5 h-5 text-emerald-400 flex-shrink-0" />
          <span className="text-xs font-bold">{toastMessage}</span>
        </div>
      )}

      {/* Page Hero */}
      <PageHero
        title={`${meta.label} Automation Rules & Optimization Engine`}
        subtitle={`Configure automated bid guardrails, stock safety nets, and ROAS rules specifically for ${meta.label} Ads.`}
        actions={
          <button
            onClick={() => setIsModalOpen(true)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white text-xs font-bold shadow-lg shadow-indigo-500/25 transition-all cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            Create Automation Rule
          </button>
        }
      />

      {/* KPI Cards */}
      <motion.div 
        initial={{ opacity: 0, y: 20 }} 
        animate={{ opacity: 1, y: 0 }} 
        transition={{ delay: 0.1, duration: 0.5 }}
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4"
      >
        <KPICard
          title="Active Guardrail Rules"
          value={activeRulesCount.toString()}
          subtext={`out of ${rules.length} total rules configured`}
          icon={ShieldCheck}
        />
        <KPICard
          title="Automated Actions Executed"
          value="142"
          subtext="in last 30 days"
          icon={Wand2}
        />
        <KPICard
          title="Est. Monthly Spend Saved"
          value={marketplace === "flipkart" ? "₹16,700" : "₹19,300"}
          subtext="via auto-negations & ACOS caps"
          icon={TrendingUp}
        />
        <KPICard
          title="Rule Engine Health"
          value="100% Operational"
          subtext="Last run 12 mins ago"
          icon={CheckCircle2}
        />
      </motion.div>

      {/* AI Smart Rule Recommendations Banner */}
      <motion.div 
        initial={{ opacity: 0, y: 20 }} 
        animate={{ opacity: 1, y: 0 }} 
        transition={{ delay: 0.2, duration: 0.5 }}
        className="bg-gradient-to-r from-indigo-950/40 via-purple-950/20 to-slate-950 p-5 rounded-2xl border border-indigo-500/20 shadow-lg relative overflow-hidden"
      >
        <div className="flex items-start gap-4">
          <div className="w-10 h-10 rounded-xl bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 flex-shrink-0">
            <Sparkles className="w-5 h-5 animate-pulse" />
          </div>
          <div className="flex-1 space-y-1">
            <div className="flex items-center gap-2">
              <h3 className="font-extrabold text-sm text-white">AI Rule Recommendations for {meta.label}</h3>
              <span className="text-[10px] uppercase font-black tracking-widest px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                Recommended
              </span>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed max-w-3xl">
              Our AI detected 3 {meta.label} campaigns operating at high ACOS during midnight hours. Enabling night window dayparting could save up to <strong className="text-amber-400 font-bold">₹4,200</strong> weekly without losing high-intent orders.
            </p>
          </div>
        </div>
      </motion.div>

      {/* Rules Engine Toolbar & Filters */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-popover/60 backdrop-blur-md p-3.5 rounded-xl border border-border">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-extrabold text-slate-400 uppercase tracking-wider px-1">Filter Rules:</span>
          {["all", "active", "paused", "roas", "stock", "rto", "negative"].map((type) => (
            <button
              key={type}
              onClick={() => setFilterType(type)}
              className={cn(
                "px-3 py-1.5 rounded-lg text-xs font-bold capitalize transition-all cursor-pointer",
                filterType === type
                  ? "bg-indigo-600 text-white shadow-md shadow-indigo-500/20"
                  : "bg-slate-100 dark:bg-slate-900 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200 dark:hover:bg-slate-800"
              )}
            >
              {type}
            </button>
          ))}
        </div>

        <div className="text-xs font-bold text-slate-400">
          Showing <span className="text-white">{filteredRules.length}</span> of {rules.length} rules
        </div>
      </div>

      {/* Active Rules List */}
      <motion.div 
        initial={{ opacity: 0, y: 20 }} 
        animate={{ opacity: 1, y: 0 }} 
        transition={{ delay: 0.3, duration: 0.5 }}
        className="space-y-3"
      >
        {filteredRules.map((rule) => {
          const isRunning = runningRuleId === rule.id;

          return (
            <div
              key={rule.id}
              className={cn(
                "p-4 rounded-xl border transition-all bg-card/80 backdrop-blur-md flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-sm hover:shadow-md",
                rule.enabled
                  ? "border-indigo-500/20 hover:border-indigo-500/40"
                  : "border-slate-800/80 opacity-75 bg-slate-950/40"
              )}
            >
              <div className="flex items-start gap-3.5 flex-1 min-w-0">
                {/* Rule Icon / Badge */}
                <div className={cn(
                  "w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 border shadow-sm",
                  rule.type === "roas" ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
                  : rule.type === "stock" ? "bg-amber-500/10 border-amber-500/20 text-amber-400"
                  : rule.type === "rto" ? "bg-red-500/10 border-red-500/20 text-red-400"
                  : rule.type === "negative" ? "bg-purple-500/10 border-purple-500/20 text-purple-400"
                  : "bg-indigo-500/10 border-indigo-500/20 text-indigo-400"
                )}>
                  {rule.type === "roas" && <TrendingUp className="w-5 h-5" />}
                  {rule.type === "stock" && <AlertTriangle className="w-5 h-5" />}
                  {rule.type === "rto" && <Ban className="w-5 h-5" />}
                  {rule.type === "negative" && <Sliders className="w-5 h-5" />}
                  {rule.type === "dayparting" && <Moon className="w-5 h-5" />}
                </div>

                <div className="space-y-1 min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h4 className="font-extrabold text-sm text-foreground truncate">{rule.name}</h4>
                    <span className={cn(
                      "text-[9px] uppercase font-black tracking-widest px-2 py-0.5 rounded-full border",
                      rule.enabled
                        ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                        : "bg-slate-800 text-slate-400 border-slate-700"
                    )}>
                      {rule.enabled ? "Active" : "Paused"}
                    </span>
                    <span className="text-[10px] bg-slate-100 dark:bg-slate-900/60 text-slate-500 dark:text-slate-500 px-2 py-0.5 rounded-md border border-slate-200 dark:border-slate-800">
                      {rule.frequency}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
                    <div>
                      <strong className="text-slate-700 dark:text-slate-300">If:</strong> {rule.condition}
                    </div>
                    <div>
                      <strong className="text-slate-700 dark:text-slate-300">Then:</strong> <span className="text-indigo-600 dark:text-indigo-400 font-bold">{rule.action}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 text-[11px] text-slate-500 pt-0.5">
                    <span className="text-emerald-400 font-bold">{rule.impactEstimate}</span>
                    <span>•</span>
                    <span>Last run: {rule.lastExecuted || "Today at 02:00 AM"}</span>
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center gap-2 flex-shrink-0 pt-2 md:pt-0 border-t md:border-t-0 border-border">
                <button
                  onClick={() => handleRunRuleNow(rule)}
                  disabled={isRunning}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-800 text-xs font-bold text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors cursor-pointer"
                  title="Trigger rule execution test"
                >
                  {isRunning ? <RefreshCw className="w-3.5 h-3.5 animate-spin text-indigo-400" /> : <Play className="w-3.5 h-3.5 text-indigo-400" />}
                  <span>{isRunning ? "Running..." : "Test Run"}</span>
                </button>

                {/* Toggle Switch */}
                <button
                  onClick={() => toggleRule(rule.id)}
                  className={cn(
                    "relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer focus:outline-none",
                    rule.enabled ? "bg-indigo-600" : "bg-slate-300 dark:bg-slate-800"
                  )}
                  title={rule.enabled ? "Disable Rule" : "Enable Rule"}
                >
                  <span
                    className={cn(
                      "inline-block h-4 w-4 transform rounded-full bg-white transition-transform",
                      rule.enabled ? "translate-x-6" : "translate-x-1"
                    )}
                  />
                </button>

                <button
                  onClick={() => deleteRule(rule.id)}
                  className="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
                  title="Delete Rule"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          );
        })}

        {filteredRules.length === 0 && (
          <div className="text-center py-12 bg-card/40 rounded-xl border border-dashed border-border space-y-3">
            <Wand2 className="w-10 h-10 text-slate-600 mx-auto" />
            <p className="text-sm font-bold text-slate-400">No automation rules found matching filter.</p>
          </div>
        )}
      </motion.div>

      {/* Modal: Create New Rule */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-2xl w-full max-w-xl p-6 shadow-2xl space-y-5 relative">
            <button
              onClick={() => setIsModalOpen(false)}
              className="absolute top-5 right-5 text-slate-400 hover:text-slate-900 dark:hover:text-white p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-900"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="space-y-1">
              <h3 className="font-extrabold text-lg text-slate-900 dark:text-white flex items-center gap-2">
                <Wand2 className="w-5 h-5 text-indigo-400" />
                Create {meta.label} Automation Rule
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">Set trigger conditions and automatic guardrail actions for {meta.label} campaigns.</p>
            </div>

            <form onSubmit={handleCreateRule} className="space-y-4">
              <div className="space-y-1">
                <label className="text-xs font-extrabold text-slate-700 dark:text-slate-300">Rule Name</label>
                <input
                  type="text"
                  required
                  value={ruleName}
                  onChange={(e) => setRuleName(e.target.value)}
                  placeholder={`e.g. ${meta.label} High ACOS Bid Down`}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 text-xs focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-extrabold text-slate-700 dark:text-slate-300">Rule Type</label>
                  <select
                    value={ruleType}
                    onChange={(e) => setRuleType(e.target.value as any)}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-white text-xs focus:outline-none focus:border-indigo-500"
                  >
                    <option value="roas">ACOS / ROAS Guardrail</option>
                    <option value="stock">Stock Safety Net</option>
                    <option value="rto">RTO Protection</option>
                    <option value="negative">Search Term Negation</option>
                    <option value="dayparting">Dayparting Schedule</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-extrabold text-slate-700 dark:text-slate-300">Trigger Threshold</label>
                  <input
                    type="number"
                    value={conditionVal}
                    onChange={(e) => setConditionVal(e.target.value)}
                    placeholder="e.g. 35"
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 text-xs focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-extrabold text-slate-700 dark:text-slate-300">Action to Execute</label>
                <select
                  value={actionType}
                  onChange={(e) => setActionType(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-white text-xs focus:outline-none focus:border-indigo-500"
                >
                  <option value="reduce_bid">Reduce Bid by 12% - 15%</option>
                  <option value="increase_bid">Increase Bid by 10% - 18%</option>
                  <option value="pause_campaign">Pause Campaign / Product Ad</option>
                  <option value="add_negative">Add to Negative Keyword List</option>
                </select>
              </div>

              <div className="pt-3 flex items-center justify-end gap-3 border-t border-slate-200 dark:border-slate-900">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 rounded-xl text-xs font-bold text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-900 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white text-xs font-bold shadow-lg shadow-indigo-500/25"
                >
                  Save & Enable Rule
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </motion.div>
  );
}
