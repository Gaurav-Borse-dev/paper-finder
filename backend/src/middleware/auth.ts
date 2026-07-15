import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types.js";
import { supabase, getSupabaseForUser } from "../lib/supabase.js";

/**
 * Express middleware: verifies Supabase JWT from Authorization header.
 * On success, attaches `req.user` with { id, email, name, role }.
 */
export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized: No token provided" });
      return;
    }

    const token = authHeader.slice(7);
    if (!token || token.split(".").length !== 3) {
      res.status(401).json({ error: "Unauthorized: Invalid token format" });
      return;
    }

    // Verify the JWT by getting the user using public client
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);

    if (error || !user) {
      res.status(401).json({ error: "Unauthorized: Invalid or expired token" });
      return;
    }

    // Fetch user role using user-scoped client (satisfies users read own roles RLS policy)
    const userClient = getSupabaseForUser(token);
    const { data: roleData } = await userClient
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id);

    const isAdmin = roleData?.some(
      (r: { role: string }) => r.role === "admin"
    );
    const role = isAdmin ? "admin" : "student";

    const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
    const name =
      typeof meta.name === "string" && meta.name.trim()
        ? meta.name.trim()
        : (user.email ?? "").split("@")[0] || "User";

    req.user = {
      id: user.id,
      email: user.email ?? "",
      name,
      role,
    };

    next();
  } catch (err) {
    console.error("Auth middleware error:", err);
    res.status(500).json({ error: "Internal server error during authentication" });
  }
}

/**
 * Optional auth middleware: attaches user if token present, but doesn't fail if not.
 */
export async function optionalAuth(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    next();
    return;
  }

  try {
    const token = authHeader.slice(7);
    if (!token || token.split(".").length !== 3) {
      next();
      return;
    }

    // Verify the JWT by getting the user using public client
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);

    if (!error && user) {
      // Fetch user role using user-scoped client
      const userClient = getSupabaseForUser(token);
      const { data: roleData } = await userClient
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id);

      const isAdmin = roleData?.some(
        (r: { role: string }) => r.role === "admin"
      );

      const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
      const name =
        typeof meta.name === "string" && meta.name.trim()
          ? meta.name.trim()
          : (user.email ?? "").split("@")[0] || "User";

      req.user = {
        id: user.id,
        email: user.email ?? "",
        name,
        role: isAdmin ? "admin" : "student",
      };
    }
  } catch {
    // Ignore errors for optional auth — user just won't be attached
  }
  next();
}
