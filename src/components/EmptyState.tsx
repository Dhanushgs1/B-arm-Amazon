import type { LucideIcon } from "lucide-react";
import { Inbox } from "lucide-react";

interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: LucideIcon;
  action?: React.ReactNode;
  compact?: boolean;
}

// "There is nothing here" — as opposed to QueryErrorState ("the request failed") and a loading
// skeleton ("not known yet"). Keeping the three visually distinct is what stops a failed or
// still-loading fetch from reading as a genuine zero.
export function EmptyState({ title, description, icon: Icon = Inbox, action, compact = false }: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-center justify-center text-center px-6 ${compact ? "py-10" : "py-16"}`}>
      <div className="w-11 h-11 rounded-2xl bg-muted border border-border flex items-center justify-center mb-3">
        <Icon className="w-5 h-5 text-muted-foreground" aria-hidden="true" />
      </div>
      <p className="font-bold text-sm text-foreground">{title}</p>
      {description && <p className="text-xs text-muted-foreground mt-1 max-w-sm">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
