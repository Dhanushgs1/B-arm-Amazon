import { BarChart3, CheckCircle2 } from "lucide-react";
import LoginForm from "@/components/LoginForm";

// Sign-in page: simple and professional, in the light green theme (user, 12 Nov 2026). The left panel
// says plainly what the dashboard does; no sample figures (the old page showed made-up numbers).
const POINTS = [
  "Amazon, Flipkart, Meesho, Shopify and website sales in one place",
  "Ad spend, ROAS and ACOS for every channel, day by day",
  "Ask questions about sales, stock, returns and ads",
];

function Brand({ className = "" }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <span className="w-9 h-9 rounded-xl bg-emerald-600 flex items-center justify-center text-white shadow-sm">
        <BarChart3 className="w-5 h-5" aria-hidden />
      </span>
      <span>
        <span className="block font-bold text-[17px] leading-tight tracking-tight text-slate-900">Marketplace360</span>
        <span className="block text-[11px] font-medium text-emerald-700">B-ARM sales &amp; marketing dashboard</span>
      </span>
    </div>
  );
}

export default function Home() {
  return (
    <main className="min-h-screen w-full bg-[#f2f7f4] flex">
      {/* brand panel (wide screens) */}
      <section className="hidden lg:flex lg:w-[46%] flex-col justify-between p-12 bg-gradient-to-br from-emerald-50 via-[#eef6f1] to-[#f2f7f4] border-r border-emerald-100">
        <Brand />
        <div className="max-w-md space-y-6">
          <h2 className="text-[34px] leading-tight font-semibold tracking-tight text-slate-900">
            Your marketplaces, <span className="text-emerald-700">one clear view.</span>
          </h2>
          <ul className="space-y-3">
            {POINTS.map((p) => (
              <li key={p} className="flex items-start gap-3 text-[15px] text-slate-600">
                <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" aria-hidden /> {p}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-slate-400">© B-ARM · Marketplace360</p>
      </section>

      {/* sign-in */}
      <section className="flex-1 flex flex-col items-center justify-center px-4 py-10 gap-8">
        <Brand className="lg:hidden" />
        <LoginForm />
      </section>
    </main>
  );
}
