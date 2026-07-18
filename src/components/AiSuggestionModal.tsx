"use client";

import { motion, AnimatePresence } from "framer-motion";
import { X, Sparkles } from "lucide-react";

interface AiSuggestionModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  suggestions: string[];
}

export function AiSuggestionModal({ isOpen, onClose, title, suggestions }: AiSuggestionModalProps) {
  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
        <motion.div initial={{ opacity: 0, scale: 0.95, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 10 }} className="relative w-full max-w-lg bg-background border border-indigo-500/20 rounded-2xl shadow-2xl flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-gradient-to-br from-indigo-500/10 to-purple-500/10">
            <h2 className="text-lg font-bold text-indigo-600 dark:text-indigo-400 flex items-center gap-2">
              <Sparkles className="w-5 h-5" /> {title}
            </h2>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground transition-colors"><X size={18} /></button>
          </div>
          <div className="p-6 space-y-4">
            {suggestions.map((s, i) => (
              <div key={i} className="flex gap-3 items-start bg-muted/30 p-4 rounded-xl border border-border">
                <div className="w-6 h-6 rounded-full bg-indigo-500/20 text-indigo-600 dark:text-indigo-400 flex items-center justify-center flex-shrink-0 mt-0.5 text-xs font-bold">{i + 1}</div>
                <p className="text-sm font-medium text-foreground leading-relaxed">{s}</p>
              </div>
            ))}
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
