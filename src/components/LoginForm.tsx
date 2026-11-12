"use client";

import { useState, useEffect, useRef } from "react";
import { Loader2, Lock, User, Eye, EyeOff, AlertTriangle, ShieldCheck, ArrowRight, Building } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

export default function LoginForm() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);

  const usernameRef = useRef<HTMLInputElement>(null);

  // Auto-focus username and load cached rememberMe settings
  useEffect(() => {
    if (usernameRef.current) {
      usernameRef.current.focus();
    }
    const savedUser = localStorage.getItem("ppcRememberUser");
    if (savedUser) {
      setUsername(savedUser);
      setRememberMe(true);
    }
  }, []);

  // Monitor Caps Lock state
  const handleKeyDown = (e: React.KeyboardEvent) => {
    setCapsLock(e.getModifierState("CapsLock"));
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    // The password is checked server-side (DASHBOARD_PASSWORD), which sets the HttpOnly session
    // cookie the API routes require. The username still only picks the account slot.
    const uTrim = username.trim();
    let ok = false;
    let serverError = "";
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: uTrim, password }),
      });
      ok = r.ok;
      if (!r.ok && r.status !== 401) serverError = (await r.json().catch(() => ({}))).error || "";
    } catch {
      serverError = "Could not reach the server. Please try again.";
    }
    if (ok) {
      if (rememberMe) {
        localStorage.setItem("ppcRememberUser", uTrim);
      } else {
        localStorage.removeItem("ppcRememberUser");
      }
      localStorage.setItem("ppcUser", uTrim);
      localStorage.setItem("ppcKeySlot", uTrim === "Barm" ? "B" : "A");
      window.location.href = "/dashboard/home";
    } else {
      setError(serverError || "Incorrect credentials. Please check your username and password and try again.");
      setLoading(false);
    }
  };

  // Simple, professional sign-in in the light green theme (user, 12 Nov 2026).
  const inputCls = "w-full pl-10 pr-4 h-11 bg-white border border-slate-200 rounded-lg text-slate-900 placeholder-slate-400 text-sm focus:outline-none focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10 transition";
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      className="w-full max-w-[400px] rounded-2xl bg-white border border-slate-200/80 p-8 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_12px_32px_-12px_rgba(15,23,42,0.12)]"
    >
      <div className="space-y-1.5 mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Sign in</h1>
        <p className="text-sm text-slate-500">Welcome back. Sign in to your Marketplace360 workspace.</p>
      </div>

      <form onSubmit={handleLogin} onKeyDown={handleKeyDown} className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="login-user" className="text-sm font-medium text-slate-700 block">Username</label>
          <div className="relative">
            <User className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" aria-hidden />
            <input id="login-user" ref={usernameRef} type="text" required autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} className={inputCls} placeholder="e.g. Barm" />
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="login-pass" className="text-sm font-medium text-slate-700 block">Password</label>
          <div className="relative">
            <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" aria-hidden />
            <input id="login-pass" type={showPassword ? "text" : "password"} required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={`${inputCls} pr-11`} placeholder="Your password" />
            <button type="button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? "Hide password" : "Show password"} className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 rounded">
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>

        <AnimatePresence>
          {capsLock && (
            <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-700 text-xs font-medium">
              <AlertTriangle size={14} className="shrink-0" /> Caps Lock is on
            </motion.div>
          )}
          {error && (
            <motion.div role="alert" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs font-medium">
              <ShieldCheck className="w-4 h-4 shrink-0 mt-0.5" /> <span>{error}</span>
            </motion.div>
          )}
        </AnimatePresence>

        <label htmlFor="remember" className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer select-none">
          <input id="remember" type="checkbox" checked={rememberMe} onChange={(e) => setRememberMe(e.target.checked)} className="w-4 h-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500/30 cursor-pointer" />
          Remember me
        </label>

        <button type="submit" disabled={loading} className="w-full h-11 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-semibold text-sm transition-colors flex items-center justify-center gap-2 disabled:opacity-70 focus:outline-none focus-visible:ring-4 focus-visible:ring-emerald-500/30">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <>Continue <ArrowRight size={15} /></>}
        </button>

        <div className="flex items-center gap-3 py-1 text-xs text-slate-400">
          <span className="h-px flex-1 bg-slate-200" /> or <span className="h-px flex-1 bg-slate-200" />
        </div>

        {/* One-click sign-in through the B-ARM ERP (b-arm.org) for allow-listed accounts */}
        <a href="https://b-arm.org/?sso_to=mna" className="w-full h-11 border border-slate-200 hover:border-emerald-300 hover:bg-emerald-50/60 text-slate-700 rounded-lg font-medium text-sm transition-colors flex items-center justify-center gap-2">
          <Building size={15} className="text-emerald-600" /> Sign in with B-ARM account
        </a>
      </form>
    </motion.div>
  );
}
