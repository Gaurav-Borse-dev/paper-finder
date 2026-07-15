import { Router, type Request, type Response } from "express";
import { supabase, getSupabaseForUser } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";
import type { AuthenticatedRequest } from "../types.js";

const router = Router();

/**
 * POST /api/auth/signup
 * Body: { email, password, name? }
 */
router.post("/signup", async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: "Email and password are required" });
      return;
    }

    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        data: name ? { name: name.trim() } : undefined,
      },
    });

    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }

    // Return the session tokens
    res.json({
      user: data.user
        ? {
            id: data.user.id,
            email: data.user.email,
            name:
              (data.user.user_metadata as Record<string, unknown>)?.name ||
              (data.user.email ?? "").split("@")[0],
          }
        : null,
      session: data.session
        ? {
            access_token: data.session.access_token,
            refresh_token: data.session.refresh_token,
            expires_at: data.session.expires_at,
          }
        : null,
    });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/auth/signin
 * Body: { email, password }
 */
router.post("/signin", async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: "Email and password are required" });
      return;
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (error || !data.user || !data.session) {
      res.status(401).json({ error: error?.message ?? "Invalid login credentials" });
      return;
    }

    // Fetch role using user-scoped client
    const userClient = getSupabaseForUser(data.session.access_token);
    const { data: roleData } = await userClient
      .from("user_roles")
      .select("role")
      .eq("user_id", data.user.id);

    const isAdmin = roleData?.some(
      (r: { role: string }) => r.role === "admin"
    );

    const meta = (data.user.user_metadata ?? {}) as Record<string, unknown>;
    const name =
      typeof meta.name === "string" && meta.name.trim()
        ? meta.name.trim()
        : (data.user.email ?? "").split("@")[0] || "User";

    res.json({
      user: {
        id: data.user.id,
        email: data.user.email,
        name,
        role: isAdmin ? "admin" : "student",
      },
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
      },
    });
  } catch (err) {
    console.error("Signin error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/auth/signout
 * Requires auth header
 */
router.post(
  "/signout",
  requireAuth,
  async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      // Server-side signout is a no-op for JWT — the client just discards the token.
      // But we can call supabase to invalidate the refresh token.
      res.json({ success: true });
    } catch (err) {
      console.error("Signout error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

/**
 * GET /api/auth/me
 * Returns the current user info + role
 */
router.get(
  "/me",
  requireAuth,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    res.json({ user: req.user });
  }
);

/**
 * POST /api/auth/refresh
 * Body: { refresh_token }
 */
router.post("/refresh", async (req: Request, res: Response): Promise<void> => {
  try {
    const { refresh_token } = req.body;

    if (!refresh_token) {
      res.status(400).json({ error: "Refresh token is required" });
      return;
    }

    const { data, error } = await supabase.auth.refreshSession({
      refresh_token,
    });

    if (error || !data.session) {
      res.status(401).json({ error: error?.message ?? "Failed to refresh session" });
      return;
    }

    res.json({
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
      },
    });
  } catch (err) {
    console.error("Refresh error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
