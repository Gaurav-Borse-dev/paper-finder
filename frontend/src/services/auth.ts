import { apiFetch, setTokens, clearTokens } from "./api";

export type Role = "guest" | "student" | "admin";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface AuthSession {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
}

interface AuthResponse {
  user: AuthUser | null;
  session: AuthSession | null;
}

/**
 * Sign up a new user.
 */
export async function signUp(
  email: string,
  password: string,
  name?: string
): Promise<AuthResponse> {
  const data = await apiFetch<AuthResponse>("/auth/signup", {
    method: "POST",
    body: { email, password, name },
  });
  if (data.session) {
    setTokens(data.session.access_token, data.session.refresh_token);
  }
  return data;
}

/**
 * Sign in with email and password.
 */
export async function signIn(
  email: string,
  password: string
): Promise<AuthResponse> {
  const data = await apiFetch<AuthResponse>("/auth/signin", {
    method: "POST",
    body: { email, password },
  });
  if (data.session) {
    setTokens(data.session.access_token, data.session.refresh_token);
  }
  return data;
}

/**
 * Sign out the current user.
 */
export async function signOut(): Promise<void> {
  try {
    await apiFetch("/auth/signout", { method: "POST" });
  } catch {
    // Ignore errors — just clear tokens
  }
  clearTokens();
}

/**
 * Get the current authenticated user.
 */
export async function getMe(): Promise<AuthUser | null> {
  try {
    const data = await apiFetch<{ user: AuthUser }>("/auth/me");
    return data.user;
  } catch {
    return null;
  }
}
