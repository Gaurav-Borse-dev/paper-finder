import { Router, type Response } from "express";
import { PDFParse } from "pdf-parse";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/admin.js";
import { supabase, getSupabaseAdmin } from "../lib/supabase.js";
import type { AuthenticatedRequest, ExtractionResult, ExtractionField } from "../types.js";
import { z } from "zod";

const router = Router();

export const SYSTEM_PROMPT = `You are an expert at extracting metadata from academic examination question papers (Indian engineering colleges, RCPIT format).
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
 * Admin only — Hybrid local + AI-powered PDF metadata extraction
 * Body: { pdfBase64: string, filename?: string }
 */
const extractSchema = z.object({
  pdfBase64: z.string().min(100, "Invalid PDF payload").trim(),
  filename: z.string().max(255).optional().nullable(),
}).strict();

router.post(
  "/",
  requireAuth,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const validation = extractSchema.safeParse(req.body);
      if (!validation.success) {
        res.status(400).json({ ok: false, error: validation.error.issues[0].message });
        return;
      }
      const { pdfBase64, filename } = validation.data;

      // Step 2: Local text extraction
      let localText = "";
      let localResult = EMPTY_RESULT;
      try {
        const pdfBuffer = Buffer.from(pdfBase64, "base64");
        const parser = new PDFParse({ data: pdfBuffer });
        const data = await parser.getText();
        await parser.destroy();
        localText = data.text || "";
        // Step 3: Heuristic extraction
        localResult = await localExtract(localText, filename || undefined);
      } catch (e) {
        console.error("Local text extraction / parsing failed:", e);
      }

      // Step 4: Confidence Check & Determine if AI is required
      const requiresAi = needsAi(localResult);

      if (!requiresAi) {
        // No AI call needed. Return local result directly.
        res.json({ ok: true, result: localResult, usedAi: false });
        return;
      }

      // Call AI (Conditional Fallback)
      const apiKey = process.env.LOVABLE_API_KEY;
      const geminiApiKey = process.env.GEMINI_API_KEY;

      if (!apiKey && !geminiApiKey) {
        // No AI configured, return local results with warning flag
        res.json({ 
          ok: true, 
          result: localResult, 
          usedAi: false, 
          aiUnavailable: true, 
          aiError: "AI service keys missing from environment (.env)" 
        });
        return;
      }

      let raw = "";
      let apiResult: ExtractionResult | null = null;
      let aiErrorMsg = "";

      try {
        const sendTextOnly = localText && localText.trim().length >= 200;
        const highConfFields = getHighConfFields(localResult);

        if (geminiApiKey) {
          const model = process.env.GEMINI_MODEL || "gemini-flash-latest";
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;

          const prompt = sendTextOnly
            ? `${SYSTEM_PROMPT}\n\nYou are given the text of a question paper and the already extracted high-confidence fields: ${JSON.stringify(highConfFields)}. Please extract the remaining fields. Do NOT change or overwrite any of the fields that are already supplied. Text:\n${localText}`
            : `${SYSTEM_PROMPT}\n\nHere are the already extracted high-confidence fields: ${JSON.stringify(highConfFields)}. Please extract the remaining fields from the attached PDF.`;

          const contents = sendTextOnly
            ? [
                {
                  role: "user",
                  parts: [{ text: prompt }],
                },
              ]
            : [
                {
                  role: "user",
                  parts: [
                    {
                      inlineData: {
                        mimeType: "application/pdf",
                        data: pdfBase64,
                      },
                    },
                    { text: prompt },
                  ],
                },
              ];

          const response = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              contents,
              generationConfig: {
                responseMimeType: "application/json",
              },
            }),
          });

          if (!response.ok) {
            const text = await response.text().catch(() => "");
            throw new Error(`Gemini API returned status ${response.status}: ${text.slice(0, 150)}`);
          }

          const body = (await response.json()) as {
            candidates?: Array<{
              content?: {
                parts?: Array<{ text?: string }>;
              };
            }>;
          };
          raw = body.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
          apiResult = parseExtraction(raw);
        } else {
          // Lovable API
          const response = await fetch(
            "https://ai.gateway.lovable.dev/v1/chat/completions",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Lovable-API-Key": apiKey!,
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
                        text: `Extract remaining fields. High confidence values: ${JSON.stringify(highConfFields)}`,
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
            throw new Error(`Lovable API returned status ${response.status}: ${text.slice(0, 150)}`);
          }

          const body = (await response.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          raw = body.choices?.[0]?.message?.content ?? "";
          apiResult = parseExtraction(raw);
        }
      } catch (err) {
        console.error("AI Extraction fallback failed:", err);
        aiErrorMsg = err instanceof Error ? err.message : "AI service unavailable";
      }

      // Merge results, never overwriting high confidence local fields
      let mergedResult = localResult;
      if (apiResult) {
        mergedResult = mergeResults(localResult, apiResult);
      }

      // If AI was required but failed, flag aiUnavailable: true
      if (requiresAi && !apiResult) {
        res.json({ 
          ok: true, 
          result: mergedResult, 
          usedAi: true, 
          aiUnavailable: true, 
          aiError: aiErrorMsg || "AI failed to respond" 
        });
        return;
      }

      res.json({ ok: true, result: mergedResult, usedAi: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Extraction failed";
      res.json({ ok: false, error: msg });
    }
  }
);

/**
 * Determine if AI fallback is required.
 * Returns true if any of the core fields are missing or have confidence < 60%.
 */
export function needsAi(r: ExtractionResult): boolean {
  const checkFields: Array<keyof ExtractionResult> = [
    "subject",
    "exam_type",
    "marks",
    "academic_year",
    "exam_date",
  ];
  return checkFields.some((f) => !r[f] || r[f].confidence < 0.60);
}

/**
 * Filter out fields with confidence >= 0.85 to pass to Gemini API.
 */
function getHighConfFields(r: ExtractionResult) {
  const out: Record<string, unknown> = {};
  (Object.keys(r) as Array<keyof ExtractionResult>).forEach((k) => {
    if (r[k] && r[k].confidence >= 0.85) {
      out[k] = r[k].value;
    }
  });
  return out;
}

/**
 * Merge local heuristic results and AI results.
 * Respects the constraint: Never overwrite fields that already have high confidence (>= 85%).
 */
export function mergeResults(local: ExtractionResult, api: ExtractionResult): ExtractionResult {
  const merged = { ...local };
  (Object.keys(local) as Array<keyof ExtractionResult>).forEach((k) => {
    const localField = local[k];
    const apiField = api[k];
    // Keep local if it has >= 85% confidence
    if (localField && localField.confidence >= 0.85) {
      return;
    }
    // Otherwise, overwrite with api result if api has non-null value or local is empty
    if (apiField && (apiField.value !== null || localField.value === null)) {
      merged[k] = apiField as any;
    }
  });
  return merged;
}

/**
 * localExtract performs regular expression matches and database checks on extracted plain text
 */
export async function localExtract(text: string, filename?: string): Promise<ExtractionResult> {
  const result: ExtractionResult = {
    subject: { value: null, confidence: 0 },
    subject_code: { value: null, confidence: 0 },
    department: { value: null, confidence: 0 },
    semester: { value: null, confidence: 0 },
    academic_year: { value: null, confidence: 0 },
    exam_type: { value: null, confidence: 0 },
    marks: { value: null, confidence: 0 },
    exam_date: { value: null, confidence: 0 },
    exam_month: { value: null, confidence: 0 },
    exam_year: { value: null, confidence: 0 },
  };

  const textToScan = text || "";
  const fnToScan = filename || "";
  const normalizedText = textToScan.replace(/\s+/g, " ");
  const normalizedFn = fnToScan.replace(/[\_\-]+/g, " ");

  // 1. Department matching
  try {
    const { data: depts } = await supabase.from("departments").select("name");
    if (depts && depts.length > 0) {
      let matchedDept = null;
      for (const d of depts) {
        const dName = d.name.toLowerCase().trim();
        if (textToScan.toLowerCase().includes(dName)) {
          matchedDept = d.name;
          result.department = { value: d.name, confidence: 0.95 };
          break;
        }
      }

      const deptAbbrs: Record<string, string[]> = {
        "Computer Engineering": ["cse", "computer engineering", "comp eng", "comp. eng."],
        "Information Technology": ["it", "information technology", "infotech"],
        "Mechanical Engineering": ["mech", "mechanical", "mechanical engineering", "mech eng", "mech. eng."],
        "Civil Engineering": ["civil", "civil engineering"],
        "Electrical Engineering": ["electrical", "electrical engineering"],
        "Electronics and Telecommunication": ["entc", "e&tc", "etc", "et&c", "electronics", "telecommunication"],
        "Artificial Intelligence and Machine Learning": ["aiml", "ai & ml", "ai/ml", "artificial intelligence"],
        "Data Science": ["aids", "data science"],
      };

      if (!matchedDept) {
        for (const d of depts) {
          const abbrs = deptAbbrs[d.name];
          if (abbrs) {
            for (const abbr of abbrs) {
              const regex = new RegExp(`\\b${abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, "i");
              if (regex.test(textToScan)) {
                matchedDept = d.name;
                result.department = { value: d.name, confidence: 0.85 };
                break;
              }
            }
          }
          if (matchedDept) break;
        }
      }

      if (!matchedDept && fnToScan) {
        for (const d of depts) {
          const dName = d.name.toLowerCase().trim();
          if (fnToScan.toLowerCase().includes(dName)) {
            matchedDept = d.name;
            result.department = { value: d.name, confidence: 0.90 };
            break;
          }
        }
        if (!matchedDept) {
          for (const d of depts) {
            const abbrs = deptAbbrs[d.name];
            if (abbrs) {
              for (const abbr of abbrs) {
                const regex = new RegExp(`\\b${abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, "i");
                if (regex.test(normalizedFn)) {
                  matchedDept = d.name;
                  result.department = { value: d.name, confidence: 0.85 };
                  break;
                }
              }
            }
            if (matchedDept) break;
          }
        }
      }
    }
  } catch (e) {
    console.error("Local dept query failed:", e);
  }

  // 2. Semester matching
  const semNumRegex = /\b(?:semester|sem)\s*[:\-]?\s*([1-8])\b/i;
  const semRomanRegex = /\b(?:semester|sem)\s*[:\-]?\s*([I|II|III|IV|V|VI|VII|VIII]+)\b/i;
  const romanMap: Record<string, number> = {
    I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8
  };

  let semVal = null;
  let semConf = 0;

  const semNumMatch = normalizedText.match(semNumRegex);
  if (semNumMatch) {
    semVal = parseInt(semNumMatch[1], 10);
    semConf = 0.90;
  } else {
    const semRomanMatch = normalizedText.match(semRomanRegex);
    if (semRomanMatch) {
      const romanVal = semRomanMatch[1].toUpperCase();
      if (romanMap[romanVal]) {
        semVal = romanMap[romanVal];
        semConf = 0.90;
      }
    }
  }

  if (!semVal && fnToScan) {
    const semNumMatchFn = normalizedFn.match(semNumRegex);
    if (semNumMatchFn) {
      semVal = parseInt(semNumMatchFn[1], 10);
      semConf = 0.85;
    } else {
      const semRomanMatchFn = normalizedFn.match(semRomanRegex);
      if (semRomanMatchFn) {
        const romanVal = semRomanMatchFn[1].toUpperCase();
        if (romanMap[romanVal]) {
          semVal = romanMap[romanVal];
          semConf = 0.85;
        }
      }
    }
  }

  if (semVal) {
    result.semester = { value: semVal, confidence: semConf };
  }

  // 3. Academic Year matching
  const yearRegex = /\b(20\d{2})\s*-\s*(20)?(\d{2})\b/;
  let startYear = "";
  let endYear = "";
  let yearConf = 0;

  const yearMatch = normalizedText.match(yearRegex);
  if (yearMatch) {
    startYear = yearMatch[1];
    endYear = yearMatch[3];
    yearConf = 0.90;
  } else if (fnToScan) {
    const yearMatchFn = normalizedFn.match(yearRegex);
    if (yearMatchFn) {
      startYear = yearMatchFn[1];
      endYear = yearMatchFn[3];
      yearConf = 0.85;
    }
  }

  if (startYear && endYear) {
    result.academic_year = { value: `${startYear}-${endYear}`, confidence: yearConf };
  }

  // 4. Exam Type matching
  const examTypePatterns = [
    { type: "RE-ESE" as const, regex: /\b(?:re\s*-\s*ese|re\s*ese|re\s*-\s*exam|re\s*exam|\\bre\\b)\b/i },
    { type: "ESE" as const, regex: /\b(?:ese|end\s*semester|regular\s*end\s*semester|regular\s*ese)\b/i },
    { type: "Supplementary" as const, regex: /\b(?:supplementary|supp)\b/i },
    { type: "Complementary" as const, regex: /\b(?:complementary|comp)\b/i }
  ];

  let matchedExamType = null;
  let examTypeConf = 0;

  for (const et of examTypePatterns) {
    if (et.regex.test(normalizedText)) {
      matchedExamType = et.type;
      examTypeConf = 0.90;
      break;
    }
  }

  if (!matchedExamType && fnToScan) {
    for (const et of examTypePatterns) {
      if (et.regex.test(normalizedFn)) {
        matchedExamType = et.type;
        examTypeConf = 0.85;
        break;
      }
    }
  }

  if (matchedExamType) {
    result.exam_type = { value: matchedExamType, confidence: examTypeConf };
  }

  // 5. Marks matching (e.g. Max Marks : 75)
  const marksRegex = /\b(?:max\w*\s+marks|maximum\s+marks|marks)\s*[:\-]?\s*(\d{2,3})\b/i;
  let marksVal = null;
  let marksConf = 0;

  const marksMatch = normalizedText.match(marksRegex);
  if (marksMatch) {
    marksVal = parseInt(marksMatch[1], 10);
    marksConf = 0.90;
  } else if (fnToScan) {
    const fnMarksMatch = normalizedFn.match(/\b(50|60|70|75|80|100)\b/);
    if (fnMarksMatch) {
      marksVal = parseInt(fnMarksMatch[1], 10);
      marksConf = 0.80;
    }
  }

  if (marksVal) {
    result.marks = { value: marksVal, confidence: marksConf };
  }

  // 6. Exam Date / Month / Year matching
  const monthMap: Record<string, string> = {
    january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
    july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
    jan: "01", feb: "02", mar: "03", apr: "04", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12"
  };

  const dateRegexA = /\b(0?[1-9]|[12]\d|3[01])[\/\-\.](0?[1-9]|1[0-2])[\/\-\.](20\d{2})\b/;
  const dateRegexB = /\b(0?[1-9]|[12]\d|3[01])\s+([A-Za-z]+)\s+(20\d{2})\b/;
  const dateRegexC = /\b([A-Za-z]+)\s+(0?[1-9]|[12]\d|3[01]),?\s+(20\d{2})\b/;

  let matchedDateStr = "";
  let matchedMonth = "";
  let matchedYearVal: number | null = null;
  let dateConf = 0;

  const matchA = normalizedText.match(dateRegexA);
  if (matchA) {
    const day = matchA[1].padStart(2, "0");
    const month = matchA[2].padStart(2, "0");
    const year = matchA[3];
    matchedDateStr = `${year}-${month}-${day}`;
    matchedYearVal = parseInt(year, 10);
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    matchedMonth = months[parseInt(month, 10) - 1];
    dateConf = 0.90;
  } else {
    const matchB = normalizedText.match(dateRegexB);
    if (matchB) {
      const day = matchB[1].padStart(2, "0");
      const monthName = matchB[2].toLowerCase();
      const year = matchB[3];
      const monthCode = monthMap[monthName];
      if (monthCode) {
        matchedDateStr = `${year}-${monthCode}-${day}`;
        matchedYearVal = parseInt(year, 10);
        matchedMonth = matchB[2].charAt(0).toUpperCase() + matchB[2].slice(1);
        dateConf = 0.90;
      }
    } else {
      const matchC = normalizedText.match(dateRegexC);
      if (matchC) {
        const day = matchC[2].padStart(2, "0");
        const monthName = matchC[1].toLowerCase();
        const year = matchC[3];
        const monthCode = monthMap[monthName];
        if (monthCode) {
          matchedDateStr = `${year}-${monthCode}-${day}`;
          matchedYearVal = parseInt(year, 10);
          matchedMonth = matchC[1].charAt(0).toUpperCase() + matchC[1].slice(1);
          dateConf = 0.90;
        }
      }
    }
  }

  if (!matchedDateStr && fnToScan) {
    const matchFnA = normalizedFn.match(dateRegexA);
    if (matchFnA) {
      const day = matchFnA[1].padStart(2, "0");
      const month = matchFnA[2].padStart(2, "0");
      const year = matchFnA[3];
      matchedDateStr = `${year}-${month}-${day}`;
      matchedYearVal = parseInt(year, 10);
      const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      matchedMonth = months[parseInt(month, 10) - 1];
      dateConf = 0.85;
    } else {
      const matchFnB = normalizedFn.match(dateRegexB);
      if (matchFnB) {
        const day = matchFnB[1].padStart(2, "0");
        const monthName = matchFnB[2].toLowerCase();
        const year = matchFnB[3];
        const monthCode = monthMap[monthName];
        if (monthCode) {
          matchedDateStr = `${year}-${monthCode}-${day}`;
          matchedYearVal = parseInt(year, 10);
          matchedMonth = matchFnB[2].charAt(0).toUpperCase() + matchFnB[2].slice(1);
          dateConf = 0.85;
        }
      }
    }
  }

  if (matchedDateStr) {
    result.exam_date = { value: matchedDateStr, confidence: dateConf };
    if (matchedMonth) {
      result.exam_month = { value: matchedMonth, confidence: dateConf };
    }
    if (matchedYearVal) {
      result.exam_year = { value: matchedYearVal, confidence: dateConf };
    }
  } else {
    const monthYearRegex = /\b([A-Za-z]+)\s+(20\d{2})\b/;
    const myMatch = normalizedText.match(monthYearRegex);
    if (myMatch) {
      const monthName = myMatch[1].toLowerCase();
      const monthCode = monthMap[monthName];
      if (monthCode) {
        const fullMonth = myMatch[1].charAt(0).toUpperCase() + myMatch[1].slice(1);
        result.exam_month = { value: fullMonth, confidence: 0.85 };
        result.exam_year = { value: parseInt(myMatch[2], 10), confidence: 0.85 };
      }
    } else if (fnToScan) {
      const myMatchFn = normalizedFn.match(monthYearRegex);
      if (myMatchFn) {
        const monthName = myMatchFn[1].toLowerCase();
        const monthCode = monthMap[monthName];
        if (monthCode) {
          const fullMonth = myMatchFn[1].charAt(0).toUpperCase() + myMatchFn[1].slice(1);
          result.exam_month = { value: fullMonth, confidence: 0.80 };
          result.exam_year = { value: parseInt(myMatchFn[2], 10), confidence: 0.80 };
        }
      }
    }
  }

  // 7. Subject Code matching
  const codeRegexExplicit = /(?:subject|course)\s+code\s*[:\-]?\s*\b([A-Z0-9\-]+)\b/i;
  const genericCodeRegex = /\b([A-Z]{2,4}\s*\d{3,4}[A-Z]?)\b/;
  let codeVal = null;
  let codeConf = 0;

  const explicitMatch = normalizedText.match(codeRegexExplicit);
  if (explicitMatch) {
    codeVal = explicitMatch[1].toUpperCase();
    codeConf = 0.90;
  } else {
    const genericMatch = normalizedText.match(genericCodeRegex);
    if (genericMatch) {
      codeVal = genericMatch[1].replace(/\s+/g, "").toUpperCase();
      codeConf = 0.80;
    }
  }

  if (!codeVal && fnToScan) {
    const explicitMatchFn = normalizedFn.match(codeRegexExplicit);
    if (explicitMatchFn) {
      codeVal = explicitMatchFn[1].toUpperCase();
      codeConf = 0.85;
    } else {
      const genericMatchFn = normalizedFn.match(genericCodeRegex);
      if (genericMatchFn) {
        codeVal = genericMatchFn[1].replace(/\s+/g, "").toUpperCase();
        codeConf = 0.80;
      }
    }
  }

  if (codeVal) {
    result.subject_code = { value: codeVal, confidence: codeConf };
  }

  // 8. Subject Name matching
  try {
    const { data: subjects } = await supabase.from("subjects").select("name");
    if (subjects && subjects.length > 0) {
      let matchedSubject = null;
      for (const s of subjects) {
        const sName = s.name.toLowerCase().trim();
        if (textToScan.toLowerCase().includes(sName)) {
          matchedSubject = s.name;
          result.subject = { value: s.name, confidence: 0.95 };
          break;
        }
      }

      if (!matchedSubject && fnToScan) {
        for (const s of subjects) {
          const sName = s.name.toLowerCase().trim();
          if (fnToScan.toLowerCase().includes(sName)) {
            matchedSubject = s.name;
            result.subject = { value: s.name, confidence: 0.90 };
            break;
          }
        }
      }

      if (!matchedSubject) {
        const subRegex = /(?:subject|course|paper)(?:\s*(?:name|title))?\s*[:\-]\s*([a-zA-Z\s\-\&]{3,50})/i;
        const subMatch = normalizedText.match(subRegex);
        if (subMatch) {
          const cleanedSub = subMatch[1]
            .replace(/\s+/g, " ")
            .trim()
            .split(" ")
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
            .join(" ");
          matchedSubject = cleanedSub;
          result.subject = { value: cleanedSub, confidence: 0.75 };
        }
      }

      if (!matchedSubject && fnToScan) {
        let cleanName = normalizedFn
          .replace(/\.pdf$/i, "")
          .replace(genericCodeRegex, "")
          .replace(semNumRegex, "")
          .replace(semRomanRegex, "")
          .replace(yearRegex, "")
          .replace(/\b(?:re\s*-\s*ese|re\s*ese|ese|supp|comp|supplementary|complementary|subqp|qp)\b/ig, "")
          .replace(/\b(?:etc|cse|it|mech|civil|electrical|aiml|aids)\b/ig, "")
          .replace(/\b(?:odd|even|sem|semester|sybtech|fybtech|tybtech|btech)\b/ig, "")
          .replace(/\b\d{1,2}\s+[A-Za-z]+\s+20\d{2}\b/ig, "")
          .replace(/\s+/g, " ")
          .trim();

        if (cleanName.length >= 3 && cleanName.length <= 50) {
          const titleCaseName = cleanName
            .split(" ")
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
            .join(" ");
          result.subject = { value: titleCaseName, confidence: 0.70 };
        }
      }
    }
  } catch (e) {
    console.error("Local subject query failed:", e);
  }

  return result;
}

export function parseExtraction(raw: string): ExtractionResult | null {
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
