"use client";

import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";

interface KpiDrilldownModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  data: any[];
  columns: { key: string; label: string; render?: (val: any, row: any) => React.ReactNode }[];
}

export function KpiDrilldownModal({ isOpen, onClose, title, data, columns }: KpiDrilldownModalProps) {
  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
        {/* Backdrop */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        />

        {/* Modal */}
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          className="relative w-full max-w-4xl max-h-[85vh] bg-background border border-border rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-muted/30">
            <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
              {title}
              <span className="bg-primary/10 text-primary text-[10px] px-2 py-0.5 rounded-full font-black">
                {data.length} ITEMS
              </span>
            </h2>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground transition-colors"
            >
              <X size={18} />
            </button>
          </div>

          {/* Table Content */}
          <div className="flex-1 overflow-auto p-0">
            {data.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
                <p className="text-sm font-medium">No data available for this metric.</p>
              </div>
            ) : (
              <table className="w-full text-left text-sm border-collapse">
                <thead className="bg-muted/30 sticky top-0 z-10 backdrop-blur-md">
                  <tr>
                    {columns.map((col) => (
                      <th key={col.key} className="px-4 py-3 font-semibold text-xs text-muted-foreground uppercase tracking-wider border-b border-border whitespace-nowrap">
                        {col.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.map((row, i) => (
                    <tr key={i} className="hover:bg-muted/30 transition-colors group">
                      {columns.map((col) => {
                        const val = row[col.key];
                        return (
                          <td key={col.key} className="px-4 py-3 whitespace-nowrap font-medium text-foreground">
                            {col.render ? col.render(val, row) : val}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
