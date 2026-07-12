import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { ArrowLeft, GraduationCap, ShieldCheck } from "lucide-react";
import { Logo } from "@/components/Logo";
import { loginAdmin, loginStudent } from "@/lib/auth";

interface LoginSearch {
  redirect?: string;
  mode?: "student" | "admin";
}

export const Route = createFileRoute("/login")({
  validateSearch: (s: Record<string, unknown>): LoginSearch => ({
    redirect: typeof s.redirect === "string" ? s.redirect : undefined,
    mode: s.mode === "admin" || s.mode === "student" ? s.mode : undefined,
  }),
  component: LoginPage,
});

function LoginPage() {
  const search = useSearch({ from: "/login" });
  const navigate = useNavigate();
  const [tab, setTab] = useState<"student" | "admin">(search.mode ?? "student");

  // Student fields
  const [sName, setSName] = useState("");
  const [sEmail, setSEmail] = useState("");

  // Admin fields
  const [aEmail, setAEmail] = useState("");
  const [aPassword, setAPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const goNext = (fallback: string) => {
    const to = search.redirect && search.redirect.startsWith("/") ? search.redirect : fallback;
    navigate({ to, replace: true });
  };

  const submitStudent = (e: React.FormEvent) => {
    e.preventDefault();
    if (!sName.trim()) {
      toast.error("Please enter your name");
      return;
    }
    loginStudent(sName, sEmail);
    toast.success(`Welcome, ${sName.trim()}!`);
    goNext("/");
  };

  const submitAdmin = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    const session = loginAdmin(aEmail, aPassword);
    setSubmitting(false);
    if (!session) {
      toast.error("Invalid admin credentials");
      return;
    }
    toast.success("Signed in as admin");
    goNext("/admin");
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
          <h1 className="text-2xl font-semibold tracking-tight">Sign in to PaperVault</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Students can browse and give feedback. Admins can upload papers.
          </p>

          <div className="mt-6 inline-flex w-full rounded-full border border-border bg-muted p-1 text-xs font-medium">
            <button
              type="button"
              onClick={() => setTab("student")}
              className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-full px-3 py-2 transition ${
                tab === "student" ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <GraduationCap className="h-3.5 w-3.5" /> Student
            </button>
            <button
              type="button"
              onClick={() => setTab("admin")}
              className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-full px-3 py-2 transition ${
                tab === "admin" ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <ShieldCheck className="h-3.5 w-3.5" /> Admin
            </button>
          </div>

          {tab === "student" ? (
            <form onSubmit={submitStudent} className="mt-6 space-y-4">
              <Field label="Name">
                <input
                  value={sName}
                  onChange={(e) => setSName(e.target.value)}
                  placeholder="Your name"
                  required
                  className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                />
              </Field>
              <Field label="Email (optional)">
                <input
                  type="email"
                  value={sEmail}
                  onChange={(e) => setSEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                />
              </Field>
              <button
                type="submit"
                className="w-full rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition hover:opacity-90"
              >
                Continue as student
              </button>
            </form>
          ) : (
            <form onSubmit={submitAdmin} className="mt-6 space-y-4">
              <Field label="Admin email">
                <input
                  value={aEmail}
                  onChange={(e) => setAEmail(e.target.value)}
                  placeholder="admin email"
                  autoComplete="username"
                  required
                  className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                />
              </Field>
              <Field label="Password">
                <input
                  type="password"
                  value={aPassword}
                  onChange={(e) => setAPassword(e.target.value)}
                  placeholder="Password"
                  autoComplete="current-password"
                  required
                  className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                />
              </Field>
              <button
                type="submit"
                disabled={submitting}
                className="w-full rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
              >
                Sign in as admin
              </button>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-xs">
      <span className="font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
