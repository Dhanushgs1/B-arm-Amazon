import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background text-center px-6">
      <p className="text-xs font-extrabold uppercase tracking-widest text-muted-foreground">404</p>
      <h1 className="text-2xl font-extrabold text-foreground">Page not found</h1>
      <p className="text-sm text-muted-foreground max-w-sm">
        This address does not match any dashboard page. It may have been moved or renamed.
      </p>
      <Link
        href="/dashboard"
        className="bg-primary text-primary-foreground font-extrabold text-xs px-4 py-2 rounded-lg transition hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        Go to the dashboard
      </Link>
    </div>
  );
}
