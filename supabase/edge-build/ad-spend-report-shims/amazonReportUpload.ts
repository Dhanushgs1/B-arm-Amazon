// Edge (Deno) stand-in for src/lib/amazonReportUpload.ts — only what the report needs, same as the
// live v62 bundle's deps/amazonReportUpload.ts.
import { createClient } from "npm:@supabase/supabase-js@2.110.8";

// deno-lint-ignore no-explicit-any
declare const Deno: any;
export const supabasePublic = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_ANON_KEY"));

// deno-lint-ignore no-explicit-any
export async function upsertInChunks(table: string, rows: any[], onConflict: string, chunkSize = 300): Promise<void> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await supabasePublic.from(table).upsert(chunk, { onConflict });
    if (error) throw new Error(`Upsert into ${table} failed: ${error.message}`);
  }
}
