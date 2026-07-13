import HeroSection from "@/components/HeroSection";
import LoginForm from "@/components/LoginForm";

export default function Home() {
  return (
    <main className="flex h-screen w-full bg-white overflow-hidden">
      <div className="hidden lg:flex flex-1 relative">
        <HeroSection />
      </div>
      <div className="flex-1 flex justify-center items-center w-full lg:max-w-xl bg-white">
        <LoginForm />
      </div>
    </main>
  );
}
