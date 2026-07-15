// Auth hook for PaperVault — uses the backend API instead of direct Supabase calls.
import { useEffect, useState, useCallback } from "react";
import {
  getMe,
  signOut as apiSignOut,
  type AuthUser,
  type Role,
} from "@/services/auth";
import { getToken } from "@/services/api";

export type { Role };

export interface Session {
  ready: boolean;
  role: Role;
  user: AuthUser | null;
  name: string;
  email: string;
}

const empty: Session = {
  ready: false,
  role: "guest",
  user: null,
  name: "",
  email: "",
};

export function useSession(): Session {
  const [session, setSession] = useState<Session>(empty);

  const hydrate = useCallback(async () => {
    const token = getToken();
    if (!token) {
      setSession({
        ready: true,
        role: "guest",
        user: null,
        name: "",
        email: "",
      });
      return;
    }

    try {
      const user = await getMe();
      if (user) {
        setSession({
          ready: true,
          role: user.role,
          user,
          name: user.name,
          email: user.email,
        });
      } else {
        setSession({
          ready: true,
          role: "guest",
          user: null,
          name: "",
          email: "",
        });
      }
    } catch {
      setSession({
        ready: true,
        role: "guest",
        user: null,
        name: "",
        email: "",
      });
    }
  }, []);

  useEffect(() => {
    hydrate();

    // Listen for storage changes (login/logout in other tabs)
    const onStorage = (e: StorageEvent) => {
      if (
        e.key === "papervault_access_token" ||
        e.key === "papervault_refresh_token"
      ) {
        hydrate();
      }
    };
    window.addEventListener("storage", onStorage);

    // Listen for custom auth events
    const onAuthChange = () => hydrate();
    window.addEventListener("papervault-auth-change", onAuthChange);

    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("papervault-auth-change", onAuthChange);
    };
  }, [hydrate]);

  return session;
}

/**
 * Dispatch auth change event to update all useSession hooks.
 */
export function notifyAuthChange(): void {
  window.dispatchEvent(new Event("papervault-auth-change"));
}

export async function signOut(): Promise<void> {
  await apiSignOut();
  notifyAuthChange();
}
