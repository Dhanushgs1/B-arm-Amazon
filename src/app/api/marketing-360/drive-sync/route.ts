// Product Marketing 360 Drive auto-import: GET = the last run's result; POST = run one pass now
// (signed-in users). The hourly loop itself is started from src/instrumentation.ts.
import { NextResponse } from "next/server";
import { checkSession } from "@/lib/apiAuth";
import { rejectUnlessAllowed } from "@/lib/appRouteAuth";
import { lastDriveSync, serviceAccount, syncDriveOnce } from "@/lib/server/marketing360DriveSync";

export const dynamic = "force-dynamic";

function configured(): { ok: boolean; account: string | null; error?: string } {
  try {
    const sa = serviceAccount();
    return { ok: sa !== null, account: sa?.client_email ?? null };
  } catch (e) {
    return { ok: false, account: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function GET(req: Request) {
  const rejected = rejectUnlessAllowed(req, checkSession, { bucket: "marketing-360-drive", limit: 60, windowMs: 60_000 });
  if (rejected) return rejected;
  return NextResponse.json({ configured: configured(), last: lastDriveSync() });
}

export async function POST(req: Request) {
  const rejected = rejectUnlessAllowed(req, checkSession, { bucket: "marketing-360-drive-run", limit: 4, windowMs: 60_000 });
  if (rejected) return rejected;
  const cfg = configured();
  if (!cfg.ok) return NextResponse.json({ error: cfg.error ?? "No Google service account configured on the server", configured: cfg }, { status: 503 });
  const dry = new URL(req.url).searchParams.get("dry") === "1";
  return NextResponse.json({ configured: cfg, result: await syncDriveOnce({ dry }) });
}
