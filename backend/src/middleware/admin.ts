import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types.js";

/**
 * Express middleware: requires the authenticated user to have the "admin" role.
 * Must be used AFTER requireAuth middleware.
 */
export function requireAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized: Authentication required" });
    return;
  }

  if (req.user.role !== "admin") {
    res.status(403).json({ error: "Forbidden: Admin access required" });
    return;
  }

  next();
}
