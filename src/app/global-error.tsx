"use client"; // Error boundaries must be Client Components

// Last-resort boundary for an error in the root layout itself. It replaces the whole document, so
// it must render its own <html>/<body> and cannot rely on the app's stylesheet being loaded.
export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#0f172a", color: "#e2e8f0" }}>
        <div role="alert" style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, textAlign: "center", padding: 24 }}>
          <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>The dashboard could not load</h1>
          <p style={{ fontSize: 14, color: "#94a3b8", maxWidth: 420, margin: 0 }}>
            Nothing was changed or lost. Try again; if it keeps happening, reload the page.
          </p>
          {error?.digest && <p style={{ fontSize: 12, color: "#64748b", margin: 0 }}>Reference: {error.digest}</p>}
          <button
            onClick={() => unstable_retry()}
            style={{ background: "#4f46e5", color: "#fff", border: 0, borderRadius: 8, padding: "10px 18px", fontWeight: 800, fontSize: 13, cursor: "pointer" }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
