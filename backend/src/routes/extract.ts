import { Router, type Response } from "express";
import { PDFParse } from "pdf-parse";
import { createWorker } from "tesseract.js";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/admin.js";
import { supabase, getSupabaseAdmin } from "../lib/supabase.js";
import type { AuthenticatedRequest, ExtractionResult, ExtractionField } from "../types.js";
import { z } from "zod";

const router = Router();

export const SYSTEM_PROMPT = `You are an expert at extracting metadata from academic examination question papers (Indian engineering colleges, RCPIT format).
Extract these fields from the PDF. Return STRICT JSON only, no markdown, no explanation.

Normalize department (Branch) strictly to one of these exact values:
- "Computer Engineering"
- "Information Technology"
- "Mechanical Engineering"
- "Civil Engineering"
- "Electrical Engineering"
- "Electronics and Telecommunication"
- "Artificial Intelligence and Machine Learning"
- "Data Science"
IMPORTANT: Extract the department exactly as printed on the paper header. If the paper says "Department of Information Technology", set department to "Information Technology". If the paper says "FY B.Tech" or "FY ALL" without a specific branch, look for the branch in the filename or folder path provided; if none found, set department to null with confidence 0.

Normalize subject to the full readable subject name in Title Case, using standard conjunctions (e.g. "Data Structures and Algorithms", "Basic Electrical and Electronics Engineering"). Expand abbreviations to their full name if known (e.g., "DSA" -> "Data Structures and Algorithms", "DBMS" -> "Database Management Systems", "OOP" -> "Object Oriented Programming").

Normalize semester to an integer from 1 to 8. Look for explicit semester mentions: "Semester III" -> 3, "Sem-4" -> 4, "SEM VI" -> 6.
Also check for roman numerals (I->1, II->2, III->3, IV->4, V->5, VI->6, VII->7, VIII->8).
IMPORTANT: Only extract the semester if it is explicitly stated. Do NOT guess the semester from the year of study alone (FY/SY/TY/BE) unless an ODD/EVEN indicator is also present.

Normalize exam_type to one of: "ESE", "RE-ESE", "Supplementary", "Complementary".
- "End Semester Examination" / "Regular End Semester" / "Regular ESE" -> "ESE"
- "Re End Semester" / "Re-Examination" / "Re-ESE" -> "RE-ESE"
- "Supplementary" / "Supp" -> "Supplementary"
- "Complementary" -> "Complementary"

Normalize academic_year to "YYYY-YY" (e.g. "2024-25").
IMPORTANT: The academic_year is the year in which the exam was conducted, NOT the syllabus pattern year. Ignore lines like "Pattern 2019" or "Syllabus 2021". If you see an exam date or session (e.g. "Nov/Dec 2023", "Winter 2023", "May 2024", "Summer 2024"), derive the academic_year from the exam session:
- Exams in Jul-Dec of year YYYY -> academic_year "YYYY-(YY+1)" (e.g. Nov 2023 -> "2023-24")
- Exams in Jan-Jun of year YYYY -> academic_year "(YYYY-1)-YY" (e.g. May 2024 -> "2023-24")

Normalize exam_date to ISO "YYYY-MM-DD". Set null if not found.
marks is the TOTAL / MAXIMUM marks for the entire paper (e.g. 60, 70, 75, 80, 100). Do NOT extract sub-question marks (like "[10 Marks]", "5 marks", "Q1 carries 20 marks"). Only extract the total paper marks from the header.
subject_code is like "CS601" or "RCP23VCPC301" if present, else null.
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
  pdfBase64: z.string().min(10, "Invalid PDF payload").optional().nullable(),
  gdriveUrl: z.string().url("Invalid Google Drive URL").optional().nullable(),
  filename: z.string().max(255).optional().nullable(),
}).refine(data => data.pdfBase64 || data.gdriveUrl, {
  message: "Either pdfBase64 or gdriveUrl must be provided",
});

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
      const { pdfBase64: rawPdfBase64, gdriveUrl, filename: rawFilename } = validation.data;

      let pdfBase64 = rawPdfBase64 || "";
      let filename = rawFilename || "";
      let pdfBuffer: Buffer | null = null;
      let gdriveError = "";

      if (!pdfBase64 && gdriveUrl) {
        const match = gdriveUrl.match(/\/d\/([a-zA-Z0-9_-]+)/) || gdriveUrl.match(/id=([a-zA-Z0-9_-]+)/);
        const fileId = match ? match[1] : null;
        if (fileId) {
          try {
            const dlUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
            const dlRes = await fetch(dlUrl);
            if (dlRes.ok) {
              const arrayBuf = await dlRes.arrayBuffer();
              pdfBuffer = Buffer.from(arrayBuf);
              if (pdfBuffer.length > 500) {
                pdfBase64 = pdfBuffer.toString("base64");
              }
            } else {
              gdriveError = `Google Drive returned status ${dlRes.status} (Access restricted or requires authentication)`;
            }
          } catch (err: any) {
            gdriveError = err?.message || "Failed to download Google Drive link";
          }
        }
      } else if (pdfBase64) {
        pdfBuffer = Buffer.from(pdfBase64, "base64");
      }

      // Step 2: Local text extraction
      let localText = "";
      let localResult = EMPTY_RESULT;
      try {
        if (pdfBuffer && pdfBuffer.length > 500) {
          const parser = new PDFParse({ data: pdfBuffer });
          const data = await parser.getText({ first: 2 });
          await parser.destroy();
          localText = data.text || "";

          // Level 4 OCR fallback for scanned PDFs
          if (localText.trim().length < 100) {
            console.log(`[OCR] Direct upload: Short text (${localText.trim().length} chars). Triggering Level 4 OCR...`);
            const ocrText = await ocrViaTesseract(pdfBuffer);
            if (ocrText && ocrText.trim().length >= 100) {
              console.log(`[OCR] Successfully OCR'd ${ocrText.trim().length} chars.`);
              localText = ocrText;
            }
          }
        }

        // Step 3: Heuristic extraction
        localResult = await localExtract(localText, filename || gdriveUrl || undefined);
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
 * Returns true if any of the core fields are missing or have confidence < 80%.
 * Lowered threshold from 0.90 to 0.80 so AI is called more often to verify/correct regex heuristics.
 */
export function needsAi(r: ExtractionResult): boolean {
  const checkFields: Array<keyof ExtractionResult> = [
    "subject",
    "department",
    "semester",
    "academic_year",
    "exam_type",
    "marks",
  ];
  return checkFields.some((f) => !r[f] || r[f].value === null || r[f].confidence < 0.80);
}

/**
 * Filter out fields with confidence >= 0.95 to pass to Gemini API as pre-locked.
 * Raised threshold from 0.85 to 0.95 so only truly certain local results are locked.
 * This prevents wrong regex guesses from being sent as "do not change" to Gemini.
 */
function getHighConfFields(r: ExtractionResult) {
  const out: Record<string, unknown> = {};
  (Object.keys(r) as Array<keyof ExtractionResult>).forEach((k) => {
    if (r[k] && r[k].confidence >= 0.95) {
      out[k] = r[k].value;
    }
  });
  return out;
}

/**
 * Merge local heuristic results and AI results.
 * AI (Gemini) results are trusted over local regex heuristics when AI has reasonable confidence.
 * Only truly exact local matches (confidence >= 0.95) are preserved over AI.
 */
export function mergeResults(local: ExtractionResult, api: ExtractionResult): ExtractionResult {
  const merged = { ...local };
  (Object.keys(local) as Array<keyof ExtractionResult>).forEach((k) => {
    const localField = local[k];
    const apiField = api[k];
    
    // If the API extracted a field with confidence >= 0.75, trust the API over local heuristic
    // This ensures Gemini's actual document analysis overrides regex guesses
    if (apiField && apiField.value !== null && apiField.confidence >= 0.75) {
      merged[k] = apiField as any;
      return;
    }
    
    // Keep local only if it has very high confidence (>= 0.95, i.e. exact DB match or literal match)
    if (localField && localField.confidence >= 0.95) {
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
 * Execute AI Extraction (Gemini API or Lovable Gateway) when local heuristics need AI.
 */
export async function runAiExtraction(
  pdfBuffer: Buffer | null,
  localText: string,
  localResult: ExtractionResult
): Promise<ExtractionResult> {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!geminiApiKey && !apiKey) return localResult;

  try {
    const highConfFields = getHighConfFields(localResult);
    // ALWAYS prefer sending PDF buffer for multimodal vision analysis.
    // Only fall back to text-only if no PDF buffer is available.
    const usePdfVision = Boolean(pdfBuffer && pdfBuffer.length > 500);
    let raw = "";

    if (geminiApiKey) {
      const model = process.env.GEMINI_MODEL || "gemini-flash-latest";
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;
      
      const highConfNote = Object.keys(highConfFields).length > 0
        ? `\n\nThese fields were already extracted with very high confidence from exact text matches. You may use them as reference but MUST verify them against the actual document: ${JSON.stringify(highConfFields)}`
        : "";
      
      const prompt = usePdfVision
        ? `${SYSTEM_PROMPT}${highConfNote}\n\nExtract ALL fields from the attached PDF document. Analyze the header area carefully for department, semester, marks, academic year, and subject.`
        : `${SYSTEM_PROMPT}${highConfNote}\n\nExtract all fields from this question paper text. Analyze the header area carefully for department, semester, marks, academic year, and subject.\n\nText:\n${localText}`;

      const contents = usePdfVision
        ? [{
            role: "user",
            parts: [
              { inlineData: { mimeType: "application/pdf", data: pdfBuffer!.toString("base64") } },
              { text: prompt }
            ]
          }]
        : [{ role: "user", parts: [{ text: prompt }] }];

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents, generationConfig: { responseMimeType: "application/json" } })
      });

      if (response.ok) {
        const body = (await response.json()) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        raw = body.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      }
    } else if (apiKey) {
      const pdfBase64 = usePdfVision ? pdfBuffer!.toString("base64") : "";
      const content = usePdfVision
        ? [
            { type: "text", text: `Extract ALL fields from the attached PDF. Verify every field carefully.\n\nHigh confidence reference values (verify against document): ${JSON.stringify(highConfFields)}` },
            { type: "file", file: { filename: "paper.pdf", file_data: `data:application/pdf;base64,${pdfBase64}` } }
          ]
        : [
            { type: "text", text: `Extract remaining fields. High confidence values: ${JSON.stringify(highConfFields)}. Text:\n${localText}` }
          ];
      
      const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Lovable-API-Key": apiKey },
        body: JSON.stringify({
          model: "google/gemini-2.5-pro",
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content }
          ],
          response_format: { type: "json_object" }
        })
      });
      if (response.ok) {
        const body = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        raw = body.choices?.[0]?.message?.content ?? "";
      }
    }

    if (raw) {
      const apiResult = parseExtraction(raw);
      if (apiResult) {
        return mergeResults(localResult, apiResult);
      }
    }
  } catch (err) {
    console.error("AI extraction error in runAiExtraction:", err);
  }

  return localResult;
}

/**
 * localExtract performs regular expression matches and database checks on extracted plain text
 */
export const SUBJECTS_ALIASES: Record<string, string> = {
  // Electrical / Electronics fundamentals
  "BEEDE": "Basic Electrical Engineering and Digital Electronics",
  "BEEE": "Basic Electrical & Electronics Engineering",
  "BEE and DE": "Basic Electrical Engineering and Digital Electronics",
  "ADE": "Analog and Digital Electronics",
  "EDC": "Electronic Devices and Circuits",
  "DE": "Digital Electronics",
  "DIGITAL ELECT": "Digital Electronics",
  "ECT": "Electrical Circuit Theory",

  // Communication skills
  "ECS": "Effective Communication Skills",

  // Engineering Mechanics
  "CEM": "Computational Engineering Mechanics",

  // Mathematics variants
  "EM-I": "Engineering Mathematics I",
  "EM I": "Engineering Mathematics I",
  "MATH-I": "Engineering Mathematics I",
  "ENGG. MATH-I": "Engineering Mathematics I",
  "ENGG. MATH": "Engineering Mathematics",
  "M-III": "Engineering Mathematics III",
  "EM-II": "Engineering Mathematics II",
  "EM II": "Engineering Mathematics II",
  "MATH-II": "Engineering Mathematics II",
  "EM-III": "Engineering Mathematics III",
  "EM III": "Engineering Mathematics III",
  "MATH-III": "Engineering Mathematics III",
  "Engg. Math III": "Engineering Mathematics III",
  "EM-IV": "Engineering Mathematics IV",
  "EM IV": "Engineering Mathematics IV",
  "MATH-IV": "Engineering Mathematics IV",
  "Engg. Math-iv": "Engineering Mathematics IV",
  "COMP.MATH": "Computational Mathematics",

  // Data Structures / Algorithms
  "DSA": "Data Structures and Algorithms",
  "DS & A": "Data Structures and Algorithms",
  "DATA STRUCTURE": "Data Structures",
  "DAA": "Design and Analysis of Algorithms",
  "DISCRETE STRUCTURE": "Discrete Structures",
  "DISCRETE STRUCT.": "Discrete Structures",
  "DISCTERE STRUCTURE": "Discrete Structures",

  // Database
  "DBMS": "Database Management Systems",
  "ADBMS": "Advanced Database Management Systems",
  "DATABASE SYSTEM": "Database Systems",

  // AI / ML / DS
  "AI": "Artificial Intelligence",
  "ML": "Machine Learning",
  "ML-I": "Machine Learning I",
  "ML-II": "Machine Learning II",
  "OS": "Operating Systems",
  "CN": "Computer Networks",
  "IOT": "Internet of Things",
  "INFO SECURITY": "Information Security",
  "IS": "Information Security",
  "DMW": "Data Mining and Warehousing",
  "DISTRI. COMPUTING": "Distributed Computing",

  // Signal Processing / Communication
  "DSP": "Digital Signal Processing",
  "DSPA": "Digital Signal Processing and Applications",
  "DC": "Digital Communication",
  "AC": "Analog Communication",
  "S&S": "Signals and Systems",
  "FDIP": "Fundamentals of Digital Image Processing",
  "MOBILE COMM SYSTEM": "Mobile Communication Systems",
  "MICROWAVE ENGG": "Microwave Engineering",
  "RADIATING SYSTEM": "Radiating Systems",

  // Civil
  "BPD": "Building Planning and Drawing",
  "SA": "Structural Analysis",
  "DSS": "Design of Steel Structures",
  "WRE": "Water Resources Engineering",
  "GEOTECH": "Geotechnical Engineering",
  "SUR": "Surveying",
  "SUR-I": "Surveying I",
  "MOS": "Mechanics of Solids",
  "E&C": "Estimation and Costing",
  "MFCE": "Mechanics of Fluids and Civil Engineering",
  "Constr. Mngt": "Construction Management",
  "SFE": "Structural and Foundation Engineering",

  // Mechanical
  "FM": "Fluid Mechanics",
  "KOM": "Kinematics of Machinery",
  "AMP": "Automotive Prime Movers",
  "APM": "Automotive Prime Movers",
  "MMM": "Mechanical Measurements and Metrology",
  "M&M": "Mechanical Measurements and Metrology",
  "MT": "Manufacturing Technology",
  "MP": "Manufacturing Processes",
  "SOM": "Strength of Materials",
  "HT": "Heat Transfer",
  "MV": "Mechanical Vibrations",
  "MD-II": "Machine Design II",
  "FMS PAS": "Flexible Manufacturing Systems",
  "FINITE": "Finite Element Analysis",
  "AUTO ENGG": "Automobile Engineering",
  "AUTOMOBILE": "Automobile Engineering",

  // Electrical
  "IIAEE": "Introduction to Industrial Automation and Electrical Engineering",
  "ETU": "Electrical Technology and Utilization",
  "PSA": "Power System Analysis",
  "EME": "Elements of Mechanical Engineering",
  "MIA": "Microcontrollers and Applications",
  "MICRO & ITS APPL": "Microcontrollers and Applications",
  "PSTD": "Power System Transmission and Distribution",
  "EEGS": "Electrical Energy Generation System",
  "EMAI": "Electrical Machines and Instruments",
  "ENAS": "Electrical Network Analysis and Synthesis",
  "IEC": "Industrial Electronics and Control",
  "RES": "Renewable Energy Systems",
  "HVE": "High Voltage Engineering",
  "SWITCHGEAR & PROT": "Switchgear and Protection",
  "ELECTRICAL MOBILITY": "Electrical Mobility",
  "IAC": "Instrumentation and Control",
  "POWER ENGG.": "Power Engineering",
  "TMEE": "Testing and Maintenance of Electrical Equipment",
  "ELECT. MACHINE DESIGN": "Electrical Machine Design",
  "EPSD": "Electrical Power System Design",
  "EMBEDDED SYSTEM": "Embedded Systems",
  "EMBEDDE SYSTEM": "Embedded Systems",
  "EM-I ELECTRICAL": "Engineering Mathematics I",

  // Computer Engineering
  "SF": "System Fundamentals",
  "COMP SYSTEM FUND.": "Computer System Fundamentals",
  "SYSTEM FUND.": "System Fundamentals",
  "PLP": "Principles of Programming Languages",
  "MIS": "Management Information System",
  "POA": "Processor Organization and Architecture",
  "FLAT": "Formal Language and Automata Theory",
  "AOA": "Analysis of Algorithms",
  "CNS": "Cryptography and Network Security",
  "C N S": "Cryptography and Network Security",
  "DSD": "Digital System Design",
  "ECD": "Electronic Circuit Design",

  // Graphics / Physics / Chemistry / Core Sciences
  "EG": "Engineering Graphics",
  "GP": "Graphics",
  "GRAPHICS": "Engineering Graphics",
  "GRAPHICE": "Engineering Graphics",
  "ENGG CHEMISTRY": "Engineering Chemistry",
  "ENGG. CHEM": "Engineering Chemistry",
  "ENGG. CHEMISTRY": "Engineering Chemistry",
  "ENGG. PHYSICS": "Engineering Physics",
  "ENGG PHYSICS": "Engineering Physics",
  "Engg. Physics": "Engineering Physics",
  "Engg. Chemistry": "Engineering Chemistry",
  "PHYSICS": "Engineering Physics",
  "PHY": "Engineering Physics",
  "CHEMISTRY": "Engineering Chemistry",
  "CHEM": "Engineering Chemistry",
  "CHEM -II": "Engineering Chemistry II",
  "CHEM-II": "Engineering Chemistry II",
  "Mechanics": "Engineering Mechanics",
  "Comp Engg. Mechanics": "Computational Engineering Mechanics",

  // Misc & Common Abbreviations
  "RM": "Research Methodology",
  "UHV": "Universal Human Values",
  "PLCM": "Product Lifecycle Management",
  "IPR": "Intellectual Property Rights",
  "PFM": "Personal Finance Management",
  "BCM": "Business Communication and Management",
  "CT": "Communication Techniques",
  "CTAK": "Communication Techniques",
  "SPC": "Statistical Process Control",
  "RFC": "Reinforced Concrete Construction",
  "E&WP": "Environmental and Water Pollution",
  "IC": "Internal Combustion Engines",
  "CS": "Computer Science",
  "AIML": "Artificial Intelligence and Machine Learning",
  "IPCV-I": "Image Processing and Computer Vision - I",
  "IPCV-II": "Image Processing and Computer Vision - II",
  "QBM": "Quantitative Business Methods",
  "PROB & STAT": "Probability and Statistics",
  "Software Engg.": "Software Engineering",
  "MFEE": "Mathematics for Electrical Engineering",
  "CP": "Computer Programming",
  "EN": "Environmental Studies",
  "ENV": "Environmental Studies",
  "ESC": "Engineering Science",
  "EFM": "Engineering Fluid Mechanics",
  "RAC": "Refrigeration and Air Conditioning",
  "EMI": "Electrical Measurements and Instrumentation",
  "C N": "Computer Networks",
  "ACD": "Analog and Computer Circuits",
  "ELEMENT CIVIL ENGG": "Elements of Civil Engineering"
};

// Full department name matches (always safe to match anywhere in text)
const DEPT_FULL_NAMES: Record<string, string[]> = {
  "Computer Engineering": ["computer engineering", "computer science", "computer science and engineering"],
  "Information Technology": ["information technology"],
  "Mechanical Engineering": ["mechanical engineering"],
  "Civil Engineering": ["civil engineering"],
  "Electrical Engineering": ["electrical engineering"],
  "Electronics and Telecommunication": ["electronics and telecommunication", "electronics & telecommunication", "electronics and communication", "electronics & communication"],
  "Artificial Intelligence and Machine Learning": ["artificial intelligence and machine learning", "artificial intelligence & machine learning"],
  "Data Science": ["data science"],
};

// Short abbreviations that REQUIRE header context (e.g., "Dept of IT", "Branch: Mech")
// These are NOT safe to match as bare words in general text.
const DEPT_CONTEXT_ABBRS: Record<string, string[]> = {
  "Computer Engineering": ["cse", "comp eng", "comp. eng.", "comp engg", "comp. engg.", "comp"],
  "Information Technology": ["it", "infotech", "info tech", "info. tech.", "inf. tech."],
  "Mechanical Engineering": ["mech", "mechanical", "mech eng", "mech. eng.", "mech engg", "mech. engg.", "me"],
  "Civil Engineering": ["civil", "ce", "civil eng", "civil engg", "civil. engg."],
  "Electrical Engineering": ["electrical", "elect", "ee", "elect eng", "elect engg", "elect. eng.", "elect. engg."],
  "Electronics and Telecommunication": ["entc", "e&tc", "etc", "et&c", "electronics", "telecommunication", "ece", "extc", "e & tc", "e.t.c.", "e.n.t.c."],
  "Artificial Intelligence and Machine Learning": ["aiml", "ai & ml", "ai/ml", "artificial intelligence", "ai and ml", "ai-ml"],
  "Data Science": ["aids", "cseds", "ds", "ai & ds", "ai&ds", "ai-ds"],
};

// Combined for backward compatibility in filename parsing (filenames are structured, less ambiguous)
const DEPT_ABBRS: Record<string, string[]> = {};
for (const [dept, fullNames] of Object.entries(DEPT_FULL_NAMES)) {
  DEPT_ABBRS[dept] = [...fullNames, ...(DEPT_CONTEXT_ABBRS[dept] || [])];
}

function getLevenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          Math.min(
            matrix[i][j - 1] + 1, // insertion
            matrix[i - 1][j] + 1  // deletion
          )
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

function lookupSubjectAlias(str: string, dynamicAliases?: Record<string, string>): string | null {
  const normalized = str.toUpperCase().trim();
  if (!normalized) return null;

  // Combine static and dynamic aliases
  const combinedAliases = {
    ...SUBJECTS_ALIASES,
    ...dynamicAliases
  };

  // 1. Try exact abbreviation/regex matches
  for (const [abbr, fullName] of Object.entries(combinedAliases)) {
    const regex = new RegExp(`\\b${abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, "i");
    if (regex.test(normalized)) {
      return fullName;
    }
  }

  // 2. Try exact full subject match (in case file already contains the full name)
  for (const fullName of Object.values(combinedAliases)) {
    if (fullName.toUpperCase() === normalized) {
      return fullName;
    }
  }

  // 3. Fuzzy matching: if Levenshtein distance <= 3 from any alias value (full subject names) or alias abbreviation keys (for words > 3 chars)
  let bestMatch: string | null = null;
  let minDistance = Infinity;

  for (const [abbr, fullName] of Object.entries(combinedAliases)) {
    // Check against full name
    const distFullName = getLevenshteinDistance(normalized, fullName.toUpperCase());
    if (distFullName <= 3 && distFullName < minDistance) {
      minDistance = distFullName;
      bestMatch = fullName;
    }

    // Check against abbreviation if abbreviation is long enough
    if (abbr.length >= 4) {
      const distAbbr = getLevenshteinDistance(normalized, abbr.toUpperCase());
      if (distAbbr <= 1 && distAbbr < minDistance) {
        minDistance = distAbbr;
        bestMatch = fullName;
      }
    }
  }

  if (minDistance <= 3) {
    console.log(`[Fuzzy Match] matched '${str}' to '${bestMatch}' (Levenshtein distance: ${minDistance})`);
    return bestMatch;
  }

  return null;
}

function matchDepartment(str: string): string | null {
  const lower = str.toLowerCase();
  // 1. Try exact full department name matches (always safe)
  for (const [deptName, fullNames] of Object.entries(DEPT_FULL_NAMES)) {
    if (lower.includes(deptName.toLowerCase())) {
      return deptName;
    }
    for (const fullName of fullNames) {
      if (lower.includes(fullName)) {
        return deptName;
      }
    }
  }
  // 2. Try short abbreviations ONLY with header context
  // Require patterns like: "Dept of IT", "Branch: Mech", "Department: Civil", "B.Tech (CSE)", "B.E. Comp"
  for (const [deptName, abbreviations] of Object.entries(DEPT_CONTEXT_ABBRS)) {
    for (const abbr of abbreviations) {
      const escapedAbbr = abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Match abbreviation when preceded by department-context keywords
      const contextPatterns = [
        new RegExp(`(?:dept\.?|department|branch|programme|program|course|b\.?\\s*tech|b\.?\\s*e\.?|diploma|engg?\.?|engineering)\\s*(?:of|:|-|–|\\()?\\s*${escapedAbbr}\\b`, "i"),
        new RegExp(`\\b${escapedAbbr}\\s*(?:\\)|department|branch|engg?\.?|engineering)`, "i"),
      ];
      for (const regex of contextPatterns) {
        if (regex.test(lower)) {
          return deptName;
        }
      }
    }
  }
  return null;
}

/**
 * Match department in PDF text with context-awareness.
 * Full names are matched anywhere. Short abbreviations require header context.
 * Returns the department name and a confidence level.
 */
function matchDepartmentInText(text: string): { dept: string; confidence: number } | null {
  const lower = text.toLowerCase();
  // 1. Try exact full department name matches (high confidence)
  for (const [deptName, fullNames] of Object.entries(DEPT_FULL_NAMES)) {
    if (lower.includes(deptName.toLowerCase())) {
      return { dept: deptName, confidence: 0.95 };
    }
    for (const fullName of fullNames) {
      if (lower.includes(fullName)) {
        return { dept: deptName, confidence: 0.95 };
      }
    }
  }
  // 2. Try short abbreviations with header context (medium-high confidence)
  for (const [deptName, abbreviations] of Object.entries(DEPT_CONTEXT_ABBRS)) {
    for (const abbr of abbreviations) {
      const escapedAbbr = abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const contextPatterns = [
        new RegExp(`(?:dept\.?|department|branch|programme|program|course|b\.?\\s*tech|b\.?\\s*e\.?|diploma|engg?\.?|engineering)\\s*(?:of|:|-|–|\\()?\\s*${escapedAbbr}\\b`, "i"),
        new RegExp(`\\b${escapedAbbr}\\s*(?:\\)|department|branch|engg?\.?|engineering)`, "i"),
      ];
      for (const regex of contextPatterns) {
        if (regex.test(lower)) {
          return { dept: deptName, confidence: 0.85 };
        }
      }
    }
  }
  return null;
}

/**
 * Match semester with confidence level.
 * Returns { semester, confidence } or null.
 * Explicit "Sem 3" / "Semester IV" patterns get high confidence.
 * Year-only (FY/SY/TY/BE) without ODD/EVEN gets LOW confidence (0.30) so AI can verify.
 */
function matchSemesterWithConfidence(str: string): { semester: number; confidence: number } | null {
  const romanMap: Record<string, number> = {
    I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8
  };
  const ordinalMap: Record<string, number> = {
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8,
    "1st": 1, "2nd": 2, "3rd": 3, "4th": 4, "5th": 5, "6th": 6, "7th": 7, "8th": 8,
  };

  // Pattern 1: Explicit semester number — Sem 3, Semester: 5, SEM-3 (high confidence)
  // Use 'semester' or 'sem' only (removed bare 's' to avoid false matches like "Question 1 s 1")
  const semNumRegex = /\b(?:semester|sem)\s*[:\-–\_]?\s*([1-8])\b/i;
  const numMatch = str.match(semNumRegex);
  if (numMatch) {
    return { semester: parseInt(numMatch[1], 10), confidence: 0.95 };
  }

  // Pattern 1b: Explicit semester Roman — Sem III, Semester-IV (high confidence)
  const semRomanRegex = /\b(?:semester|sem)\s*[:\-–\_]?\s*(VIII|VII|VI|IV|V|III|II|I)\b/i;
  const romanMatch = str.match(semRomanRegex);
  if (romanMatch) {
    const val = romanMap[romanMatch[1].toUpperCase()];
    if (val) return { semester: val, confidence: 0.95 };
  }

  // Direct joined pattern: SEM-III, SEM_III, SEMIII (high confidence)
  const semRomanDirectRegex = /\bSEM[\-\_]?(VIII|VII|VI|IV|V|III|II|I)\b/i;
  const directRomanMatch = str.match(semRomanDirectRegex);
  if (directRomanMatch) {
    const val = romanMap[directRomanMatch[1].toUpperCase()];
    if (val) return { semester: val, confidence: 0.95 };
  }

  // Pattern 2: "Third Semester", "3rd Semester", "1st Sem" (high confidence)
  const ordinalSemRegex = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|1st|2nd|3rd|4th|5th|6th|7th|8th)\s+(?:semester|sem)\b/i;
  const ordinalMatch = str.match(ordinalSemRegex);
  if (ordinalMatch) {
    const val = ordinalMap[ordinalMatch[1].toLowerCase()];
    if (val) return { semester: val, confidence: 0.95 };
  }

  // Pattern 3: Year prefix + ODD/EVEN (medium confidence since we're inferring)
  const isOdd = /\bODD\b/i.test(str);
  const isEven = /\bEVEN\b/i.test(str);
  const hasOddEven = isOdd || isEven;

  // FY / F.Y. / F.E. / FE / First Year / FY B.Tech
  if (/\b(?:FY|F\.?\s?Y\.?|F\.?\s?E\.?|FE|first\s*year|fy\s*b\.?\s*tech)\b/i.test(str)) {
    if (hasOddEven) return { semester: isEven ? 2 : 1, confidence: 0.85 };
    // Year-only without ODD/EVEN: LOW confidence so AI determines exact semester
    return { semester: 1, confidence: 0.30 };
  }
  // SY / S.Y. / S.E. / Second Year (avoid bare "SE" as it matches too many things)
  if (/\b(?:SY|S\.?\s?Y\.?|S\.?\s?E\.?|second\s*year|sy\s*b\.?\s*tech)\b/i.test(str)) {
    if (hasOddEven) return { semester: isEven ? 4 : 3, confidence: 0.85 };
    return { semester: 3, confidence: 0.30 };
  }
  // TY / T.Y. / T.E. / Third Year (avoid bare "TE")
  if (/\b(?:TY|T\.?\s?Y\.?|T\.?\s?E\.?|third\s*year|ty\s*b\.?\s*tech)\b/i.test(str)) {
    if (hasOddEven) return { semester: isEven ? 6 : 5, confidence: 0.85 };
    return { semester: 5, confidence: 0.30 };
  }
  // BE / B.E. / Final Year / Final
  if (/\b(?:final\s*year|final\s*b\.?\s*tech)\b/i.test(str)) {
    if (hasOddEven) return { semester: isEven ? 8 : 7, confidence: 0.85 };
    return { semester: 7, confidence: 0.30 };
  }

  return null;
}

// Backward compatible wrapper that returns just the semester number
function matchSemester(str: string): number | null {
  const result = matchSemesterWithConfidence(str);
  return result ? result.semester : null;
}

function matchAcademicYear(str: string): string | null {
  // Skip syllabus/pattern year declarations
  const cleanedStr = str
    .replace(/\b(?:pattern|syllabus|curriculum|scheme)\s*[:\-]?\s*(20\d{2}(?:\s*-\s*(?:20)?\d{2})?)\b/gi, "")
    .replace(/\b(?:as\s+per|w\.?e\.?f\.?)\s*[:\-]?\s*(20\d{2}(?:\s*-\s*(?:20)?\d{2})?)\b/gi, "");

  // Try explicit academic year range (e.g., "2023-24", "2024-2025")
  const yearRegex = /\b(?:academic\s*year|a\.?\s*y\.?|session)?\s*[:\-]?\s*(20\d{2})\s*-\s*(20)?(\d{2})\b/i;
  const match = cleanedStr.match(yearRegex);
  if (match) {
    return `${match[1]}-${match[3]}`;
  }

  // Try to infer from exam session/month (e.g., "Nov/Dec 2023" -> "2023-24", "May 2024" -> "2023-24")
  const monthNames: Record<string, number> = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
    jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
    winter: 11, summer: 5, odd: 11, even: 5,
  };

  // Match patterns like "Nov/Dec 2023", "Winter 2023", "May 2024", "Summer 2024"
  const sessionRegex = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?|Winter|Summer|Odd|Even)\s*(?:\/\s*(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?))??\s*[,\-]?\s*(20\d{2})\b/i;
  const sessionMatch = cleanedStr.match(sessionRegex);
  if (sessionMatch) {
    const monthKey = sessionMatch[1].toLowerCase();
    const year = parseInt(sessionMatch[2], 10);
    const monthNum = monthNames[monthKey];
    if (monthNum) {
      // Jul-Dec exams belong to academic year YYYY-(YY+1)
      // Jan-Jun exams belong to academic year (YYYY-1)-YY
      if (monthNum >= 7) {
        const nextYear = (year + 1) % 100;
        return `${year}-${nextYear.toString().padStart(2, "0")}`;
      } else {
        const prevYear = year - 1;
        const shortYear = year % 100;
        return `${prevYear}-${shortYear.toString().padStart(2, "0")}`;
      }
    }
  }

  return null;
}

function matchExamType(str: string): "ESE" | "RE-ESE" | "Supplementary" | "Complementary" | null {
  // Check for RE-ESE first (more specific) before ESE
  if (/\b(?:re\s*-\s*ese|re\s*ese|re\s*-\s*exam|re\s*exam|RE\s*-\s*ODD|RE\s*ODD|RE\s*-\s*EVEN|RE\s*EVEN)\b/i.test(str)) {
    return "RE-ESE";
  }
  if (/\b(?:ese|end\s*semester|regular\s*end\s*semester|regular\s*ese)\b/i.test(str)) {
    return "ESE";
  }
  if (/\b(?:supplementary|supp)\b/i.test(str)) {
    return "Supplementary";
  }
  // Strictly match complementary (do NOT match "comp" which conflicts with Computer/Component)
  if (/\b(?:complementary)\b/i.test(str)) {
    return "Complementary";
  }
  // Infer ESE from QP/AK/synoptics markers (these are regular exam papers)
  if (/\b(?:qp|question\s*paper|synoptics)\b/i.test(str) || /\b(?:ak|answer\s*key|solution|soln)\b/i.test(str)) {
    return "ESE";
  }
  return null;
}

function matchMarks(str: string): number | null {
  // ONLY match total paper marks from header context. Never match sub-question marks.
  // Valid standard total marks: 30, 40, 50, 60, 65, 70, 75, 80, 100
  const VALID_TOTAL_MARKS = new Set([30, 40, 50, 60, 65, 70, 75, 80, 100]);
  
  const marksPatterns = [
    // "Max. Marks: 60", "Maximum Marks: 80", "Total Marks: 100", "Full Marks: 70"
    /\b(?:max\.?\s*marks|maximum\s+marks|total\s+marks|full\s+marks)\s*[:\-–]?\s*(\d{2,3})\b/i,
    // "Marks: 60" (bare "Marks:" in header context)
    /\bmarks\s*[:\-–]\s*(\d{2,3})\b/i,
  ];
  for (const regex of marksPatterns) {
    const match = str.match(regex);
    if (match) {
      const val = parseInt(match[1], 10);
      if (VALID_TOTAL_MARKS.has(val)) {
        return val;
      }
    }
  }
  return null;
}

function matchSubjectCode(str: string): string | null {
  const codeRegexExplicit = /(?:subject|course)\s+code\s*[:\-]?\s*\b([A-Z0-9\-]+)\b/i;
  const genericCodeRegex = /\b([A-Z]{2,4}\s*\d{3,4}[A-Z]?)\b/;

  const explicitMatch = str.match(codeRegexExplicit);
  if (explicitMatch) {
    return explicitMatch[1].toUpperCase();
  }
  const genericMatch = str.match(genericCodeRegex);
  if (genericMatch) {
    return genericMatch[1].replace(/\s+/g, "").toUpperCase();
  }
  return null;
}

export function parseFromFilename(filename: string, dynamicAliases?: Record<string, string>): ExtractionResult {
  const result: ExtractionResult = JSON.parse(JSON.stringify(EMPTY_RESULT));
  if (!filename || filename.trim().startsWith("http://") || filename.trim().startsWith("https://") || filename.includes("drive.google.com") || filename.includes("/file/d/")) {
    return result;
  }

  const fnClean = filename.replace(/\.pdf$/i, "").replace(/[\_\-]+/g, " ").trim();

  // Process structured fields FIRST before stripping
  const matchedDept = matchDepartment(fnClean);
  if (matchedDept) {
    result.department = { value: matchedDept, confidence: 0.85 };
  }

  const semResult = matchSemesterWithConfidence(fnClean);
  if (semResult) {
    result.semester = { value: semResult.semester, confidence: Math.min(semResult.confidence, 0.85) };
  }

  const matchedYear = matchAcademicYear(fnClean);
  if (matchedYear) {
    result.academic_year = { value: matchedYear, confidence: 0.85 };
  }

  const matchedExamType = matchExamType(fnClean);
  if (matchedExamType) {
    result.exam_type = { value: matchedExamType, confidence: 0.85 };
  }

  const matchedMarks = matchMarks(fnClean);
  if (matchedMarks) {
    result.marks = { value: matchedMarks, confidence: 0.85 };
  }

  const matchedCode = matchSubjectCode(fnClean);
  if (matchedCode) {
    result.subject_code = { value: matchedCode, confidence: 0.85 };
  }

  // Try alias lookup (abbreviations like BEEDE, DSA, EM-III)
  const alias = lookupSubjectAlias(fnClean, dynamicAliases);
  if (alias) {
    result.subject = { value: alias, confidence: 0.85 };
  }

  // If no alias matched, isolate full subject candidate from filename
  if (!result.subject.value) {
    let subjectCandidate = fnClean
      .replace(/\b(?:QP|AK|RCPIT|synoptics|SYNOPTICS|FY|SY|TY|BE|BTECH|FYBTECH|SYBTECH|TYBTECH)\b/gi, "")
      .replace(/\b(?:SEM|SEMESTER)\s*[:\-]?\s*(?:[IVX]+|\d)\b/gi, "")
      .replace(/\b(?:COMP|MECH|CIVIL|ETC|ELECT|AIML|AIDS|CSEDS|DS|IT|MCA|FYALL|FY ALL|SY ALL|ALL|GL)\b/gi, "")
      .replace(/\b\d{2}[\.\/]\d{2}[\.\/]\d{4}\b/g, "") // dates like 12.01.2024
      .replace(/\b\d{8,}\b/g, "") // long number sequences
      .replace(/\b(?:20)?\d{2}\s*[-/]\s*\d{2}\b/g, "") // academic year ranges like 24-25, 2024-25, 24/25
      .replace(/\b(20\d{2})\s*-?\s*(\d{2})\b/g, "") // academic year
      .replace(/\b(50|60|65|70|75|80|100)\s*[Mm]?\b/g, "") // marks
      .replace(/\b(?:GR|Group)\s*[A-Z]\b/gi, "") // group markers
      .replace(/\b(?:ODD|EVEN|RE)\b/gi, "")
      .replace(/\b[A-Z]{2,4}\d{3,}[A-Z]?\b/g, "") // course codes like RCP23VCPC301
      .replace(/\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+20\d{2}\b/gi, "") // "29 Jan 2025"
      .replace(/\b(?:compressed|_compressed|solution|Solution)\b/gi, "")
      .replace(/\s*@+\s*/g, "") // trailing @
      .replace(/^\s*[\d\.\-\_\s]+/g, "") // strip leading digits, dots, dashes, spaces
      .replace(/^[^\w\s]+|[^\w\s]+$/g, "") // strip leading/trailing non-alphanumeric punctuation
      .replace(/\s+/g, " ")
      .trim();

    // Clean up and title-case if the candidate looks like a real subject name
    if (subjectCandidate.length >= 3 && subjectCandidate.length <= 180) {
      const lowerCandidate = subjectCandidate.toLowerCase();
      let foundAlias = false;
      for (const fullName of Object.values(SUBJECTS_ALIASES)) {
        if (fullName.toLowerCase() === lowerCandidate || lowerCandidate.includes(fullName.toLowerCase())) {
          result.subject = { value: fullName, confidence: 0.85 };
          foundAlias = true;
          break;
        }
      }
      if (!foundAlias && subjectCandidate.length >= 5) {
        const titleCased = subjectCandidate
          .split(" ")
          .filter(w => w.length > 0)
          .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
          .join(" ");
        if (titleCased.length >= 5) {
          result.subject = { value: titleCased, confidence: 0.70 };
        }
      }
    }
  }

  return result;
}

export function parseFromFolderPath(folderPath: string): ExtractionResult {
  const result: ExtractionResult = JSON.parse(JSON.stringify(EMPTY_RESULT));
  if (!folderPath) return result;

  const parts = folderPath.split("/").map(p => p.trim());
  for (const part of parts) {
    const matchedDept = matchDepartment(part);
    if (matchedDept && !result.department.value) {
      result.department = { value: matchedDept, confidence: 0.40 };
    }

    const matchedSem = matchSemester(part);
    if (matchedSem && !result.semester.value) {
      result.semester = { value: matchedSem, confidence: 0.40 };
    }

    const matchedYear = matchAcademicYear(part);
    if (matchedYear && !result.academic_year.value) {
      result.academic_year = { value: matchedYear, confidence: 0.40 };
    }

    const alias = lookupSubjectAlias(part);
    if (alias && !result.subject.value) {
      result.subject = { value: alias, confidence: 0.40 };
    }
  }

  return result;
}

/**
 * localExtract performs regular expression matches and database checks on extracted plain text, filenames, and folder paths
 */
export async function localExtract(text: string, filename?: string, folderPath?: string): Promise<ExtractionResult> {
  const result: ExtractionResult = JSON.parse(JSON.stringify(EMPTY_RESULT));

  const textToScan = text || "";
  const fnToScan = filename || "";
  const normalizedText = textToScan.replace(/\s+/g, " ");

  // Load learned aliases dynamically from DB
  const STOP_ALIASES = new Set([
    "OF", "IN", "FOR", "AND", "THE", "A", "AN", "OR", "WITH", "TO", "AT", "BY", "FROM", "ON", "BE", "AS",
    "DATA", "ENGG", "CIVIL", "MECH", "ELECT", "ETC", "ENTC", "RCPIT", "SEM", "SEMESTER", "YEAR", "MARKS",
    "QP", "AK", "SYNOPTICS", "BTECH", "FE", "SE", "TE", "BE", "FY", "SY", "TY", "ALL", "FULL", "SET",
    "CODE", "NAME", "TITLE", "PAPER", "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP",
    "OCT", "NOV", "DEC", "SOL", "QP-", "GR", "II", "III", "IV", "VI", "VII", "VIII"
  ]);

  const dynamicAliases: Record<string, string> = {};
  try {
    const { data: dbAliases } = await supabase.from("learned_aliases").select("alias, full_name");
    if (dbAliases) {
      for (const item of dbAliases) {
        const aliasKey = item.alias.toUpperCase().trim();
        const fn = item.full_name ? item.full_name.trim() : "";
        if (STOP_ALIASES.has(aliasKey) || fn.toLowerCase().startsWith("synoptics") || fn.startsWith("Papers/") || fn.startsWith("papers/")) {
          continue;
        }
        dynamicAliases[aliasKey] = fn;
      }
    }
  } catch (err) {
    console.error("Error loading learned aliases:", err);
  }

  // Level 1: Filename parsing (confidence 0.95)
  const fnResult = parseFromFilename(fnToScan, dynamicAliases);

  // Level 2: Folder path parsing (confidence 0.90)
  const pathResult = parseFromFolderPath(folderPath || "");

  // Level 3: PDF text parsing (confidence 0.98)
  const textResult: ExtractionResult = JSON.parse(JSON.stringify(EMPTY_RESULT));

  // -- Department --
  // Use context-aware department matching that avoids false positives from common words
  try {
    const { data: depts } = await supabase.from("departments").select("name");
    if (depts && depts.length > 0) {
      let matchedDept = null;
      if (textToScan.trim().length >= 5) {
        for (const d of depts) {
          const dName = d.name.toLowerCase().trim();
          if (dName.length >= 3 && textToScan.toLowerCase().includes(dName)) {
            matchedDept = d.name;
            textResult.department = { value: d.name, confidence: 0.95 }; // Exact DB full-name match in PDF text
            break;
          }
        }
      }

      // Second: Use context-aware abbreviation matching (requires header context like "Dept of", "Branch:")
      if (!matchedDept) {
        const deptMatch = matchDepartmentInText(textToScan);
        if (deptMatch) {
          // Verify the matched department exists in DB
          const dbDept = depts.find(d => d.name.toLowerCase() === deptMatch.dept.toLowerCase());
          if (dbDept) {
            matchedDept = dbDept.name;
            textResult.department = { value: dbDept.name, confidence: deptMatch.confidence };
          } else {
            matchedDept = deptMatch.dept;
            textResult.department = { value: deptMatch.dept, confidence: deptMatch.confidence * 0.9 };
          }
        }
      }
    }
  } catch (e) {
    console.error("Local dept query failed:", e);
  }

  // -- Semester -- (use confidence-aware matchSemesterWithConfidence)
  const semResult = matchSemesterWithConfidence(normalizedText);
  if (semResult) {
    textResult.semester = { value: semResult.semester, confidence: semResult.confidence };
  }

  // -- Academic Year -- (use improved matchAcademicYear that skips syllabus patterns)
  const matchedYear = matchAcademicYear(normalizedText);
  if (matchedYear) {
    textResult.academic_year = { value: matchedYear, confidence: 0.90 };
  }

  // -- Exam Type --
  const examTypePatterns = [
    { type: "RE-ESE" as const, regex: /\b(?:re\s*[\-–]?\s*ese|re\s*[\-–]?\s*exam|re\s*[\-–]?\s*end\s*semester)\b/i },
    { type: "ESE" as const, regex: /\b(?:ese|end\s*semester|regular\s*end\s*semester|regular\s*ese)\b/i },
    { type: "Supplementary" as const, regex: /\b(?:supplementary|supp)\b/i },
    { type: "Complementary" as const, regex: /\b(?:complementary)\b/i }
  ];

  for (const et of examTypePatterns) {
    if (et.regex.test(normalizedText)) {
      textResult.exam_type = { value: et.type, confidence: 0.90 };
      break;
    }
  }

  // -- Marks -- (use the improved matchMarks function)
  const matchedMarksFromText = matchMarks(normalizedText);
  if (matchedMarksFromText) {
    textResult.marks = { value: matchedMarksFromText, confidence: 0.90 };
  }

  // -- Subject Code --
  const codeRegexExplicit = /(?:subject|course)\s+code\s*[:\-]?\s*\b([A-Z0-9\-]+)\b/i;
  const genericCodeRegex = /\b([A-Z]{2,4}\s*\d{3,4}[A-Z]?)\b/;

  const explicitMatch = normalizedText.match(codeRegexExplicit);
  if (explicitMatch) {
    textResult.subject_code = { value: explicitMatch[1].toUpperCase(), confidence: 0.90 };
  } else {
    const genericMatch = normalizedText.match(genericCodeRegex);
    if (genericMatch) {
      textResult.subject_code = { value: genericMatch[1].replace(/\s+/g, "").toUpperCase(), confidence: 0.80 };
    }
  }

  // -- Date, Month, Year --
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

  const matchA = normalizedText.match(dateRegexA);
  if (matchA) {
    const day = matchA[1].padStart(2, "0");
    const month = matchA[2].padStart(2, "0");
    const year = matchA[3];
    matchedDateStr = `${year}-${month}-${day}`;
    matchedYearVal = parseInt(year, 10);
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    matchedMonth = months[parseInt(month, 10) - 1];
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
        }
      }
    }
  }

  if (matchedDateStr) {
    textResult.exam_date = { value: matchedDateStr, confidence: 0.90 };
    if (matchedMonth) {
      textResult.exam_month = { value: matchedMonth, confidence: 0.90 };
    }
    if (matchedYearVal) {
      textResult.exam_year = { value: matchedYearVal, confidence: 0.90 };
    }
  } else {
    const monthYearRegex = /\b([A-Za-z]+)\s+(20\d{2})\b/;
    const myMatch = normalizedText.match(monthYearRegex);
    if (myMatch) {
      const monthName = myMatch[1].toLowerCase();
      const monthCode = monthMap[monthName];
      if (monthCode) {
        const fullMonth = myMatch[1].charAt(0).toUpperCase() + myMatch[1].slice(1);
        textResult.exam_month = { value: fullMonth, confidence: 0.85 };
        textResult.exam_year = { value: parseInt(myMatch[2], 10), confidence: 0.85 };
      }
    }
  }

  // -- Subject Name --
  try {
    const { data: subjects } = await supabase.from("subjects").select("name");
    if (subjects && subjects.length > 0) {
      let matchedSubject = null;
      if (textToScan.trim().length >= 5) {
        for (const s of subjects) {
          const sName = s.name.toLowerCase().trim();
          if (sName.length >= 3 && textToScan.toLowerCase().includes(sName)) {
            matchedSubject = s.name;
            textResult.subject = { value: s.name, confidence: 0.95 }; // Exact DB subject name match in PDF text
            break;
          }
        }
      }

      if (!matchedSubject) {
        const alias = lookupSubjectAlias(textToScan);
        if (alias) {
          const dbMatch = subjects.find(s => s.name.toLowerCase() === alias.toLowerCase());
          if (dbMatch) {
            matchedSubject = dbMatch.name;
            textResult.subject = { value: dbMatch.name, confidence: 0.90 }; // Alias matched to DB subject
          } else {
            matchedSubject = alias;
            textResult.subject = { value: alias, confidence: 0.75 }; // Alias matched but not in DB
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
          textResult.subject = { value: cleanedSub, confidence: 0.60 }; // Regex extraction from text
        }
      }
    }
  } catch (e) {
    console.error("Local subject query failed:", e);
  }

  // Merge results based on highest confidence
  const fields: Array<keyof ExtractionResult> = [
    "subject",
    "subject_code",
    "department",
    "semester",
    "academic_year",
    "exam_type",
    "marks",
    "exam_date",
    "exam_month",
    "exam_year"
  ];

  fields.forEach((k) => {
    let best: any = { value: null, confidence: 0 };
    if (textResult[k] && textResult[k].confidence > best.confidence) {
      best = textResult[k];
    }
    if (fnResult[k] && fnResult[k].confidence > best.confidence) {
      best = fnResult[k];
    }
    if (pathResult[k] && pathResult[k].confidence > best.confidence) {
      best = pathResult[k];
    }
    result[k] = best as any;
  });

  // Sanitize subject to ensure URLs are NEVER returned as subjects
  if (result.subject?.value) {
    const val = String(result.subject.value).toLowerCase();
    if (
      val.includes("http") ||
      val.includes("drive.google") ||
      val.includes("/file/d/") ||
      val.includes(".com/") ||
      val.endsWith(".com") ||
      val.endsWith(".org")
    ) {
      result.subject = { value: null, confidence: 0 };
    }
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

export async function ocrViaGemini(pdfBase64: string): Promise<string> {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) return "";

  const model = process.env.GEMINI_MODEL || "gemini-flash-latest";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;

  const prompt = `Extract ALL visible text from this PDF page exactly as it appears. Return ONLY the raw text, no formatting, no JSON, no explanation. Include headers, footers, exam details, subject names, dates, marks — everything visible.`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { inlineData: { mimeType: "application/pdf", data: pdfBase64 } },
            { text: prompt },
          ],
        }],
      }),
    });

    if (!response.ok) return "";

    const body = (await response.json()) as any;
    return body.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  } catch (err) {
    console.error("ocrViaGemini fetch error:", err);
    return "";
  }
}

let ocrActive = false;
const ocrQueue: Array<() => void> = [];

const acquireOcrLock = async () => {
  if (!ocrActive) {
    ocrActive = true;
    return;
  }
  await new Promise<void>((resolve) => ocrQueue.push(resolve));
};

const releaseOcrLock = () => {
  const next = ocrQueue.shift();
  if (next) {
    next();
  } else {
    ocrActive = false;
  }
};

export async function ocrViaTesseract(pdfBuffer: Buffer): Promise<string> {
  await acquireOcrLock();
  let worker: any = null;
  try {
    const parser = new PDFParse({ data: pdfBuffer });
    const screenshot = await parser.getScreenshot({ first: 1, imageBuffer: true });
    await parser.destroy();
    
    if (!screenshot.pages || screenshot.pages.length === 0) {
      throw new Error("No pages rendered for OCR");
    }
    
    const pageData = screenshot.pages[0];
    if (!pageData.data || pageData.data.length === 0) {
      throw new Error("Rendered page has no image buffer data");
    }
    
    const buffer = Buffer.from(pageData.data);
    worker = await createWorker("eng");
    const { data: { text } } = await worker.recognize(buffer);
    await worker.terminate();
    worker = null;
    
    console.log(`[OCR] Tesseract successfully extracted ${text.length} chars.`);
    return text;
  } catch (err: any) {
    if (worker) {
      await worker.terminate().catch(() => {});
    }
    console.warn(`[OCR] Local Tesseract OCR failed:`, err.message || err);
    return "";
  } finally {
    releaseOcrLock();
  }
}

export default router;
