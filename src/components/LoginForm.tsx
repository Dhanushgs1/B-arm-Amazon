"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";

export default function LoginForm() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    // Simulate network delay for smooth UI
    await new Promise((resolve) => setTimeout(resolve, 800));

    if (
      (username === "Barm" && password === "Barm@123") ||
      (username === "Lkn" && password === "Lkn@123")
    ) {
      // Store which user logged in so dashboard knows which account to load
      localStorage.setItem("ppcUser", username);
      localStorage.setItem("ppcKeySlot", username === "Barm" ? "B" : "A");
      // Hard reload so React Query cache is fully cleared between users
      window.location.href = "/dashboard";
    } else {
      setError("Invalid username or password. Please try again.");
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col justify-center items-center w-full h-full p-8 bg-white">
      <div className="w-full max-w-[380px]">
        
        <div className="mb-8 text-center lg:text-left">
          <h2 className="text-3xl font-semibold tracking-tight text-slate-900 mb-2">Sign in</h2>
          <p className="text-slate-500 text-sm">Enter your details to access your dashboard.</p>
        </div>

        <form onSubmit={handleLogin} className="space-y-5">
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">Username</label>
            <input
              type="text"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-4 py-2.5 bg-white border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 transition-colors shadow-sm"
              placeholder="e.g. Barm"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-slate-700">Password</label>
              <a href="#" className="text-sm font-medium text-indigo-600 hover:underline">Forgot password?</a>
            </div>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-2.5 bg-white border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 transition-colors shadow-sm"
              placeholder="••••••••"
            />
          </div>

          {error && (
            <div className="p-3 bg-red-50 text-red-600 text-sm rounded-lg border border-red-100 flex items-start gap-2">
              <svg className="w-4 h-4 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 mt-2 bg-[#0f172a] hover:bg-slate-800 text-white rounded-lg font-medium transition-colors flex items-center justify-center disabled:opacity-70 shadow-sm"
          >
            {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : "Sign in"}
          </button>
        </form>

        <p className="mt-8 text-center text-sm text-slate-500">
          Don't have an account? <a href="#" className="font-medium text-indigo-600 hover:underline">Contact sales</a>
        </p>
      </div>
    </div>
  );
}
