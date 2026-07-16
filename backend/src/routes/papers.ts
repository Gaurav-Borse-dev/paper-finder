import { Router, type Request, type Response } from "express";
import { getSupabaseAdmin, supabase } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/admin.js";
import type { AuthenticatedRequest } from "../types.js";
import { z } from "zod";

const router = Router();

const STORAGE_BUCKET = "papers";

const uuidSchema = z.string().uuid("Invalid ID format");

const createPaperSchema = z.object({
  subject: z.string().min(1).max(200),
  subject_code: z.string().max(20).optional().nullable(),
  department: z.string().min(1).max(100),
  semester: z.coerce.number().int().min(1).max(8),
  academic_year: z.string().regex(/^\d{4}-\d{2}$/, "Must be YYYY-YY format"),
  exam_type: z.string().min(1).max(50),
  marks: z.coerce.number().int().min(0).max(200),
  exam_date: z.string().optional().nullable(),
  description: z.string().max(1000).optional().nullable(),
  question_paper_source: z.enum(["upload", "gdrive"]),
  question_paper_url: z.string().min(1).max(2000),
  answer_key_source: z.enum(["upload", "gdrive"]).optional().nullable(),
  answer_key_url: z.string().max(2000).optional().nullable(),
  extraction_confidence: z.record(z.string(), z.unknown()).optional().nullable(),
}).strict();

/**
 * GET /api/papers
 * Public — list all papers, ordered by created_at desc
 */
router.get("/", async (_req: Request, res: Response): Promise<void> => {
  try {
    const { data, error } = await supabase
      .from("papers")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json(data ?? []);
  } catch (err) {
    console.error("Fetch papers error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/papers/:id
 * Public — get a single paper by ID
 */
router.get("/:id", async (req: Request, res: Response): Promise<void> => {
  try {
    const idResult = uuidSchema.safeParse(req.params.id);
    if (!idResult.success) {
      res.status(400).json({ error: "Invalid paper ID format" });
      return;
    }
    const id = idResult.data;
    const { data, error } = await supabase
      .from("papers")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    if (!data) {
      res.status(404).json({ error: "Paper not found" });
      return;
    }

    res.json(data);
  } catch (err) {
    console.error("Fetch paper error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/papers/:id/file-url
 * Public — generate a signed URL for viewing a paper's PDF
 * Query: ?type=question|answer
 */
router.get(
  "/:id/file-url",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const idResult = uuidSchema.safeParse(req.params.id);
      if (!idResult.success) {
        res.status(400).json({ error: "Invalid paper ID format" });
        return;
      }
      const id = idResult.data;
      const fileType = (req.query.type as string) === "answer" ? "answer" : "question";

      const { data: paper, error } = await supabase
        .from("papers")
        .select("*")
        .eq("id", id)
        .maybeSingle();

      if (error || !paper) {
        res.status(404).json({ error: "Paper not found" });
        return;
      }

      const source =
        fileType === "answer"
          ? paper.answer_key_source
          : paper.question_paper_source;
      const urlOrPath =
        fileType === "answer"
          ? paper.answer_key_url
          : paper.question_paper_url;

      if (!source || !urlOrPath) {
        res.status(404).json({ error: "File not available" });
        return;
      }

      // For Google Drive files, return the raw URL
      if (source === "gdrive") {
        res.json({ url: urlOrPath, source: "gdrive" });
        return;
      }

      // For uploads, create a signed URL from Supabase storage
      const supabaseAdmin = getSupabaseAdmin();
      const { data: signedData, error: signError } = await supabaseAdmin.storage
        .from(STORAGE_BUCKET)
        .createSignedUrl(urlOrPath, 60 * 60); // 1 hour

      if (signError || !signedData?.signedUrl) {
        res.status(500).json({ error: "Failed to create signed URL" });
        return;
      }

      res.json({ url: signedData.signedUrl, source: "upload" });
    } catch (err) {
      console.error("File URL error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

/**
 * POST /api/papers
 * Admin only — create a new paper
 */
router.post(
  "/",
  requireAuth,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const validation = createPaperSchema.safeParse(req.body);
      if (!validation.success) {
        res.status(400).json({ error: validation.error.issues[0].message });
        return;
      }
      const payload = validation.data;

      const supabaseAdmin = getSupabaseAdmin();
      const { data, error } = await supabaseAdmin.from("papers").insert({
        subject: payload.subject,
        subject_code: payload.subject_code || null,
        department: payload.department,
        semester: payload.semester,
        academic_year: payload.academic_year,
        exam_type: payload.exam_type,
        marks: payload.marks,
        exam_date: payload.exam_date || null,
        description: payload.description || null,
        question_paper_source: payload.question_paper_source,
        question_paper_url: payload.question_paper_url,
        answer_key_source: payload.answer_key_source || null,
        answer_key_url: payload.answer_key_url || null,
        extraction_confidence: payload.extraction_confidence || null,
      }).select().single();

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      res.status(201).json(data);
    } catch (err) {
      console.error("Create paper error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

/**
 * PUT /api/papers/:id
 * Admin only — update an existing paper
 */
router.put(
  "/:id",
  requireAuth,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const idResult = uuidSchema.safeParse(req.params.id);
      if (!idResult.success) {
        res.status(400).json({ error: "Invalid paper ID format" });
        return;
      }
      const id = idResult.data;
      const validation = createPaperSchema.partial().safeParse(req.body);
      if (!validation.success) {
        res.status(400).json({ error: validation.error.issues[0].message });
        return;
      }
      const payload = validation.data;

      const supabaseAdmin = getSupabaseAdmin();
      const { data, error } = await supabaseAdmin
        .from("papers")
        .update({
          subject: payload.subject,
          subject_code: payload.subject_code || null,
          department: payload.department,
          semester: payload.semester,
          academic_year: payload.academic_year,
          exam_type: payload.exam_type,
          marks: payload.marks,
          exam_date: payload.exam_date || null,
          description: payload.description || null,
          question_paper_source: payload.question_paper_source,
          question_paper_url: payload.question_paper_url,
          answer_key_source: payload.answer_key_source || null,
          answer_key_url: payload.answer_key_url || null,
          extraction_confidence: payload.extraction_confidence || null,
        })
        .eq("id", id)
        .select()
        .single();

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      res.json(data);
    } catch (err) {
      console.error("Update paper error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

/**
 * DELETE /api/papers/:id
 * Admin only — delete a paper and its storage files
 */
router.delete(
  "/:id",
  requireAuth,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const idResult = uuidSchema.safeParse(req.params.id);
      if (!idResult.success) {
        res.status(400).json({ error: "Invalid paper ID format" });
        return;
      }
      const id = idResult.data;

      const supabaseAdmin = getSupabaseAdmin();

      // Fetch the paper first to clean up storage
      const { data: paper } = await supabaseAdmin
        .from("papers")
        .select("*")
        .eq("id", id)
        .maybeSingle();

      if (!paper) {
        res.status(404).json({ error: "Paper not found" });
        return;
      }

      // Remove storage files
      const paths: string[] = [];
      if (paper.question_paper_source === "upload") {
        paths.push(paper.question_paper_url);
      }
      if (paper.answer_key_source === "upload" && paper.answer_key_url) {
        paths.push(paper.answer_key_url);
      }
      if (paths.length > 0) {
        await supabaseAdmin.storage.from(STORAGE_BUCKET).remove(paths);
      }

      // Delete the record
      const { error } = await supabaseAdmin
        .from("papers")
        .delete()
        .eq("id", id);

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      res.json({ success: true });
    } catch (err) {
      console.error("Delete paper error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

export default router;
