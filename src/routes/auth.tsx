import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ArrowLeft, LogIn, UserPlus } from "lucide-react";
import { Logo } from "@/components/Logo";
import { supabase } from "@/integrations/supabase/client";

interface AuthSearch {
  redirect?: string;
  mode?: "signin" | "signup";
}

export const Route = createFileRoute("/auth")({
  validateSearch: (s: Record<string, unknown>): AuthSearch => ({
    redirect: typeof s.redirect === "string" ? s.redirect : undefined,
    mode: s.mode === "signup" ? "signup" : "signin",
  }),
  component: AuthPage,
});

function AuthPage() {
  const search = useSearch({ from: "/auth" });
  const navigate = useNavigate();
  const [tab, setTab] = useState<"signin" | "signup">(search.mode ?? "signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) {
        const to = search.redirect && search.redirect.startsWith("/") ? search.redirect : "/";
        navigate({ to, replace: true });
      }
    });
  }, [navigate, search.redirect]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (tab === "signup") {
        const { error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/`,
            data: { name: name.trim() },
          },
        });
        if (error) throw error;
        toast.success("Account created! Signing you in…");
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (error) throw error;
        toast.success("Signed in");
      }
      const to = search.redirect && search.redirect.startsWith("/") ? search.redirect : "/";
      navigate({ to, replace: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong";
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <Logo />
        <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back
        </Link>
      </header>

      <main className="mx-auto mt-8 max-w-md px-6">
        <div className="rounded-3xl border border-border bg-card p-8 shadow-[var(--shadow-elevated)]">
          <h1 className="text-2xl font-semibold tracking-tight">
            {tab === "signin" ? "Sign in" : "Create an account"}
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Students can browse & give feedback. Admins can upload papers.
          </p>

          <div className="mt-6 inline-flex w-full rounded-full border border-border bg-muted p-1 text-xs font-medium">
            <button
              type="button"
              onClick={() => setTab("signin")}
              className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-full px-3 py-2 transition ${
                tab === "signin" ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <LogIn className="h-3.5 w-3.5" /> Sign in
            </button>
            <button
              type="button"
              onClick={() => setTab("signup")}
              className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-full px-3 py-2 transition ${
                tab === "signup" ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <UserPlus className="h-3.5 w-3.5" /> Sign up
            </button>
          </div>

          <form onSubmit={submit} className="mt-6 space-y-3">
            {tab === "signup" && (
              <Field label="Name">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  required
                  className={fieldCls}
                />
              </Field>
            )}
            <Field label="Email">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                required
                className={fieldCls}
              />
            </Field>
            <Field label="Password">
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 6 characters"
                autoComplete={tab === "signin" ? "current-password" : "new-password"}
                required
                minLength={6}
                className={fieldCls}
              />
            </Field>
            <button
              type="submit"
              disabled={busy}
              className="mt-2 w-full rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
            >
              {busy ? "Please wait…" : tab === "signin" ? "Sign in" : "Create account"}
            </button>
          </form>

          <p className="mt-6 text-xs text-muted-foreground">
            Admins: sign up (or sign in) with the email seeded in the migration
            to get admin access automatically.
          </p>
        </div>
      </main>
    </div>
  );
}

const fieldCls =
  "w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-xs">
      <span className="font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
