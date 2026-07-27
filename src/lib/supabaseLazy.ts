// createClient() throws synchronously when the URL or key is empty, and both Supabase clients in
// this app are module-level constants — so a missing NEXT_PUBLIC_SUPABASE_* variable took down
// every page that transitively imported one, rendering Next's global error boundary ("This page
// couldn't load") instead of the dashboard. That is exactly what happened in production: the
// vars were set locally in .env.local but never added to the Vercel project, so the server
// prerendered fine while the browser bundle inlined "" for both and crashed on hydration.
//
// Deferring construction to first use keeps that failure where it belongs — the one feature that
// actually talks to Supabase throws a message naming the missing variable, and the rest of the
// dashboard still renders.

// Generic over the client type so a schema-scoped client (e.g. the "barm" one in
// supabaseClient.ts) keeps its own type parameters instead of being widened to the default.

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "";

export function isSupabaseConfigured() {
  return !!(SUPABASE_URL && SUPABASE_ANON_KEY);
}

function missingConfigError() {
  const missing = [
    !SUPABASE_URL && "NEXT_PUBLIC_SUPABASE_URL",
    !SUPABASE_ANON_KEY && "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  ].filter(Boolean).join(" and ");
  return new Error(
    `Supabase is not configured in this environment — ${missing} is not set. ` +
      `The NEXT_PUBLIC_ prefix is required: without it the value never reaches the browser bundle, ` +
      `so the server works and the client does not.`
  );
}

/**
 * A Supabase client that is only really constructed on first property access. Same call sites as
 * before (`db.from(...)`), but an unconfigured environment fails at the query rather than at
 * import time.
 */
export function lazySupabase<T extends object>(factory: () => T): T {
  let real: T | null = null;
  return new Proxy({} as T, {
    get(_target, prop, receiver) {
      if (!real) {
        if (!isSupabaseConfigured()) throw missingConfigError();
        real = factory();
      }
      const value = Reflect.get(real as object, prop, receiver);
      // Methods must stay bound to the real client, not to the proxy.
      return typeof value === "function" ? value.bind(real) : value;
    },
  });
}
