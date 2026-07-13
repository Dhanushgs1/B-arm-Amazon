"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { DashboardProvider } from "@/lib/DashboardContext";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        staleTime: 5 * 60 * 1000, // 5 minutes cache
      },
    },
  }));

  return (
    <QueryClientProvider client={queryClient}>
      <DashboardProvider>
        {children}
      </DashboardProvider>
    </QueryClientProvider>
  );
}
