"use client";

import { useState, useEffect, useRef } from "react";
import { Loader2, Lock, User, Eye, EyeOff, AlertTriangle, ShieldCheck, ArrowRight, Building, Key } from "lucide-react";
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

    // Simulated latency for loading states
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const uTrim = username.trim();
    if (
      (uTrim === "Barm" && password === "Barm@123") ||
      (uTrim === "Lkn" && password === "Lkn@123")
    ) {
      if (rememberMe) {
        localStorage.setItem("ppcRememberUser", uTrim);
      } else {
        localStorage.removeItem("ppcRememberUser");
      }
      localStorage.setItem("ppcUser", uTrim);
      localStorage.setItem("ppcKeySlot", uTrim === "Barm" ? "B" : "A");
      window.location.href = "/dashboard";
    } else {
      setError("Incorrect credentials. Use Barm / Barm@123 or Lkn / Lkn@123.");
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col justify-center items-center w-full min-h-screen p-6 relative overflow-y-auto">
      {/* Container Card with Advanced Glassmorphism */}
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: "easeOut" }}
        className="w-full max-w-[440px] rounded-3xl bg-white/[0.02] border border-white/5 p-8 shadow-[0_20px_50px_rgba(0,0,0,0.5)] backdrop-blur-xl relative z-10 flex flex-col justify-between"
      >
        <div className="space-y-6">
          {/* Form Header */}
          <div className="space-y-2 text-center lg:text-left">
            <h2 className="text-2xl font-black tracking-tight text-white flex items-center justify-center lg:justify-start gap-2">
              Welcome Back <span className="animate-bounce">👋</span>
            </h2>
            <p className="text-slate-400 text-xs font-medium">
              Sign in to access your Amazon Analytics Workspace.
            </p>
          </div>

          <form onSubmit={handleLogin} onKeyDown={handleKeyDown} className="space-y-4">
            {/* Username/Email Input */}
            <div className="space-y-1.5">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">
                Username or Email
              </label>
              <div className="relative group">
                <User className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 group-focus-within:text-indigo-400 transition-colors" />
                <input
                  ref={usernameRef}
                  type="text"
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full pl-11 pr-4 h-[52px] bg-white/[0.03] border border-white/10 rounded-xl text-white placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-[#7C3AED] transition-all text-sm font-semibold shadow-inner"
                  placeholder="e.g. Barm"
                />
              </div>
            </div>

            {/* Password Input */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">
                  Password
                </label>
                <a href="#" className="text-[10px] font-black text-indigo-400 hover:text-indigo-300 transition-colors tracking-wide">
                  Forgot Password?
                </a>
              </div>
              <div className="relative group">
                <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 group-focus-within:text-indigo-400 transition-colors" />
                <input
                  type={showPassword ? "text" : "password"}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full pl-11 pr-12 h-[52px] bg-white/[0.03] border border-white/10 rounded-xl text-white placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-[#7C3AED] transition-all text-sm font-semibold shadow-inner"
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white transition-colors focus:outline-none"
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            {/* Caps Lock Alert & Validation Error Messages */}
            <AnimatePresence>
              {capsLock && (
                <motion.div
                  initial={{ opacity: 0, y: -5 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="flex items-center gap-2 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 text-[10px] font-bold"
                >
                  <AlertTriangle size={14} className="shrink-0 animate-pulse" />
                  <span>Caps Lock is ON</span>
                </motion.div>
              )}

              {error && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0 }}
                  className="p-3 bg-red-500/10 text-red-400 text-xs rounded-xl border border-red-500/20 flex items-start gap-2.5 font-bold shadow-md"
                >
                  <ShieldCheck className="w-4 h-4 shrink-0 text-red-400 mt-0.5" />
                  <span>{error}</span>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Remember Me Toggle */}
            <div className="flex items-center gap-2 py-1 select-none">
              <input
                id="remember"
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                className="w-4 h-4 rounded-md border-white/10 bg-white/5 text-indigo-600 focus:ring-0 focus:ring-offset-0 cursor-pointer"
              />
              <label htmlFor="remember" className="text-[11px] font-bold text-slate-400 cursor-pointer hover:text-slate-300">
                Remember my workspace
              </label>
            </div>

            {/* Main Submit Button */}
            <button
              type="submit"
              disabled={loading}
              className="w-full h-[54px] bg-gradient-to-r from-[#7C3AED] to-[#4F46E5] hover:from-[#8B5CF6] hover:to-[#5B21B6] text-white rounded-xl font-bold text-sm transition-all flex items-center justify-center gap-2 disabled:opacity-75 shadow-lg shadow-indigo-500/15 hover:shadow-indigo-500/30 active:scale-[0.98] mt-2 group"
            >
              {loading ? (
                <Loader2 className="w-5 h-5 animate-spin text-white" />
              ) : (
                <>
                  Continue to Dashboard
                  <ArrowRight size={16} className="group-hover:translate-x-1 transition-transform" />
                </>
              )}
            </button>
          </form>
        </div>

        {/* Footer info */}
        <div className="flex items-center justify-between border-t border-white/5 pt-6 mt-8 text-[10px] text-slate-500 font-bold tracking-wide">
          <span>v1.0 Beta</span>
          <div className="flex gap-3">
            <a href="#" className="hover:text-slate-300 transition-colors">Privacy</a>
            <a href="#" className="hover:text-slate-300 transition-colors">Terms</a>
            <a href="#" className="hover:text-slate-300 transition-colors">Support</a>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
