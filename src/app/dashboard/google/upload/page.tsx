"use client";

import { useState, useEffect, useCallback } from "react";
import { UploadCloud, CheckCircle2, XCircle, Loader2, FileSpreadsheet } from "lucide-react";
import { uploadGoogleOrdersFile, fetchGoogleOrdersDataInfo, type GoogleOrdersDataInfo } from "@/lib/googleOrdersUpload";

// Mirrors /dashboard/meesho/upload at Google's much smaller scale — one card,
// one file shape (the seller's own hand-kept "B-Arm Orders" workbook: S no,
// Invoice, Product, Qty, Price, no date column, no ad-spend data of any kind).
// This page only exists to get this channel's Orders/Sales into the Ad Spend
// Report's "Google" Summary row and Ad spend report sheet — there's no full
// Google Ads analytics section since no ad campaign export exists for it yet.

interface CardState {
  status: "idle" | "parsing" | "done" | "error";
  fileName?: string;
  message?: string;
}

export default function GoogleUploadReportsPage() {
  const [state, setState] = useState<CardState>({ status: "idle" });
  const [info, setInfo] = useState<GoogleOrdersDataInfo | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const refreshMeta = useCallback(async () => {
    const res = await fetchGoogleOrdersDataInfo();
    setInfo(res);
  }, []);

  useEffect(() => {
    refreshMeta();
  }, [refreshMeta]);

  const handleFile = async (file: File) => {
    setState({ status: "parsing", fileName: file.name });
    try {
      const res = await uploadGoogleOrdersFile(file);
      if (!res.layout) {
        setState({
          status: "error",
          fileName: file.name,
          message:
            "No header row found — expected the offline layout (Date, Product, Quantity, Price per Product, Total Price, SKU ID) or the B-Arm Orders workbook (S no, Date, Invoice, Sku, Qty, Price). Nothing was saved.",
        });
        return;
      }
      const span = res.minDate ? ` · ${res.minDate}${res.maxDate !== res.minDate ? ` to ${res.maxDate}` : ""}` : "";
      setState({
        status: "done",
        fileName: file.name,
        message:
          `${res.savedRows.toLocaleString("en-IN")} rows saved${res.skippedRows ? `, ${res.skippedRows} skipped` : ""} (of ${res.totalRows.toLocaleString("en-IN")})${span}` +
          // Price comes only from the file — say so when it gave none, instead of showing ₹0 silently.
          (res.rowsWithoutPrice
            ? ` · ${res.rowsWithoutPrice} row${res.rowsWithoutPrice === 1 ? " has" : "s have"} no price in the file, so Sales is blank for them — fill "Price per Product" and upload again to update`
            : ""),
      });
      refreshMeta();
    } catch (err) {
      setState({ status: "error", fileName: file.name, message: err instanceof Error ? err.message : "Upload failed" });
    }
  };

  return (
    <div className="space-y-8 pb-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight mb-0.5">Google — Upload Orders</h1>
        <p className="text-muted-foreground text-sm">
          Upload the &quot;B-Arm Orders&quot; workbook here to bring direct/Google-driven sales into the Ad Spend
          Report on the <a href="/dashboard/reports" className="underline hover:text-foreground">Download page</a>.
          This channel has no ad spend/CPC/ACOS data — only Orders and Sales (Quantity x Price). Re-uploading the
          same file (for example after filling in prices) updates those rows, so nothing gets duplicated.
        </p>
      </div>

      <div
        className={`glass rounded-2xl border p-5 shadow-sm transition-colors max-w-md ${dragOver ? "border-primary" : "border-border"}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) handleFile(f);
        }}
      >
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
            <FileSpreadsheet size={18} />
          </div>
          <div className="min-w-0">
            <h3 className="font-bold text-sm text-foreground">B-Arm Orders (Google)</h3>
            <span className="text-[10px] text-muted-foreground uppercase font-black tracking-wider">CSV / XLSX</span>
          </div>
        </div>

        <p className="text-[11px] text-muted-foreground mb-3 leading-snug">
          The B-ARM Offline Orders file (Date, Product, Quantity, Price per Product, Total Price, SKU ID), or the
          older B-Arm Orders workbook (S no, Invoice, Sku, Qty, Price). Price is read from the file only.
        </p>

        <label
          htmlFor="google-upload-orders"
          className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-border rounded-xl py-6 cursor-pointer hover:border-primary/50 transition-colors"
        >
          <UploadCloud size={22} className="text-muted-foreground" />
          <span className="text-xs text-muted-foreground px-2 text-center truncate max-w-full">
            {state.fileName || "Click or drop CSV/XLSX here"}
          </span>
        </label>
        {info && !info.error && (
          <p className="text-[10px] text-muted-foreground mt-1">
            On file: <b className="text-foreground">{info.totalUnits.toLocaleString("en-IN")}</b> units,{" "}
            <b className="text-foreground">₹{info.totalValue.toLocaleString("en-IN")}</b> ({info.rowCount.toLocaleString("en-IN")} rows)
          </p>
        )}
        {info?.error && (
          <p className="text-[10px] text-red-600 dark:text-red-400 mt-1">
            Couldn&apos;t check — {info.error}. Have you run scripts/google_orders_table.sql in the Supabase SQL Editor yet?
          </p>
        )}
        <input
          id="google-upload-orders"
          type="file"
          accept=".csv,.xlsx,.xls"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
            e.target.value = "";
          }}
        />

        <div className="mt-3 text-xs min-h-[1.25rem]">
          {state.status === "parsing" && (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Parsing &amp; saving…
            </span>
          )}
          {state.status === "done" && (
            <span className="flex items-start gap-1.5 text-green-600 dark:text-green-400 font-semibold">
              <CheckCircle2 size={14} className="mt-0.5 flex-shrink-0" /> {state.message}
            </span>
          )}
          {state.status === "error" && (
            <span className="flex items-start gap-1.5 text-red-600 dark:text-red-400 font-semibold">
              <XCircle size={14} className="mt-0.5 flex-shrink-0" /> {state.message}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
