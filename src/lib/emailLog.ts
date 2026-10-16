// Every outgoing email is logged in Supabase's email_log (supabase/migrations/20261016170000_email_log.sql).
// Logging never throws and never blocks a send: a failed write is only console-logged.

import { supabasePublic } from "@/lib/amazonReportUpload";

export interface EmailLogEntry {
  source: "send-email" | "ad-spend-edge";
  mail_type?: string;
  subject?: string;
  to_addr?: string;
  cc_addr?: string;
  attachments?: string[];
  status: "queued" | "sent" | "failed" | "paused";
  error?: string | null;
  message_id?: string | null;
  job_id?: number | null;
}

const list = (v: unknown) => (Array.isArray(v) ? v.join(", ") : String(v ?? ""));

export async function logEmail(e: EmailLogEntry): Promise<void> {
  try {
    const { error } = await supabasePublic.from("email_log").insert({
      ...e,
      to_addr: list(e.to_addr), cc_addr: list(e.cc_addr),
      attachments: e.attachments ?? [],
      sent_at: e.status === "sent" ? new Date().toISOString() : null,
    });
    if (error) console.error("[Marketplace360] email_log write failed:", error.message);
  } catch (err) {
    console.error("[Marketplace360] email_log write failed:", err);
  }
}

/** Marks the queued ad spend row of a job as failed (the Edge Function was never reached). */
export async function failQueued(jobId: number, error: string): Promise<void> {
  try {
    const { error: e } = await supabasePublic.from("email_log").update({ status: "failed", error })
      .eq("job_id", jobId).eq("status", "queued");
    if (e) console.error("[Marketplace360] email_log update failed:", e.message);
  } catch (err) {
    console.error("[Marketplace360] email_log update failed:", err);
  }
}

/** Attachment file names from a send-email body. */
export function attachmentNames(attachments: unknown): string[] {
  return Array.isArray(attachments) ? attachments.map((a) => String((a as { filename?: unknown })?.filename ?? "")).filter(Boolean) : [];
}
