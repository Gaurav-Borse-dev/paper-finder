import { Router, type Request, type Response } from "express";
import { PDFParse } from "pdf-parse";
import { getSupabaseAdmin, supabase } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/admin.js";
import type { AuthenticatedRequest, ExtractionResult } from "../types.js";
import { localExtract, ocrViaTesseract, needsAi, runAiExtraction } from "./extract.js";
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

/**
 * POST /api/papers/auto-audit-fix
 * Admin only — Auto-audit and auto-fix all papers in the database using hybrid extraction
 * Body: { googleAccessToken?: string }
 */
router.post(
  "/auto-audit-fix",
  requireAuth,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const sendEvent = (type: string, payload: any) => {
      res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
    };

    try {
      const { googleAccessToken, force } = req.body || {};
      const supabaseAdmin = getSupabaseAdmin();

      // Establish Server-Sent Events (SSE) connection
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      const { data: papers, error: fetchErr } = await supabaseAdmin
        .from("papers")
        .select("*")
        .order("created_at", { ascending: false });

      if (fetchErr) {
        sendEvent("error", { message: fetchErr.message });
        res.end();
        return;
      }

      if (!papers || papers.length === 0) {
        sendEvent("done", { totalChecked: 0, fixedCount: 0, updatedPapers: [], restrictedLinks: [] });
        res.end();
        return;
      }

      let checkedCount = 0;
      let fixedCount = 0;
      const updatedPapers: Array<{ id: string; subject: string; changes: string[] }> = [];
      const restrictedLinks: Array<{ id: string; subject: string; url: string }> = [];

      // Concurrency Limit: 5 workers to prevent Google Drive IP throttling on cloud servers
      const concurrencyLimit = 5;
      const totalPapers = papers.length;

      const fetchWithTimeout = async (url: string, opts: RequestInit = {}, timeoutMs = 5000) => {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetch(url, { ...opts, signal: controller.signal });
          clearTimeout(id);
          return res;
        } catch (e) {
          clearTimeout(id);
          throw e;
        }
      };

      // Group papers into chunks of size `concurrencyLimit`
      for (let i = 0; i < totalPapers; i += concurrencyLimit) {
        const chunk = papers.slice(i, i + concurrencyLimit);
        await Promise.all(
          chunk.map(async (p) => {
            const isCorruptedSubject = p.subject && (p.subject.toLowerCase().includes("http") || p.subject.toLowerCase().includes("drive.google") || p.subject.toLowerCase().includes("/file/d/"));
            const isPerfect =
              !isCorruptedSubject &&
              p.subject && p.subject !== "Unknown Subject" &&
              p.department && p.department !== "Unknown" &&
              p.semester && p.marks && p.academic_year && p.exam_type &&
              p.extraction_confidence && typeof p.extraction_confidence === "object" &&
              (p.extraction_confidence as any).subject?.confidence >= 0.85;

            if (isPerfect && !force) {
              checkedCount++;
              sendEvent("progress", {
                checked: checkedCount,
                total: totalPapers,
                fixedCount,
                currentPaper: p.subject,
              });
              return;
            }

            let buffer: Buffer | null = null;
            let sourceName = p.question_paper_url && !p.question_paper_url.startsWith("http") ? p.question_paper_url : undefined;

            const isSupabase = p.question_paper_url && !p.question_paper_url.startsWith("http");
            const isGDrive = p.question_paper_url && p.question_paper_url.includes("drive.google.com");

            if (isSupabase) {
              try {
                const { data: fileData } = await supabaseAdmin.storage
                  .from("question-papers")
                  .download(p.question_paper_url);

                if (fileData) {
                  buffer = Buffer.from(await fileData.arrayBuffer());
                }
              } catch (e) {
                console.error(`Storage download failed for ${p.id}:`, e);
              }
            } else if (isGDrive) {
              const match = p.question_paper_url.match(/\/d\/([a-zA-Z0-9_-]+)/) || p.question_paper_url.match(/id=([a-zA-Z0-9_-]+)/);
              const fileId = match ? match[1] : p.question_paper_file_id;

              if (fileId) {
                if (googleAccessToken) {
                  try {
                    const gRes = await fetchWithTimeout(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
                      headers: { Authorization: `Bearer ${googleAccessToken}` },
                    }, 5000);
                    if (gRes.ok) {
                      const arr = await gRes.arrayBuffer();
                      buffer = Buffer.from(arr);
                    }
                  } catch (e) {
                    // API download failed or timed out
                  }
                }

                // 1. Try Google Direct CDN endpoint (fastest, rarely throttled)
                if (!buffer) {
                  try {
                    const cdnRes = await fetchWithTimeout(`https://lh3.googleusercontent.com/d/${fileId}`, {}, 5000);
                    if (cdnRes.ok) {
                      const arr = await cdnRes.arrayBuffer();
                      const b = Buffer.from(arr);
                      if (b.length > 500 && b.subarray(0, 4).toString() === "%PDF") {
                        buffer = b;
                      }
                    }
                  } catch (e) {
                    // CDN download failed or timed out
                  }
                }

                // 2. Try export=download endpoint fallback
                if (!buffer) {
                  try {
                    const dlRes = await fetchWithTimeout(`https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`, {}, 5000);
                    if (dlRes.ok) {
                      const arr = await dlRes.arrayBuffer();
                      const b = Buffer.from(arr);
                      if (b.length > 500 && (b.subarray(0, 4).toString() === "%PDF" || b.includes(Buffer.from("%PDF")))) {
                        buffer = b;
                      }
                    }
                  } catch (e) {
                    // Public download failed or timed out
                  }
                }
              }

              if (!buffer) {
                restrictedLinks.push({
                  id: p.id,
                  subject: p.subject,
                  url: p.question_paper_url,
                });
              }
            }

            let localText = "";
            let extracted: ExtractionResult | null = null;

            try {
              if (buffer && buffer.length > 500) {
                const parser = new PDFParse({ data: buffer });
                const textData = await parser.getText({ first: 2 });
                await parser.destroy();
                localText = textData.text || "";

                if (localText.trim().length < 100) {
                  const ocrText = await ocrViaTesseract(buffer);
                  if (ocrText && ocrText.trim().length >= 50) {
                    localText = ocrText;
                  }
                }
              }

              extracted = await localExtract(localText, sourceName);

              if (needsAi(extracted)) {
                extracted = await runAiExtraction(buffer, localText, extracted);
              }
            } catch (err) {
              console.error(`Extraction failed for paper ${p.id}:`, err);
            }

            if (extracted) {
              const updates: Record<string, any> = {};
              const changes: string[] = [];

              const isUrlLike = (val: any) => typeof val === "string" && (val.toLowerCase().includes("http") || val.toLowerCase().includes("drive.google") || val.toLowerCase().includes("/file/d/") || val.toLowerCase().includes(".com"));

              if (extracted.subject.value && extracted.subject.confidence >= 0.70 && extracted.subject.value !== p.subject && !isUrlLike(extracted.subject.value)) {
                updates.subject = extracted.subject.value;
                changes.push(`Subject: "${p.subject}" ➔ "${extracted.subject.value}"`);
              }
              if (extracted.department.value && extracted.department.confidence >= 0.70 && extracted.department.value !== p.department) {
                updates.department = extracted.department.value;
                changes.push(`Dept: "${p.department}" ➔ "${extracted.department.value}"`);
              }
              if (extracted.semester.value && extracted.semester.confidence >= 0.70 && extracted.semester.value !== p.semester) {
                updates.semester = extracted.semester.value;
                changes.push(`Sem: ${p.semester} ➔ ${extracted.semester.value}`);
              }
              if (extracted.academic_year.value && extracted.academic_year.confidence >= 0.70 && extracted.academic_year.value !== p.academic_year) {
                updates.academic_year = extracted.academic_year.value;
                changes.push(`Year: "${p.academic_year}" ➔ "${extracted.academic_year.value}"`);
              }
              if (extracted.marks.value && extracted.marks.confidence >= 0.70 && extracted.marks.value !== p.marks) {
                updates.marks = extracted.marks.value;
                changes.push(`Marks: ${p.marks} ➔ ${extracted.marks.value}`);
              }
              if (extracted.exam_type.value && extracted.exam_type.confidence >= 0.70 && extracted.exam_type.value !== p.exam_type) {
                updates.exam_type = extracted.exam_type.value;
                changes.push(`Type: "${p.exam_type}" ➔ "${extracted.exam_type.value}"`);
              }

              if (Object.keys(updates).length > 0) {
                const { error: updateErr } = await supabaseAdmin
                  .from("papers")
                  .update(updates)
                  .eq("id", p.id);

                if (!updateErr) {
                  fixedCount++;
                  const updateItem = {
                    id: p.id,
                    subject: updates.subject || p.subject,
                    changes,
                  };
                  updatedPapers.push(updateItem);
                  sendEvent("paper-fixed", { paper: updateItem });
                }
              }
            }

            checkedCount++;
            sendEvent("progress", {
              checked: checkedCount,
              total: totalPapers,
              fixedCount,
              currentPaper: p.subject,
            });
          })
        );
      }

      sendEvent("done", {
        totalChecked: totalPapers,
        fixedCount,
        updatedPapers,
        restrictedLinks,
      });
      res.end();
    } catch (err) {
      console.error("Auto audit & fix error:", err);
      sendEvent("error", { message: err instanceof Error ? err.message : "Auto audit failed" });
      res.end();
    }
  }
);

export default router;
