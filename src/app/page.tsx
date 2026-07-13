import HeroSection from "@/components/HeroSection";
import LoginForm from "@/components/LoginForm";

export default function Home() {
  return (
    <main className="flex h-screen w-full bg-[#070B17] overflow-hidden relative select-none">
      {/* Premium Ambient Background Effects */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#ffffff03_1px,transparent_1px),linear-gradient(to_bottom,#ffffff03_1px,transparent_1px)] bg-[size:32px_32px] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_40%,#000_80%,transparent_100%)] pointer-events-none" />
      
      {/* Deep Glowing Accent Lights */}
      <div className="absolute top-[-20%] left-[-10%] w-[60%] h-[60%] bg-indigo-500/10 rounded-full blur-[150px] pointer-events-none animate-pulse duration-[8000ms]" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-purple-500/10 rounded-full blur-[150px] pointer-events-none animate-pulse duration-[6000ms]" />
      <div className="absolute top-1/3 left-1/3 w-[30%] h-[30%] bg-cyan-500/5 rounded-full blur-[120px] pointer-events-none" />

      {/* Split Screen Layout: Left 60%, Right 40% */}
      <div className="hidden lg:flex lg:flex-[1.5] relative h-full overflow-hidden border-r border-white/5 z-10">
        <HeroSection />
      </div>
      <div className="flex-1 flex justify-center items-center w-full lg:flex-[1] bg-[#070B17] relative z-20">
        <LoginForm />
      </div>
    </main>
  );
}
