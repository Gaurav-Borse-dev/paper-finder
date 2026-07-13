import { Link, useNavigate } from "@tanstack/react-router";
import { useState, useRef, useEffect } from "react";
import { LogIn, LogOut, ShieldCheck, GraduationCap, ChevronDown, UploadCloud } from "lucide-react";
import { signOut, useSession } from "@/lib/auth";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

export function UserMenu() {
  const session = useSession();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  if (!session.ready) {
    return <div className="h-9 w-20 animate-pulse rounded-full bg-muted" />;
  }

  if (session.role === "guest") {
    return (
      <Link
        to="/auth"
        search={{ mode: "signin" as const }}
        className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
      >
        <LogIn className="h-4 w-4" /> Login
      </Link>
    );
  }

  const Icon = session.role === "admin" ? ShieldCheck : GraduationCap;
  const initial = (session.name || "?").charAt(0).toUpperCase();

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-2 py-1.5 pr-3 text-sm font-medium transition hover:bg-accent"
      >
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
          {initial}
        </span>
        <span className="hidden sm:inline">{session.name}</span>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute right-0 z-30 mt-2 w-56 overflow-hidden rounded-xl border border-border bg-card shadow-[var(--shadow-elevated)]">
          <div className="border-b border-border px-4 py-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Icon className="h-3.5 w-3.5" />
              <span className="capitalize">{session.role}</span>
            </div>
            <p className="mt-0.5 truncate text-sm font-medium">{session.name}</p>
            {session.email && <p className="truncate text-xs text-muted-foreground">{session.email}</p>}
          </div>
          {session.role === "admin" && (
            <Link
              to="/admin"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 px-4 py-2.5 text-sm hover:bg-accent"
            >
              <UploadCloud className="h-4 w-4" /> Admin panel
            </Link>
          )}
          <button
            type="button"
            onClick={async () => {
              setOpen(false);
              await qc.cancelQueries();
              qc.clear();
              await signOut();
              toast.success("Signed out");
              navigate({ to: "/", replace: true });
            }}
            className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-destructive hover:bg-destructive/10"
          >
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
