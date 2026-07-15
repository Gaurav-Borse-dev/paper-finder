import { Router, type Request, type Response } from "express";
import { getSupabaseAdmin, supabase } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/admin.js";
import type { AuthenticatedRequest, LookupTable } from "../types.js";

const router = Router();

const ALLOWED_TABLES: LookupTable[] = [
  "departments",
  "exam_types",
  "academic_years",
  "subjects",
];

const COLUMN_MAP: Record<LookupTable, string> = {
  departments: "name",
  exam_types: "name",
  academic_years: "label",
  subjects: "name",
};

function isValidTable(table: string): table is LookupTable {
  return ALLOWED_TABLES.includes(table as LookupTable);
}

/**
 * GET /api/lookups/:table
 * Public — get all entries from a lookup table
 */
router.get("/:table", async (req: Request, res: Response): Promise<void> => {
  try {
    const table = req.params.table as string;

    if (!isValidTable(table)) {
      res.status(400).json({ error: `Invalid lookup table: ${table}` });
      return;
    }

    const { data, error } = await supabase
      .from(table)
      .select("*")
      .order("created_at", { ascending: true });

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json(data ?? []);
  } catch (err) {
    console.error("Fetch lookup error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/lookups/:table
 * Admin only — add a new entry to a lookup table
 * Body: { value: string }
 */
router.post(
  "/:table",
  requireAuth,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const table = req.params.table as string;
      const { value } = req.body;

      if (!isValidTable(table)) {
        res.status(400).json({ error: `Invalid lookup table: ${table}` });
        return;
      }

      if (!value || typeof value !== "string" || !value.trim()) {
        res.status(400).json({ error: "Value is required" });
        return;
      }

      const column = COLUMN_MAP[table];
      const supabaseAdmin = getSupabaseAdmin();
      const { data, error } = await supabaseAdmin
        .from(table)
        .insert({ [column]: value.trim() } as Record<string, string>)
        .select()
        .single();

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      res.status(201).json(data);
    } catch (err) {
      console.error("Add lookup error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

/**
 * DELETE /api/lookups/:table/:id
 * Admin only — delete an entry from a lookup table
 */
router.delete(
  "/:table/:id",
  requireAuth,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const table = req.params.table as string;
      const id = req.params.id as string;

      if (!isValidTable(table)) {
        res.status(400).json({ error: `Invalid lookup table: ${table}` });
        return;
      }

      const supabaseAdmin = getSupabaseAdmin();
      const { error } = await supabaseAdmin.from(table).delete().eq("id", id);

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      res.json({ success: true });
    } catch (err) {
      console.error("Delete lookup error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

export default router;
