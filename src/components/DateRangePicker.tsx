"use client";

import { useState, useRef, useEffect } from "react";
import { useDashboard } from "@/lib/DashboardContext";
import { CalendarDays, ChevronLeft, ChevronRight, Check } from "lucide-react";
import { cn } from "@/lib/utils";

const PRESETS = [
  { label: "Today", days: 0 },
  { label: "Yesterday", days: 1, single: true },
  { label: "Last 7 Days", days: 7 },
  { label: "Last 14 Days", days: 14 },
  { label: "Last 30 Days", days: 30 },
  { label: "Last 60 Days", days: 60 },
  { label: "Last 90 Days", days: 90 },
  { label: "This Month", thisMonth: true },
  { label: "Last Month", lastMonth: true },
];

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function toDateStr(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseDate(s: string) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfMonth(year: number, month: number) {
  return new Date(year, month, 1).getDay();
}

function formatDisplay(start: string, end: string) {
  const fmt = (s: string) => new Date(s + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  if (start === end) {
    return fmt(start);
  }
  return `${fmt(start)} – ${fmt(end)}`;
}

interface DateRangePickerProps {
  lastDataDate?: string;
}

export function DateRangePicker({ lastDataDate }: DateRangePickerProps) {
  const { startDate, endDate, dateLabel, setDateRange } = useDashboard();
  const [open, setOpen] = useState(false);
  const [selectStart, setSelectStart] = useState<string>(startDate);
  const [selectEnd, setSelectEnd] = useState<string>(endDate);
  const [hovering, setHovering] = useState<string | null>(null);
  const [selecting, setSelecting] = useState<"start" | "end">("start");

  const today = new Date();
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());

  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const applyPreset = (preset: typeof PRESETS[0]) => {
    const now = new Date();
    // Use last data date if available, otherwise use today
    const endDate = lastDataDate ? parseDate(lastDataDate) : now;
    let start: Date, end: Date;

    if (preset.thisMonth) {
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      end = endDate;
    } else if (preset.lastMonth) {
      start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      end = new Date(now.getFullYear(), now.getMonth(), 0);
    } else if (preset.single) {
      const d = new Date(endDate);
      d.setDate(d.getDate() - 1);
      start = end = d;
    } else {
      end = endDate;
      start = new Date(endDate);
      start.setDate(start.getDate() - ((preset.days ?? 0) - 1));
    }

    setSelectStart(toDateStr(start));
    setSelectEnd(toDateStr(end));
    setDateRange(toDateStr(start), toDateStr(end), preset.label);
    setOpen(false);
  };

  const handleDayClick = (dateStr: string) => {
    if (selecting === "start") {
      setSelectStart(dateStr);
      setSelectEnd(dateStr);
      setSelecting("end");
    } else {
      if (dateStr < selectStart) {
        setSelectEnd(selectStart);
        setSelectStart(dateStr);
      } else {
        setSelectEnd(dateStr);
      }
      setSelecting("start");
    }
  };

  const applyCustom = () => {
    setDateRange(selectStart, selectEnd, formatDisplay(selectStart, selectEnd));
    setOpen(false);
  };

  const renderCalendar = () => {
    const daysInMonth = getDaysInMonth(viewYear, viewMonth);
    const firstDay = getFirstDayOfMonth(viewYear, viewMonth);
    const cells: (string | null)[] = Array(firstDay).fill(null);

    for (let d = 1; d <= daysInMonth; d++) {
      const m = String(viewMonth + 1).padStart(2, "0");
      const day = String(d).padStart(2, "0");
      cells.push(`${viewYear}-${m}-${day}`);
    }

    return (
      <div className="w-full sm:w-[300px]">
        {/* Month Navigation */}
        <div className="flex items-center justify-between mb-3 px-1">
          <button onClick={() => { if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); } else setViewMonth(m => m - 1); }}
            className="w-7 h-7 rounded-lg hover:bg-muted flex items-center justify-center transition-colors">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="font-bold text-sm">{MONTHS[viewMonth]} {viewYear}</span>
          <button onClick={() => { if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); } else setViewMonth(m => m + 1); }}
            className="w-7 h-7 rounded-lg hover:bg-muted flex items-center justify-center transition-colors">
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {/* Day Headers */}
        <div className="grid grid-cols-7 mb-1">
          {DAYS.map(d => (
            <div key={d} className="text-center text-[11px] font-bold text-muted-foreground py-1">{d}</div>
          ))}
        </div>

        {/* Calendar Cells */}
        <div className="grid grid-cols-7 gap-y-0.5">
          {cells.map((dateStr, i) => {
            if (!dateStr) return <div key={i} />;
            const isStart = dateStr === selectStart;
            const isEnd = dateStr === selectEnd;
            const isBetween = dateStr > selectStart && dateStr < (hovering && selecting === "end" ? hovering : selectEnd);
            const isToday = dateStr === toDateStr(today);
            const isFuture = dateStr > toDateStr(today);
            const isHoverBetween = selecting === "end" && hovering && dateStr > selectStart && dateStr < hovering;

            return (
              <button
                key={dateStr}
                onClick={() => !isFuture && handleDayClick(dateStr)}
                onMouseEnter={() => setHovering(dateStr)}
                onMouseLeave={() => setHovering(null)}
                disabled={isFuture}
                className={cn(
                  "h-8 w-full text-xs font-medium rounded-lg transition-all",
                  isFuture && "opacity-30 cursor-not-allowed",
                  (isStart || isEnd) && "bg-primary text-white font-bold shadow-md",
                  (isBetween || isHoverBetween) && !isStart && !isEnd && "bg-primary/15 text-primary rounded-none",
                  isToday && !isStart && !isEnd && "ring-1 ring-primary/40",
                  !isStart && !isEnd && !isBetween && !isHoverBetween && !isFuture && "hover:bg-muted"
                )}
              >
                {parseInt(dateStr.slice(-2))}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => { setOpen(!open); setSelectStart(startDate); setSelectEnd(endDate); setSelecting("start"); }}
        className={cn(
          "flex items-center gap-2 bg-card border text-foreground px-3 py-1.5 rounded-lg font-semibold text-sm shadow-sm transition-colors",
          open ? "border-primary ring-2 ring-primary/20" : "border-border hover:border-primary/50"
        )}
      >
        <CalendarDays className="w-4 h-4 text-primary" />
        <span className="max-w-[320px] truncate">
          {PRESETS.some(p => p.label === dateLabel)
            ? `${dateLabel} (${formatDisplay(startDate, endDate)})`
            : dateLabel}
        </span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 z-50 shadow-2xl border border-border rounded-2xl bg-popover/95 backdrop-blur-xl overflow-hidden flex flex-col sm:flex-row w-[calc(100vw-2rem)] max-w-[360px] sm:w-auto sm:max-w-none">
          {/* Presets Panel */}
          <div className="w-full sm:w-[160px] border-b sm:border-b-0 sm:border-r border-border p-2 flex flex-col gap-0.5">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground px-2 py-1.5">Quick Select</p>
            {PRESETS.map((preset) => (
              <button
                key={preset.label}
                onClick={() => applyPreset(preset)}
                className={cn(
                  "w-full text-left px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors flex items-center justify-between",
                  dateLabel === preset.label
                    ? "bg-primary text-white"
                    : "hover:bg-muted text-foreground"
                )}
              >
                {preset.label}
                {dateLabel === preset.label && <Check className="w-3 h-3" />}
              </button>
            ))}
          </div>

          {/* Calendar Panel */}
          <div className="p-4">
            {renderCalendar()}

            {/* Selected range display + Apply */}
            <div className="mt-4 pt-3 border-t border-border flex items-center justify-between gap-3">
              <div className="text-xs text-muted-foreground">
                <span className="font-bold text-foreground">{selectStart}</span>
                <span className="mx-1">→</span>
                <span className="font-bold text-foreground">{selectEnd}</span>
              </div>
              <button
                onClick={applyCustom}
                className="px-4 py-1.5 bg-primary text-white text-xs font-bold rounded-lg hover:bg-primary/90 transition-colors shadow-sm"
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
