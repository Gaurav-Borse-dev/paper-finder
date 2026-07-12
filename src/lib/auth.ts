// Lightweight client-side auth for PaperVault.
// The site has no per-user data — we only need to distinguish between
// three roles for UI gating: guest, student, admin.
// The admin credential is fixed by product spec (student project).
import { useEffect, useState } from "react";

export type Role = "guest" | "student" | "admin";
export interface Session {
  role: Role;
  name: string;
  email: string;
}

const STORAGE_KEY = "papervault.session";
const ADMIN_EMAIL = "admin@gaurav";
const ADMIN_PASSWORD = "gaurav12";

function read(): Session {
  if (typeof window === "undefined") return { role: "guest", name: "", email: "" };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { role: "guest", name: "", email: "" };
    const parsed = JSON.parse(raw) as Session;
    if (parsed && (parsed.role === "student" || parsed.role === "admin")) return parsed;
  } catch {
    /* ignore */
  }
  return { role: "guest", name: "", email: "" };
}

function write(session: Session) {
  if (typeof window === "undefined") return;
  if (session.role === "guest") window.localStorage.removeItem(STORAGE_KEY);
  else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  window.dispatchEvent(new Event("papervault:auth"));
}

export function loginStudent(name: string, email: string): Session {
  const s: Session = { role: "student", name: name.trim() || "Student", email: email.trim() };
  write(s);
  return s;
}

export function loginAdmin(email: string, password: string): Session | null {
  if (email.trim().toLowerCase() !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) return null;
  const s: Session = { role: "admin", name: "Admin", email: ADMIN_EMAIL };
  write(s);
  return s;
}

export function logout() {
  write({ role: "guest", name: "", email: "" });
}

export function useSession(): Session {
  const [session, setSession] = useState<Session>(() => ({ role: "guest", name: "", email: "" }));
  useEffect(() => {
    setSession(read());
    const sync = () => setSession(read());
    window.addEventListener("papervault:auth", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("papervault:auth", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return session;
}
