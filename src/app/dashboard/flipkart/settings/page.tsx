"use client";

import { SettingsView } from "@/components/settings/SettingsView";

// Flipkart's own settings: only what applies to Flipkart (same saved values as Overall's settings).
export default function FlipkartSettingsPage() {
  return <SettingsView scope="flipkart" />;
}
