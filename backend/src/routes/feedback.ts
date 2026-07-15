import { Router, type Request, type Response } from "express";
import { getSupabaseAdmin, supabase } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/admin.js";
import type { AuthenticatedRequest } from "../types.js";

const router = Router();

/**
 * POST /api/feedback
 * Public — submit feedback (anyone can submit)
 * Body: { message, category?, name?, email?, user_id? }
 */
router.post("/", async (req: Request, res: Response): Promise<void> => {
  try {
    const { message, category, name, email, user_id } = req.body;

    if (!message || typeof message !== "string" || !message.trim()) {
      res.status(400).json({ error: "Message is required" });
      return;
    }

    const validCategories = ["bug", "missing_paper", "ui_issue", "other"];
    const cat = validCategories.includes(category) ? category : "other";

    const { data, error } = await supabase.from("feedbacks").insert({
      message: message.trim(),
      category: cat,
      name: name?.trim() || null,
      email: email?.trim() || null,
      user_id: user_id || null,
    }).select().single();

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.status(201).json(data);
  } catch (err) {
    console.error("Submit feedback error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/feedback
 * Admin only — list all feedback
 */
router.get(
  "/",
  requireAuth,
  requireAdmin,
  async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const supabaseAdmin = getSupabaseAdmin();
      const { data, error } = await supabaseAdmin
        .from("feedbacks")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      res.json(data ?? []);
    } catch (err) {
      console.error("Fetch feedback error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

/**
 * DELETE /api/feedback/:id
 * Admin only — delete a feedback entry
 */
router.delete(
  "/:id",
  requireAuth,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const id = req.params.id as string;

      const supabaseAdmin = getSupabaseAdmin();
      const { error } = await supabaseAdmin
        .from("feedbacks")
        .delete()
        .eq("id", id);

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      res.json({ success: true });
    } catch (err) {
      console.error("Delete feedback error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

export default router;
