import { createClient } from "@supabase/supabase-js";
import { lazySupabase, SUPABASE_URL, SUPABASE_ANON_KEY } from "@/lib/supabaseLazy";

// The public-schema Supabase client used for the barm_* tables. Kept in its own module: it used to
// be exported from amazonReportUpload.ts, so every file that only wanted to READ data also pulled the
// spreadsheet parsers (xlsx, papaparse) into its bundle, including the login page.
// Built on first use, not at import — see src/lib/supabaseLazy.ts.
export const supabasePublic = lazySupabase(() => createClient(SUPABASE_URL, SUPABASE_ANON_KEY));
