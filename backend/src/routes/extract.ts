import { Router, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/admin.js";
import type { AuthenticatedRequest, ExtractionResult, ExtractionField } from "../types.js";

const router = Router();

const SYSTEM_PROMPT = `You are an expert at extracting metadata from academic examination question papers (Indian engineering colleges, RCPIT format).
Extract these fields from the PDF. Return STRICT JSON only, no markdown, no explanation.

Normalize exam_type to one of: "ESE", "RE-ESE", "Supplementary", "Complementary".
- "End Semester Examination" / "Regular End Semester" / "Regular ESE" -> "ESE"
- "Re End Semester" / "Re-Examination" / "Re-ESE" -> "RE-ESE"
- "Supplementary" / "Supp" -> "Supplementary"
- "Complementary" -> "Complementary"

Normalize academic_year to "YYYY-YY" (e.g. "2024-25").
Normalize exam_date to ISO "YYYY-MM-DD". Set null if not found.
marks is the maximum marks integer (e.g. 60, 70, 75).
semester is 1..8 integer.
subject is the full readable subject name (Title Case).
subject_code is like "CS601" if present, else null.
exam_month is the full month name (e.g. "July"). exam_year is the 4-digit year.

For EVERY field, provide a confidence in [0,1]:
- 1.0 = exact literal match in the PDF
- 0.8+ = clearly identifiable
- 0.5 = inferred / partial
- 0.0 = not detected (value MUST be null)

Return exactly this JSON shape (no extra keys):
{
  "subject": {"value": string|null, "confidence": number},
  "subject_code": {"value": string|null, "confidence": number},
  "department": {"value": string|null, "confidence": number},
  "semester": {"value": integer|null, "confidence": number},
  "academic_year": {"value": string|null, "confidence": number},
  "exam_type": {"value": "ESE"|"RE-ESE"|"Supplementary"|"Complementary"|null, "confidence": number},
  "marks": {"value": integer|null, "confidence": number},
  "exam_date": {"value": string|null, "confidence": number},
  "exam_month": {"value": string|null, "confidence": number},
  "exam_year": {"value": integer|null, "confidence": number}
}`;

const EMPTY_FIELD = { value: null, confidence: 0 };
const EMPTY_RESULT: ExtractionResult = {
  subject: EMPTY_FIELD,
  subject_code: EMPTY_FIELD,
  department: EMPTY_FIELD,
  semester: EMPTY_FIELD,
  academic_year: EMPTY_FIELD,
  exam_type: EMPTY_FIELD,
  marks: EMPTY_FIELD,
  exam_date: EMPTY_FIELD,
  exam_month: EMPTY_FIELD,
  exam_year: EMPTY_FIELD,
} as ExtractionResult;

/**
 * POST /api/extract
 * Admin only — AI-powered PDF metadata extraction
 * Body: { pdfBase64: string, filename?: string }
 */
router.post(
  "/",
  requireAuth,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { pdfBase64, filename } = req.body;

      if (!pdfBase64 || typeof pdfBase64 !== "string" || pdfBase64.length < 100) {
        res.status(400).json({ ok: false, error: "Invalid PDF payload" });
        return;
      }

      const apiKey = process.env.LOVABLE_API_KEY;
      if (!apiKey) {
        res.status(500).json({ ok: false, error: "AI service not configured (LOVABLE_API_KEY missing)" });
        return;
      }

      const response = await fetch(
        "https://ai.gateway.lovable.dev/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Lovable-API-Key": apiKey,
          },
          body: JSON.stringify({
            model: "google/gemini-2.5-pro",
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: "Extract the metadata from this question paper PDF.",
                  },
                  {
                    type: "file",
                    file: {
                      filename: filename ?? "paper.pdf",
                      file_data: `data:application/pdf;base64,${pdfBase64}`,
                    },
                  },
                ],
              },
            ],
            response_format: { type: "json_object" },
          }),
        }
      );

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        if (response.status === 429) {
          res.json({ ok: false, error: "AI rate limit hit — please try again shortly." });
          return;
        }
        if (response.status === 402) {
          res.json({ ok: false, error: "AI credits exhausted. Add credits in workspace billing." });
          return;
        }
        res.json({ ok: false, error: `AI error (${response.status}): ${text.slice(0, 200)}` });
        return;
      }

      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const raw = body.choices?.[0]?.message?.content ?? "";
      const parsed = parseExtraction(raw);

      if (!parsed) {
        res.json({ ok: true, result: EMPTY_RESULT });
        return;
      }
      res.json({ ok: true, result: parsed });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Extraction failed";
      res.json({ ok: false, error: msg });
    }
  }
);

function parseExtraction(raw: string): ExtractionResult | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    const obj = JSON.parse(cleaned) as Record<string, unknown>;
    const field = <T>(
      key: string,
      coerce: (v: unknown) => T | null
    ): ExtractionField<T> => {
      const f = obj[key] as
        | { value?: unknown; confidence?: unknown }
        | undefined;
      if (!f || typeof f !== "object") return { value: null, confidence: 0 };
      const value = coerce(f.value);
      const conf =
        typeof f.confidence === "number"
          ? Math.max(0, Math.min(1, f.confidence))
          : 0;
      return { value, confidence: value === null ? 0 : conf };
    };
    const asString = (v: unknown) =>
      typeof v === "string" && v.trim() ? v.trim() : null;
    const asInt = (v: unknown) => {
      if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
      if (typeof v === "string" && /^\d+$/.test(v.trim()))
        return parseInt(v.trim(), 10);
      return null;
    };
    const asExamType = (v: unknown) => {
      const s = asString(v);
      if (!s) return null;
      const upper = s.toUpperCase();
      if (upper === "ESE" || upper === "RE-ESE")
        return upper as "ESE" | "RE-ESE";
      if (/^supp/i.test(s)) return "Supplementary" as const;
      if (/^comp/i.test(s)) return "Complementary" as const;
      return null;
    };
    return {
      subject: field("subject", asString),
      subject_code: field("subject_code", asString),
      department: field("department", asString),
      semester: field("semester", asInt),
      academic_year: field("academic_year", asString),
      exam_type: field("exam_type", asExamType),
      marks: field("marks", asInt),
      exam_date: field("exam_date", asString),
      exam_month: field("exam_month", asString),
      exam_year: field("exam_year", asInt),
    };
  } catch {
    return null;
  }
}

export default router;
