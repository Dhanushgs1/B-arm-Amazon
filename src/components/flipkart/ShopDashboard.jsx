'use client';
import React, { use,  useState } from 'react';
import { 
  Activity, DollarSign, ShoppingBag, Users, 
  RefreshCw, LayoutDashboard, Settings, LogOut,
  ArrowUpRight, ArrowDownRight, Package, Calendar
} from 'lucide-react';
import { 
  AreaChart, Area, XAxis, YAxis, CartesianGrid, 
  Tooltip as RechartsTooltip, ResponsiveContainer 
} from 'recharts';

// Placeholder data for the chart
const REVENUE_DATA = [
  { name: 'Mon', revenue: 12400 },
  { name: 'Tue', revenue: 15600 },
  { name: 'Wed', revenue: 13800 },
  { name: 'Thu', revenue: 19500 },
  { name: 'Fri', revenue: 24200 },
  { name: 'Sat', revenue: 28900 },
  { name: 'Sun', revenue: 32100 },
];

const RECENT_ORDERS = [
  { id: '#ORD-9843', customer: 'Arun Kumar', amount: '₹1,240', status: 'Delivered', date: 'Just now' },
  { id: '#ORD-9842', customer: 'Priya S', amount: '₹890', status: 'Processing', date: '2 hrs ago' },
  { id: '#ORD-9841', customer: 'Karthik Raja', amount: '₹3,450', status: 'Shipped', date: '5 hrs ago' },
  { id: '#ORD-9840', customer: 'Sneha R', amount: '₹450', status: 'Delivered', date: 'Yesterday' },
];

export default function ShopDashboard({ user, onLogout }) {
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSync, setLastSync] = useState('Never synced');

  const handleStartSync = async () => {
    setIsSyncing(true);
    // Simulate API fetch delay
    await new Promise(resolve => setTimeout(resolve, 2000));
    setLastSync(new Date().toLocaleTimeString());
    setIsSyncing(false);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 flex font-sans overflow-hidden">
      {/* Sidebar Navigation */}
      <aside className="w-64 border-r border-slate-800/50 bg-slate-900/40 backdrop-blur-xl flex flex-col justify-between hidden md:flex">
        <div>
          <div className="p-6 pb-8 border-b border-slate-800/50 flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
              <ShoppingBag className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="font-bold text-white tracking-wide">LKN Store</h1>
              <p className="text-xs text-slate-500 font-medium tracking-widest uppercase">Admin Panel</p>
            </div>
          </div>
          <nav className="p-4 space-y-1">
            <button className="w-full flex items-center gap-3 px-4 py-3 bg-indigo-500/10 text-indigo-400 rounded-xl font-medium transition-all">
              <LayoutDashboard className="w-5 h-5" />
              Overview
            </button>
            <button className="w-full flex items-center gap-3 px-4 py-3 text-slate-400 hover:text-white hover:bg-white/5 rounded-xl font-medium transition-all">
              <Package className="w-5 h-5" />
              Orders
            </button>
            <button className="w-full flex items-center gap-3 px-4 py-3 text-slate-400 hover:text-white hover:bg-white/5 rounded-xl font-medium transition-all">
              <Users className="w-5 h-5" />
              Customers
            </button>
            <button className="w-full flex items-center gap-3 px-4 py-3 text-slate-400 hover:text-white hover:bg-white/5 rounded-xl font-medium transition-all">
              <Settings className="w-5 h-5" />
              Settings
            </button>
          </nav>
        </div>

        <div className="p-4 border-t border-slate-800/50">
          <div className="px-4 py-3 rounded-xl bg-slate-900/50 border border-white/5 flex items-center justify-between">
            <div className="flex items-center gap-3 overflow-hidden">
              <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-slate-400 font-bold shrink-0">
                {user?.name?.[0] || 'A'}
              </div>
              <div className="truncate">
                <p className="text-sm font-medium text-white truncate">{user?.name || 'Admin'}</p>
                <p className="text-xs text-slate-500 truncate">{user?.email || 'admin@lkn.com'}</p>
              </div>
            </div>
            <button onClick={onLogout} className="text-slate-500 hover:text-red-400 transition-colors p-1">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col h-screen overflow-y-auto relative">
        {/* Top Header */}
        <header className="sticky top-0 z-20 backdrop-blur-xl bg-slate-950/80 border-b border-slate-800/50 px-8 py-5 flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-black text-white">Dashboard Overview</h2>
            <p className="text-sm text-slate-400">Welcome back. Here's what's happening with your store today.</p>
          </div>
          
          <div className="flex items-center gap-4">
            <div className="text-right hidden sm:block">
              <p className="text-xs text-slate-500 uppercase tracking-wider font-bold">Last Synced</p>
              <p className="text-sm text-slate-300">{lastSync}</p>
            </div>
            <button 
              onClick={handleStartSync}
              disabled={isSyncing}
              className={`flex items-center gap-2 px-5 py-2.5 rounded-xl font-bold transition-all shadow-lg ${
                isSyncing 
                  ? 'bg-slate-800 text-slate-400 cursor-not-allowed border border-white/5' 
                  : 'bg-gradient-to-r from-indigo-500 to-purple-600 text-white hover:shadow-indigo-500/25 hover:scale-[1.02] active:scale-95'
              }`}
            >
              <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin text-indigo-400' : ''}`} />
              {isSyncing ? 'Syncing...' : 'Start Sync'}
            </button>
          </div>
        </header>

        {/* Dashboard Body */}
        <div className="p-8 space-y-8 pb-20 relative z-10">
          
          {/* Key Metrics Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <MetricCard 
              title="Total Revenue" 
              value="₹1,46,500" 
              trend="+12.5%" 
              isPositive={true} 
              icon={<DollarSign className="w-5 h-5 text-emerald-400" />} 
              gradient="from-emerald-500/20 to-emerald-500/0"
              border="border-emerald-500/20"
            />
            <MetricCard 
              title="Total Orders" 
              value="842" 
              trend="+5.2%" 
              isPositive={true} 
              icon={<ShoppingBag className="w-5 h-5 text-indigo-400" />} 
              gradient="from-indigo-500/20 to-indigo-500/0"
              border="border-indigo-500/20"
            />
            <MetricCard 
              title="Active Customers" 
              value="12.4k" 
              trend="-1.1%" 
              isPositive={false} 
              icon={<Users className="w-5 h-5 text-rose-400" />} 
              gradient="from-rose-500/20 to-rose-500/0"
              border="border-rose-500/20"
            />
            <MetricCard 
              title="Conversion Rate" 
              value="3.2%" 
              trend="+0.4%" 
              isPositive={true} 
              icon={<Activity className="w-5 h-5 text-amber-400" />} 
              gradient="from-amber-500/20 to-amber-500/0"
              border="border-amber-500/20"
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* Main Chart */}
            <div className="lg:col-span-2 bg-slate-900/40 border border-white/5 rounded-3xl p-6 backdrop-blur-sm relative overflow-hidden">
              <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 opacity-50"></div>
              <div className="flex items-center justify-between mb-8">
                <div>
                  <h3 className="text-lg font-bold text-white">Revenue Overview</h3>
                  <p className="text-sm text-slate-400">Last 7 days performance</p>
                </div>
                <button className="px-3 py-1.5 rounded-lg bg-white/5 text-slate-300 text-sm font-medium hover:bg-white/10 transition-colors">
                  View Full Report
                </button>
              </div>
              
              <div className="h-72 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={REVENUE_DATA} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3}/>
                        <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                    <XAxis dataKey="name" stroke="#64748b" fontSize={12} tickLine={false} axisLine={false} />
                    <YAxis stroke="#64748b" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(val) => `₹${val/1000}k`} />
                    <RechartsTooltip 
                      contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', borderRadius: '12px', color: '#fff' }}
                      itemStyle={{ color: '#818cf8', fontWeight: 'bold' }}
                      formatter={(value) => [`₹${value}`, 'Revenue']}
                    />
                    <Area type="monotone" dataKey="revenue" stroke="#818cf8" strokeWidth={3} fillOpacity={1} fill="url(#colorRevenue)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Recent Orders */}
            <div className="bg-slate-900/40 border border-white/5 rounded-3xl p-6 backdrop-blur-sm">
              <div className="flex items-center justify-between mb-6">
                <h3 className="text-lg font-bold text-white">Recent Orders</h3>
                <button className="p-2 rounded-lg bg-white/5 text-slate-400 hover:text-white transition-colors">
                  <ArrowUpRight className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-4">
                {RECENT_ORDERS.map((order, i) => (
                  <div key={i} className="group p-4 rounded-2xl bg-white/[0.02] border border-white/5 hover:bg-white/[0.04] transition-colors flex items-center justify-between cursor-pointer">
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-xl bg-slate-800 flex items-center justify-center text-slate-400 group-hover:text-white group-hover:bg-indigo-500/20 transition-all">
                        <Package className="w-5 h-5" />
                      </div>
                      <div>
                        <p className="text-sm font-bold text-white mb-0.5">{order.customer}</p>
                        <div className="flex items-center gap-2 text-xs">
                          <span className="text-slate-400">{order.id}</span>
                          <span className="w-1 h-1 rounded-full bg-slate-700"></span>
                          <span className="text-slate-500">{order.date}</span>
                        </div>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-bold text-white mb-0.5">{order.amount}</p>
                      <p className={`text-[10px] font-bold uppercase tracking-wider ${
                        order.status === 'Delivered' ? 'text-emerald-400' :
                        order.status === 'Processing' ? 'text-amber-400' : 'text-blue-400'
                      }`}>
                        {order.status}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
              
              <button className="w-full mt-6 py-3 rounded-xl border border-white/10 text-slate-300 text-sm font-bold hover:bg-white/5 transition-colors">
                View All Orders
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function MetricCard({ title, value, trend, isPositive, icon, gradient, border }) {
  return (
    <div className="relative overflow-hidden bg-slate-900/50 backdrop-blur-xl border border-white/5 rounded-3xl p-6 group hover:-translate-y-1 transition-transform duration-300">
      <div className={`absolute inset-0 bg-gradient-to-b ${gradient} opacity-50`}></div>
      <div className={`absolute top-0 left-0 w-full h-1 bg-gradient-to-r ${gradient.replace('to-','').replace('/0','')} opacity-50`}></div>
      
      <div className="relative z-10 flex justify-between items-start mb-4">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center bg-slate-950 border ${border}`}>
          {icon}
        </div>
        <div className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold ${
          isPositive ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
        }`}>
          {isPositive ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
          {trend}
        </div>
      </div>
      
      <div className="relative z-10">
        <p className="text-slate-400 text-sm font-medium mb-1">{title}</p>
        <h3 className="text-3xl font-black text-white tracking-tight">{value}</h3>
      </div>
    </div>
  );
}
