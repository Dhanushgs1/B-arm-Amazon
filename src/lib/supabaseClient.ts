import { createClient } from '@supabase/supabase-js';
import { lazySupabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '@/lib/supabaseLazy';

// Single client for the "barm" schema (Flipkart data). Built on first use rather than at import
// — see src/lib/supabaseLazy.ts for why a missing env var must not crash every importing page.
export const supabase = lazySupabase(() =>
  createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    db: {
      schema: 'barm',
    },
  })
);
