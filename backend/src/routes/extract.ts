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
If it is a first year common subject (FY B.Tech / FY ALL), normalize the department to "Computer Engineering" (or look for the branch mentioned in the file/folder name).

Normalize subject to the full readable subject name in Title Case, using standard conjunctions (e.g. "Data Structures and Algorithms", "Basic Electrical and Electronics Engineering"). Expand abbreviations to their full name if known (e.g., "DSA" -> "Data Structures and Algorithms", "DBMS" -> "Database Management Systems", "OOP" -> "Object Oriented Programming").

Normalize semester to an integer from 1 to 8. Look for roman numerals (I->1, II->2, III->3, IV->4, V->5, VI->6, VII->7, VIII->8).

Normalize exam_type to one of: "ESE", "RE-ESE", "Supplementary", "Complementary".
- "End Semester Examination" / "Regular End Semester" / "Regular ESE" -> "ESE"
- "Re End Semester" / "Re-Examination" / "Re-ESE" -> "RE-ESE"
- "Supplementary" / "Supp" -> "Supplementary"
- "Complementary" -> "Complementary"

Normalize academic_year to "YYYY-YY" (e.g. "2024-25").
Normalize exam_date to ISO "YYYY-MM-DD". Set null if not found.
marks is the maximum marks integer (e.g. 60, 70, 75, 80, 100).
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
        const data = await parser.getText({ first: 1 });
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
    "department",
    "semester",
    "academic_year",
    "exam_type",
    "marks",
  ];
  return checkFields.some((f) => !r[f] || r[f].value === null || r[f].confidence < 0.90);
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
    
    // If the API extracted a field with high confidence (>= 80%), trust the API over local heuristic
    if (apiField && apiField.value !== null && apiField.confidence >= 0.80) {
      merged[k] = apiField as any;
      return;
    }
    
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

  // Graphics / Physics / Chemistry
  "EG": "Engineering Graphics",
  "GP": "Graphics",
  "GRAPHICS": "Engineering Graphics",
  "ENGG CHEMISTRY": "Engineering Chemistry",
  "ENGG. CHEM": "Engineering Chemistry",
  "ENGG. PHYSICS": "Engineering Physics",
  "Engg. Physics": "Engineering Physics",
  "Engg. Chemistry": "Engineering Chemistry",
  "PHYSICS": "Engineering Physics",
  "CHEMISTRY": "Engineering Chemistry",
  "Mechanics": "Engineering Mechanics",
  "Comp Engg. Mechanics": "Computational Engineering Mechanics",

  // Misc
  "RM": "Research Methodology",
  "UHV": "Universal Human Values",
  "PLCM": "Product Lifecycle Management",
  "IPR": "Intellectual Property Rights",
  "PFM": "Personal Financial Management",
  "BCM": "Business Communication and Management",
  "CT": "Communication Techniques",
  "CTAK": "Communication Techniques",
  "SPC": "Structured Programming using C",
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
  "MFEE": "Mathematics for Electrical Engineering"
};

const DEPT_ABBRS: Record<string, string[]> = {
  "Computer Engineering": ["cse", "computer engineering", "comp eng", "comp. eng.", "comp"],
  "Information Technology": ["it", "information technology", "infotech"],
  "Mechanical Engineering": ["mech", "mechanical", "mechanical engineering", "mech eng", "mech. eng."],
  "Civil Engineering": ["civil", "civil engineering"],
  "Electrical Engineering": ["electrical", "electrical engineering", "elect"],
  "Electronics and Telecommunication": ["entc", "e&tc", "etc", "et&c", "electronics", "telecommunication"],
  "Artificial Intelligence and Machine Learning": ["aiml", "ai & ml", "ai/ml", "artificial intelligence"],
  "Data Science": ["aids", "data science", "cseds", "ds"],
};

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
  for (const [deptName, abbreviations] of Object.entries(DEPT_ABBRS)) {
    if (lower.includes(deptName.toLowerCase())) {
      return deptName;
    }
    for (const abbr of abbreviations) {
      const regex = new RegExp(`\\b${abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, "i");
      if (regex.test(lower)) {
        return deptName;
      }
    }
  }
  return null;
}

function matchSemester(str: string): number | null {
  const semNumRegex = /\b(?:semester|sem)\s*[:\-]?\s*([1-8])\b/i;
  const semRomanRegex = /\b(?:semester|sem)\s*[:\-]?\s*(I|II|III|IV|V|VI|VII|VIII)\b/i;
  const romanMap: Record<string, number> = {
    I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8
  };

  const numMatch = str.match(semNumRegex);
  if (numMatch) {
    return parseInt(numMatch[1], 10);
  }
  const romanMatch = str.match(semRomanRegex);
  if (romanMatch) {
    return romanMap[romanMatch[1].toUpperCase()] || null;
  }
  return null;
}

function matchAcademicYear(str: string): string | null {
  const yearRegex = /\b(20\d{2})\s*-\s*(20)?(\d{2})\b/;
  const match = str.match(yearRegex);
  if (match) {
    return `${match[1]}-${match[3]}`;
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
  const marksRegex = /\b(?:max\w*\s+marks|maximum\s+marks|marks)\s*[:\-]?\s*(\d{2,3})\b/i;
  const match = str.match(marksRegex);
  if (match) {
    return parseInt(match[1], 10);
  }
  const genericMatch = str.match(/\b(50|60|65|70|75|80|100)\b/);
  if (genericMatch) {
    return parseInt(genericMatch[1], 10);
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
  if (!filename) return result;

  const fnClean = filename.replace(/\.pdf$/i, "").replace(/[\_\-]+/g, " ").trim();

  // Try alias lookup first (abbreviations like BEEDE, DSA, EM-III)
  const alias = lookupSubjectAlias(fnClean, dynamicAliases);
  if (alias) {
    result.subject = { value: alias, confidence: 0.70 };
  }

  // If no alias matched, try extracting a full subject name from the filename
  // Patterns: "QP 75 AIML SEM 3 Engineering Mathematics III"
  //           "ENGG CHEMISTRY QP"
  //           "Machine Learning comp QP"
  //           "AK SY MECH SEM III Manufacturing Processes 12.01.2024"
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
    if (subjectCandidate.length >= 3 && subjectCandidate.length <= 80) {
      // Check if this matches a known subject from the alias table values
      const lowerCandidate = subjectCandidate.toLowerCase();
      let foundAlias = false;
      for (const fullName of Object.values(SUBJECTS_ALIASES)) {
        if (fullName.toLowerCase() === lowerCandidate || lowerCandidate.includes(fullName.toLowerCase())) {
          result.subject = { value: fullName, confidence: 0.70 };
          foundAlias = true;
          break;
        }
      }
      if (!foundAlias && subjectCandidate.length >= 5) {
        // Title-case it
        const titleCased = subjectCandidate
          .split(" ")
          .filter(w => w.length > 0)
          .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
          .join(" ");
        if (titleCased.length >= 5) {
          result.subject = { value: titleCased, confidence: 0.40 };
        }
      }
    }
  }

  const matchedDept = matchDepartment(fnClean);
  if (matchedDept) {
    result.department = { value: matchedDept, confidence: 0.50 };
  }

  const matchedSem = matchSemester(fnClean);
  if (matchedSem) {
    result.semester = { value: matchedSem, confidence: 0.50 };
  }

  const matchedYear = matchAcademicYear(fnClean);
  if (matchedYear) {
    result.academic_year = { value: matchedYear, confidence: 0.50 };
  }

  const matchedExamType = matchExamType(fnClean);
  if (matchedExamType) {
    result.exam_type = { value: matchedExamType, confidence: 0.50 };
  }

  const matchedMarks = matchMarks(fnClean);
  if (matchedMarks) {
    result.marks = { value: matchedMarks, confidence: 0.50 };
  }

  const matchedCode = matchSubjectCode(fnClean);
  if (matchedCode) {
    result.subject_code = { value: matchedCode, confidence: 0.50 };
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
  const dynamicAliases: Record<string, string> = {};
  try {
    const { data: dbAliases } = await supabase.from("learned_aliases").select("alias, full_name");
    if (dbAliases) {
      for (const item of dbAliases) {
        dynamicAliases[item.alias.toUpperCase()] = item.full_name;
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
  try {
    const { data: depts } = await supabase.from("departments").select("name");
    if (depts && depts.length > 0) {
      let matchedDept = null;
      for (const d of depts) {
        const dName = d.name.toLowerCase().trim();
        if (textToScan.toLowerCase().includes(dName)) {
          matchedDept = d.name;
          textResult.department = { value: d.name, confidence: 0.70 };
          break;
        }
      }

      if (!matchedDept) {
        for (const d of depts) {
          const abbrs = DEPT_ABBRS[d.name];
          if (abbrs) {
            for (const abbr of abbrs) {
              const regex = new RegExp(`\\b${abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, "i");
              if (regex.test(textToScan)) {
                matchedDept = d.name;
                textResult.department = { value: d.name, confidence: 0.70 };
                break;
              }
            }
          }
          if (matchedDept) break;
        }
      }
    }
  } catch (e) {
    console.error("Local dept query failed:", e);
  }

  // -- Semester --
  const semNumMatch = normalizedText.match(/\b(?:semester|sem)\s*[:\-]?\s*([1-8])\b/i);
  const semRomanMatch = normalizedText.match(/\b(?:semester|sem)\s*[:\-]?\s*(I|II|III|IV|V|VI|VII|VIII)\b/i);
  const romanMap: Record<string, number> = {
    I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8
  };

  if (semNumMatch) {
    textResult.semester = { value: parseInt(semNumMatch[1], 10), confidence: 0.70 };
  } else if (semRomanMatch) {
    const romanVal = semRomanMatch[1].toUpperCase();
    if (romanMap[romanVal]) {
      textResult.semester = { value: romanMap[romanVal], confidence: 0.70 };
    }
  }

  // -- Academic Year --
  const yearMatch = normalizedText.match(/\b(20\d{2})\s*-\s*(20)?(\d{2})\b/);
  if (yearMatch) {
    textResult.academic_year = { value: `${yearMatch[1]}-${yearMatch[3]}`, confidence: 0.70 };
  }

  // -- Exam Type --
  const examTypePatterns = [
    { type: "RE-ESE" as const, regex: /\b(?:re\s*-\s*ese|re\s*ese|re\s*-\s*exam|re\s*exam|\\bre\\b)\b/i },
    { type: "ESE" as const, regex: /\b(?:ese|end\s*semester|regular\s*end\s*semester|regular\s*ese)\b/i },
    { type: "Supplementary" as const, regex: /\b(?:supplementary|supp)\b/i },
    { type: "Complementary" as const, regex: /\b(?:complementary|comp)\b/i }
  ];

  for (const et of examTypePatterns) {
    if (et.regex.test(normalizedText)) {
      textResult.exam_type = { value: et.type, confidence: 0.70 };
      break;
    }
  }

  // -- Marks --
  const marksMatch = normalizedText.match(/\b(?:max\w*\s+marks|maximum\s+marks|marks)\s*[:\-]?\s*(\d{2,3})\b/i);
  if (marksMatch) {
    textResult.marks = { value: parseInt(marksMatch[1], 10), confidence: 0.70 };
  }

  // -- Subject Code --
  const codeRegexExplicit = /(?:subject|course)\s+code\s*[:\-]?\s*\b([A-Z0-9\-]+)\b/i;
  const genericCodeRegex = /\b([A-Z]{2,4}\s*\d{3,4}[A-Z]?)\b/;

  const explicitMatch = normalizedText.match(codeRegexExplicit);
  if (explicitMatch) {
    textResult.subject_code = { value: explicitMatch[1].toUpperCase(), confidence: 0.70 };
  } else {
    const genericMatch = normalizedText.match(genericCodeRegex);
    if (genericMatch) {
      textResult.subject_code = { value: genericMatch[1].replace(/\s+/g, "").toUpperCase(), confidence: 0.70 };
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
    textResult.exam_date = { value: matchedDateStr, confidence: 0.70 };
    if (matchedMonth) {
      textResult.exam_month = { value: matchedMonth, confidence: 0.70 };
    }
    if (matchedYearVal) {
      textResult.exam_year = { value: matchedYearVal, confidence: 0.70 };
    }
  } else {
    const monthYearRegex = /\b([A-Za-z]+)\s+(20\d{2})\b/;
    const myMatch = normalizedText.match(monthYearRegex);
    if (myMatch) {
      const monthName = myMatch[1].toLowerCase();
      const monthCode = monthMap[monthName];
      if (monthCode) {
        const fullMonth = myMatch[1].charAt(0).toUpperCase() + myMatch[1].slice(1);
        textResult.exam_month = { value: fullMonth, confidence: 0.70 };
        textResult.exam_year = { value: parseInt(myMatch[2], 10), confidence: 0.70 };
      }
    }
  }

  // -- Subject Name --
  try {
    const { data: subjects } = await supabase.from("subjects").select("name");
    if (subjects && subjects.length > 0) {
      let matchedSubject = null;
      for (const s of subjects) {
        const sName = s.name.toLowerCase().trim();
        if (textToScan.toLowerCase().includes(sName)) {
          matchedSubject = s.name;
          textResult.subject = { value: s.name, confidence: 0.75 };
          break;
        }
      }

      if (!matchedSubject) {
        const alias = lookupSubjectAlias(textToScan);
        if (alias) {
          const dbMatch = subjects.find(s => s.name.toLowerCase() === alias.toLowerCase());
          if (dbMatch) {
            matchedSubject = dbMatch.name;
            textResult.subject = { value: dbMatch.name, confidence: 0.75 };
          } else {
            matchedSubject = alias;
            textResult.subject = { value: alias, confidence: 0.60 };
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
          textResult.subject = { value: cleanedSub, confidence: 0.50 };
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

export async function ocrViaTesseract(pdfBuffer: Buffer): Promise<string> {
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
    const worker = await createWorker("eng");
    const { data: { text } } = await worker.recognize(buffer);
    await worker.terminate();
    
    console.log(`[OCR] Tesseract successfully extracted ${text.length} chars.`);
    return text;
  } catch (err: any) {
    console.warn(`[OCR] Local Tesseract OCR failed:`, err.message || err);
    return "";
  }
}

export default router;
