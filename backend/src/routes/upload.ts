import { Router, type Response } from "express";
import multer from "multer";
import { getSupabaseAdmin } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/admin.js";
import type { AuthenticatedRequest } from "../types.js";

const router = Router();

const STORAGE_BUCKET = "papers";

// Configure multer for memory storage (we'll forward to Supabase)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024, // 20MB max
  },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are allowed"));
    }
  },
});

/**
 * POST /api/upload
 * Admin only — upload a PDF file to Supabase storage
 * Returns the storage path (not a signed URL)
 */
router.post(
  "/",
  requireAuth,
  requireAdmin,
  upload.single("file"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: "No file provided" });
        return;
      }

      const path = `papers/${Date.now()}-${crypto.randomUUID()}.pdf`;

      const supabaseAdmin = getSupabaseAdmin();
      const { error } = await supabaseAdmin.storage
        .from(STORAGE_BUCKET)
        .upload(path, file.buffer, {
          contentType: "application/pdf",
          upsert: false,
        });

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      res.json({ path });
    } catch (err) {
      console.error("Upload error:", err);
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(400).json({ error: "File too large (max 20MB)" });
          return;
        }
      }
      res.status(500).json({
        error: err instanceof Error ? err.message : "Internal server error",
      });
    }
  }
);

export default router;
