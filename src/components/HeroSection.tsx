import { Hexagon, TrendingUp, Zap, Target } from "lucide-react";

export default function HeroSection() {
  return (
    <div className="relative flex flex-col justify-between w-full h-full bg-[#0a0a0a] text-white p-12 overflow-hidden border-r border-white/10">
      {/* Subtle Grid Background */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#ffffff0a_1px,transparent_1px),linear-gradient(to_bottom,#ffffff0a_1px,transparent_1px)] bg-[size:24px_24px] [mask-image:radial-gradient(ellipse_80%_50%_at_50%_0%,#000_70%,transparent_100%)]"></div>
      
      {/* Glowing Orbs */}
      <div className="absolute top-0 left-1/4 w-[500px] h-[500px] bg-indigo-600/20 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-0 right-0 w-[400px] h-[400px] bg-purple-600/20 rounded-full blur-[100px] pointer-events-none" />

      {/* Logo */}
      <div className="relative z-10 flex items-center gap-3">
        <div className="w-10 h-10 bg-indigo-500/20 rounded-xl flex items-center justify-center text-indigo-400 border border-indigo-500/30 shadow-[0_0_15px_rgba(99,102,241,0.2)]">
          <Hexagon size={24} fill="currentColor" />
        </div>
        <span className="font-bold text-xl tracking-tight">BARM AI</span>
      </div>

      {/* Main Content */}
      <div className="relative z-10 max-w-xl mb-10">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-xs font-medium text-slate-300 mb-6">
          <span className="flex w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          Live SellerMate Integration
        </div>
        
        <h1 className="text-5xl font-medium tracking-tight mb-6 leading-[1.15]">
          Enterprise <br />
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 via-purple-400 to-cyan-400">
            Amazon Analytics
          </span>
        </h1>
        <p className="text-lg text-slate-400 leading-relaxed mb-10">
          Unify your advertising data. Automate bids with AI. Dominate your category with precision forecasting.
        </p>

        {/* Feature List */}
        <div className="space-y-5">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-slate-300">
              <TrendingUp size={20} />
            </div>
            <div>
              <h3 className="font-semibold text-slate-200">Real-time Performance</h3>
              <p className="text-sm text-slate-500">Track ACOS, ROAS, and Ad Sales instantly.</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-slate-300">
              <Zap size={20} />
            </div>
            <div>
              <h3 className="font-semibold text-slate-200">AI-Powered Bid Automation</h3>
              <p className="text-sm text-slate-500">Optimize campaigns automatically 24/7.</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-slate-300">
              <Target size={20} />
            </div>
            <div>
              <h3 className="font-semibold text-slate-200">Precision Forecasting</h3>
              <p className="text-sm text-slate-500">Predict inventory needs and budget pacing.</p>
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="relative z-10">
        <p className="text-sm text-slate-500 font-medium mb-4">Trusted by top sellers</p>
        <div className="flex gap-8 opacity-40 grayscale">
           <span className="font-black text-xl tracking-tighter">LKN</span>
           <span className="font-black text-xl italic tracking-tight">SellerMate</span>
        </div>
      </div>
    </div>
  );
}
