// Real Supabase-backed auth for PaperVault.
// Roles are stored in the DB `user_roles` table and read via a Supabase query.
import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

export type Role = "guest" | "student" | "admin";

export interface Session {
  ready: boolean;
  role: Role;
  user: User | null;
  name: string;
  email: string;
}

const empty: Session = { ready: false, role: "guest", user: null, name: "", email: "" };

async function loadRole(userId: string): Promise<Role> {
  const { data } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  if (data?.some((r) => r.role === "admin")) return "admin";
  if (data && data.length > 0) return "student";
  return "student";
}

function displayName(user: User): string {
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const name = typeof meta.name === "string" ? meta.name : "";
  if (name.trim()) return name.trim();
  return (user.email ?? "").split("@")[0] || "User";
}

export function useSession(): Session {
  const [session, setSession] = useState<Session>(empty);

  useEffect(() => {
    let cancelled = false;

    const hydrate = async (user: User | null) => {
      if (!user) {
        if (!cancelled) setSession({ ready: true, role: "guest", user: null, name: "", email: "" });
        return;
      }
      const role = await loadRole(user.id);
      if (cancelled) return;
      setSession({
        ready: true,
        role,
        user,
        name: displayName(user),
        email: user.email ?? "",
      });
    };

    supabase.auth.getUser().then(({ data }) => hydrate(data.user));

    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "USER_UPDATED" || event === "INITIAL_SESSION") {
        hydrate(s?.user ?? null);
      }
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  return session;
}

export async function signOut() {
  await supabase.auth.signOut();
}
