"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Pencil, Loader2 } from "lucide-react";
import { CATEGORY_COLORS } from "@/lib/categoryMap";
import { updateProductMarketingRow, type ProductMarketingCatalogRow } from "@/lib/productMarketingUpload";

interface MasterProductEditModalProps {
  row: ProductMarketingCatalogRow;
  onClose: () => void;
  onSaved: () => void;
}

const CATEGORIES = Object.keys(CATEGORY_COLORS);

export function MasterProductEditModal({ row, onClose, onSaved }: MasterProductEditModalProps) {
  const [name, setName] = useState(row.name);
  const [category, setCategory] = useState(row.category || CATEGORIES[0]);
  const [platform, setPlatform] = useState(row.platform);
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setStatus("saving");
    setError(null);
    try {
      await updateProductMarketingRow(row.id, { product_name: name.trim(), category, platform: platform.trim() });
      onSaved();
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "Update failed");
    }
  };

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        />
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          className="relative w-full max-w-md bg-background border border-indigo-500/20 rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        >
          <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-gradient-to-br from-indigo-500/10 to-purple-500/10">
            <h2 className="text-lg font-bold text-indigo-600 dark:text-indigo-400 flex items-center gap-2">
              <Pencil className="w-5 h-5" /> Edit Product
            </h2>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground transition-colors">
              <X size={18} />
            </button>
          </div>

          <div className="p-6 space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-bold text-muted-foreground uppercase tracking-wide">SKU ID</label>
              <div className="px-3 py-2 rounded-lg bg-muted/40 border border-border text-sm font-mono font-bold text-foreground">
                {row.sku || "—"}
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-bold text-muted-foreground uppercase tracking-wide">Product Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm font-semibold text-foreground focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-bold text-muted-foreground uppercase tracking-wide">Category</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm font-semibold text-foreground focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-bold text-muted-foreground uppercase tracking-wide">Platform</label>
              <input
                type="text"
                value={platform}
                onChange={(e) => setPlatform(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm font-semibold text-foreground focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
              />
            </div>

            {status === "error" && <p className="text-xs font-semibold text-red-600 dark:text-red-400">{error}</p>}
          </div>

          <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-border bg-muted/20">
            <button
              onClick={onClose}
              disabled={status === "saving"}
              className="px-4 py-2 rounded-xl text-xs font-black text-muted-foreground hover:bg-muted transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={status === "saving" || !name.trim()}
              className="px-4 py-2 rounded-xl text-xs font-black bg-indigo-600 text-white hover:bg-indigo-500 transition-colors disabled:opacity-50 flex items-center gap-1.5"
            >
              {status === "saving" && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Save Changes
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
