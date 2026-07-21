import { Router, type Response } from "express";
import { PDFParse } from "pdf-parse";
import { getSupabaseAdmin } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/admin.js";
import type { AuthenticatedRequest, ExtractionResult, ExtractionField } from "../types.js";
import { localExtract, needsAi, mergeResults, SYSTEM_PROMPT, parseExtraction, ocrViaTesseract } from "./extract.js";
import crypto from "crypto";

const router = Router();

// Track active jobs in memory to prevent duplicate runner instantiation
const activeJobRunners = new Set<string>();

function extractFolderId(url: string): string | null {
  if (!url) return null;
  const match = url.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

type DocumentType = "Question Paper" | "Answer Key" | "Timetable" | "Notice" | "Circular" | "Syllabus" | "Unknown";

function classifyFile(filename: string, folderPath: string, text: string): DocumentType {
  const nameLower = filename.toLowerCase();
  const pathLower = folderPath.toLowerCase();
  const textLower = text.slice(0, 1000).toLowerCase();
  const combined = `${nameLower} ${pathLower} ${textLower}`;

  // --- Non-exam documents (check first so they get skipped) ---
  const timetableKeywords = ["time table", "timetable", "time-table", "exam schedule", "examination schedule"];
  for (const kw of timetableKeywords) {
    if (combined.includes(kw)) return "Timetable";
  }

  const noticeKeywords = ["notice", "notification", "important notice"];
  if (/\bnotice\b|\bnotification\b/.test(nameLower) || /\bnotice\b/.test(pathLower.split("/").pop() || "")) {
    return "Notice";
  }

  if (/\bcircular\b/.test(nameLower) || /\bcircular\b/.test(pathLower.split("/").pop() || "")) {
    return "Circular";
  }

  const syllabusKeywords = ["syllabus", "course outline", "curriculum", "course structure"];
  for (const kw of syllabusKeywords) {
    if (nameLower.includes(kw) || (pathLower.split("/").pop() || "").includes(kw)) return "Syllabus";
  }

  // --- Answer Key detection ---
  const akKeywords = ["solution", "answer key", "solved paper", "soln", "solutions", "answer-key", "answer_key", "marking scheme"];
  const qpKeywords = ["question paper", "question-paper", "question_paper", "synoptics"];

  const pathParts = pathLower.split("/");
  const lastPathPart = pathParts[pathParts.length - 1] || "";
  const secondLastPathPart = pathParts[pathParts.length - 2] || "";

  if (lastPathPart.includes("solution") || lastPathPart.includes("answer") || secondLastPathPart.includes("solution")) {
    return "Answer Key";
  }
  if (lastPathPart.includes("question") || /\bqp\b/.test(lastPathPart) || secondLastPathPart.includes("question")) {
    return "Question Paper";
  }

  // Check filename for AK markers (must check before QP because "ak" is shorter)
  if (/\bak\b/.test(nameLower)) return "Answer Key";
  for (const keyword of akKeywords) {
    if (nameLower.includes(keyword)) return "Answer Key";
  }

  // Check filename for QP markers
  if (/\bqp\b/.test(nameLower)) return "Question Paper";
  for (const keyword of qpKeywords) {
    if (nameLower.includes(keyword)) return "Question Paper";
  }

  // Check text content
  if (textLower.includes("scheme of valuation") || textLower.includes("answer key") || textLower.includes("marking scheme")) {
    return "Answer Key";
  }
  if (textLower.includes("question paper") || textLower.includes("maximum marks") || textLower.includes("max. marks")) {
    return "Question Paper";
  }

  // If the filename has typical exam paper patterns (marks + dept + sem + subject), classify as QP
  if (/\b(50|60|65|70|75|80|100)\b/.test(nameLower) && /\bsem\b/i.test(nameLower)) {
    return "Question Paper";
  }

  return "Unknown";
}

function pickHighestConf<T>(
  fieldQP: ExtractionField<T> | undefined | null,
  fieldAK: ExtractionField<T> | undefined | null,
  fallback?: T | null
): T | null {
  const valQP = fieldQP?.value;
  const valAK = fieldAK?.value;
  const confQP = (valQP !== null && valQP !== undefined) ? (fieldQP?.confidence ?? 0) : -1;
  const confAK = (valAK !== null && valAK !== undefined) ? (fieldAK?.confidence ?? 0) : -1;

  if (confQP >= confAK && confQP > 0) {
    return valQP as T;
  }
  if (confAK > confQP && confAK > 0) {
    return valAK as T;
  }
  return fallback !== undefined ? fallback : null;
}

function calculateMatchScore(qp: any, ak: any): number {
  // 1. Semester guardrail
  if (
    qp.metadata.semester?.value && 
    ak.metadata.semester?.value && 
    qp.metadata.semester.value !== ak.metadata.semester.value
  ) {
    return 0; // Mismatched semesters can never be paired!
  }

  // 2. Department guardrail
  if (
    qp.metadata.department?.value && 
    ak.metadata.department?.value && 
    qp.metadata.department.value !== ak.metadata.department.value
  ) {
    return 0; // Mismatched departments can never be paired!
  }

  // 3. Subject Code guardrail
  const qpCode = (qp.metadata.subject_code?.value || "").toUpperCase().replace(/\s+/g, "");
  const akCode = (ak.metadata.subject_code?.value || "").toUpperCase().replace(/\s+/g, "");
  if (qpCode && akCode && qpCode !== akCode) {
    return 0; // Mismatched known course codes can never be paired!
  }

  // 4. Subject Name guardrail
  const qpSub = (qp.metadata.subject?.value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const akSub = (ak.metadata.subject?.value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const isQpSubKnown = qpSub && qpSub !== "unknownsubject";
  const isAkSubKnown = akSub && akSub !== "unknownsubject";
  
  let subjectScore = 0;
  if (isQpSubKnown && isAkSubKnown) {
    if (qpSub === akSub) {
      subjectScore = 30;
    } else if (qpSub.includes(akSub) || akSub.includes(qpSub)) {
      subjectScore = 15;
    } else {
      return 0; // Mismatched known subjects can never be paired!
    }
  }

  // 5. Academic Year guardrail (if both high confidence >= 0.70 and different, reject)
  const qpYear = qp.metadata?.academic_year;
  const akYear = ak.metadata?.academic_year;
  if (
    qpYear?.value && akYear?.value &&
    (qpYear.confidence ?? 0) >= 0.70 && (akYear.confidence ?? 0) >= 0.70 &&
    qpYear.value !== akYear.value
  ) {
    return 0; // Mismatched high-confidence academic years can never be paired!
  }

  // 6. Exam Type guardrail (if both high confidence >= 0.70 and different, reject)
  const qpExam = qp.metadata?.exam_type;
  const akExam = ak.metadata?.exam_type;
  if (
    qpExam?.value && akExam?.value &&
    (qpExam.confidence ?? 0) >= 0.70 && (akExam.confidence ?? 0) >= 0.70 &&
    qpExam.value !== akExam.value
  ) {
    return 0; // Mismatched high-confidence exam types can never be paired!
  }

  let score = 0;

  // Proximity of parent folder
  const qpPathClean = qp.path.replace(/\b(question\s*papers?|question|qp|solutions?|answers?|ak)\b/ig, "").replace(/\/+/g, "/").trim();
  const akPathClean = ak.path.replace(/\b(question\s*papers?|question|qp|solutions?|answers?|ak)\b/ig, "").replace(/\/+/g, "/").trim();
  if (qpPathClean && qpPathClean === akPathClean) {
    score += 20;
  }

  // Add subject score
  score += subjectScore;

  // Filename Similarity
  const cleanName = (name: string) => name.toLowerCase()
    .replace(/\.pdf$/i, "")
    .replace(/\b(solution|soln|solved|answer|key|qp|question|paper|ak)\b/ig, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
  const qpNameClean = cleanName(qp.name);
  const akNameClean = cleanName(ak.name);
  if (qpNameClean && qpNameClean === akNameClean) {
    score += 15;
  } else if (qpNameClean && akNameClean && (qpNameClean.includes(akNameClean) || akNameClean.includes(qpNameClean))) {
    score += 8;
  }

  // Fuzzy filename matching (word intersection)
  const getWords = (name: string) => name.toLowerCase()
    .replace(/\.pdf$/i, "")
    .split(/[\s\-\_\.]+/);
  const qpWords = getWords(qp.name).filter(w => w.length > 2 && !["solution", "soln", "solved", "answer", "key", "qp", "question", "paper", "ak"].includes(w));
  const akWords = getWords(ak.name).filter(w => w.length > 2 && !["solution", "soln", "solved", "answer", "key", "qp", "question", "paper", "ak"].includes(w));
  
  if (qpWords.length > 0 && akWords.length > 0) {
    let intersectCount = 0;
    for (const qw of qpWords) {
      if (akWords.includes(qw)) intersectCount++;
    }
    const overlapRatio = intersectCount / Math.max(qpWords.length, akWords.length);
    if (overlapRatio > 0.6) {
      score += 10;
    }
  }

  // Subject code match score
  if (qpCode && qpCode === akCode) {
    score += 25;
  }

  // Context matches
  if (qp.metadata.academic_year?.value && qp.metadata.academic_year?.value === ak.metadata.academic_year?.value) {
    score += 10;
  }

  if (qp.metadata.exam_type?.value && qp.metadata.exam_type?.value === ak.metadata.exam_type?.value) {
    score += 10;
  }

  if (qp.metadata.semester?.value && qp.metadata.semester?.value === ak.metadata.semester?.value) {
    score += 15;
  }

  if (qp.metadata.department?.value && qp.metadata.department?.value === ak.metadata.department?.value) {
    score += 10;
  }

  return score;
}



async function extractMetadataViaGemini(
  pdfBase64: string,
  filename: string,
  highConfFields: any
): Promise<any> {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    throw new Error("GEMINI_API_KEY is not configured in .env");
  }

  const model = process.env.GEMINI_MODEL || "gemini-flash-latest";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;

  const prompt = `${SYSTEM_PROMPT}\n\nHere are the already extracted high-confidence fields: ${JSON.stringify(
    highConfFields
  )}. Please extract the remaining fields from the attached PDF.`;

  const contents = [
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

  const body = (await response.json()) as any;
  const raw = body.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return parseExtraction(raw);
}

interface DriveFileMetadata {
  id: string;
  name: string;
  size?: number;
  webViewLink?: string;
  path: string;
  modifiedTime?: string;
  createdTime?: string;
  md5Checksum?: string;
}

async function fetchExistingPapersForFiles(fileIds: string[]) {
  const supabaseAdmin = getSupabaseAdmin();
  const dbPapersMap = new Map<string, { paper: any; role: "qp" | "ak" }>();
  
  if (fileIds.length === 0) return dbPapersMap;

  const chunkSize = 50; // Reduced from 500 to prevent Headers Overflow Error (PGRST / URL limits)
  const chunks: string[][] = [];
  for (let i = 0; i < fileIds.length; i += chunkSize) {
    chunks.push(fileIds.slice(i, i + chunkSize));
  }

  // Fetch QP matches and AK matches in parallel for all chunks
  await Promise.all(
    chunks.map(async (chunk) => {
      const qpPromise = supabaseAdmin
        .from("papers")
        .select("id, subject, department, semester, academic_year, exam_type, marks, exam_date, question_paper_file_id, question_paper_checksum, question_paper_modified_time, question_paper_size, answer_key_file_id, answer_key_checksum, answer_key_modified_time, answer_key_size")
        .in("question_paper_file_id", chunk);

      const akPromise = supabaseAdmin
        .from("papers")
        .select("id, subject, department, semester, academic_year, exam_type, marks, exam_date, question_paper_file_id, question_paper_checksum, question_paper_modified_time, question_paper_size, answer_key_file_id, answer_key_checksum, answer_key_modified_time, answer_key_size")
        .in("answer_key_file_id", chunk);

      const [qpResult, akResult] = await Promise.all([qpPromise, akPromise]);

      if (qpResult.error) {
        console.error("fetchExistingPapersForFiles QP error:", qpResult.error);
      } else if (qpResult.data) {
        for (const p of qpResult.data) {
          if (p.question_paper_file_id) {
            dbPapersMap.set(p.question_paper_file_id, { paper: p, role: "qp" });
          }
        }
      }

      if (akResult.error) {
        console.error("fetchExistingPapersForFiles AK error:", akResult.error);
      } else if (akResult.data) {
        for (const p of akResult.data) {
          if (p.answer_key_file_id) {
            dbPapersMap.set(p.answer_key_file_id, { paper: p, role: "ak" });
          }
        }
      }
    })
  );
  
  return dbPapersMap;
}

async function listPdfFilesRecursively(
  folderId: string,
  accessToken: string,
  onFolderScanned: (count: number) => void
): Promise<Array<DriveFileMetadata>> {
  const files: Array<DriveFileMetadata> = [];
  const visited = new Set<string>();

  const scanFolder = async (id: string, path: string) => {
    if (visited.has(id)) return;
    visited.add(id);

    let nextPageToken: string | undefined;
    const subfolders: Array<{ id: string; name: string }> = [];

    do {
      const q = `'${id}' in parents and trashed = false and (mimeType = 'application/vnd.google-apps.folder' or mimeType = 'application/pdf')`;
      const url = new URL("https://www.googleapis.com/drive/v3/files");
      url.searchParams.append("q", q);
      url.searchParams.append("fields", "nextPageToken, files(id, name, mimeType, size, webViewLink, parents, modifiedTime, createdTime, md5Checksum)");
      url.searchParams.append("pageSize", "1000");
      if (nextPageToken) {
        url.searchParams.append("pageToken", nextPageToken);
      }

      const response = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Google API returned status ${response.status}: ${errText.slice(0, 150)}`);
      }

      const data = (await response.json()) as {
        nextPageToken?: string;
        files: Array<{
          id: string;
          name: string;
          mimeType: string;
          size?: string;
          webViewLink?: string;
          modifiedTime?: string;
          createdTime?: string;
          md5Checksum?: string;
        }>;
      };

      for (const file of data.files) {
        if (file.mimeType === "application/vnd.google-apps.folder") {
          subfolders.push({ id: file.id, name: file.name });
        } else if (file.mimeType === "application/pdf") {
          const sizeBytes = file.size ? parseInt(file.size, 10) : undefined;
          files.push({
            id: file.id,
            name: file.name,
            size: sizeBytes,
            webViewLink: file.webViewLink,
            path,
            modifiedTime: file.modifiedTime,
            createdTime: file.createdTime,
            md5Checksum: file.md5Checksum,
          });
        }
      }
      nextPageToken = data.nextPageToken;
    } while (nextPageToken);

    onFolderScanned(files.length);

    // Scan subfolders concurrently with a concurrency limit of 5
    const chunkLimit = 5;
    for (let i = 0; i < subfolders.length; i += chunkLimit) {
      const chunk = subfolders.slice(i, i + chunkLimit);
      await Promise.all(
        chunk.map((sf) => {
          const subPath = path ? `${path}/${sf.name}` : sf.name;
          return scanFolder(sf.id, subPath);
        })
      );
    }
  };

  await scanFolder(folderId, "");
  return files;
}

// Background Queue Processor — Production Optimized
async function processQueue(jobId: string, googleAccessToken: string) {
  if (activeJobRunners.has(jobId)) return;
  activeJobRunners.add(jobId);

  const supabaseAdmin = getSupabaseAdmin();

  try {
    // 1. Fetch pending items
    const { data: items, error: fetchErr } = await supabaseAdmin
      .from("bulk_import_items")
      .select("*")
      .eq("job_id", jobId)
      .eq("status", "pending");

    if (fetchErr) throw fetchErr;

    if (!items || items.length === 0) {
      // Finalize pairing and matching
      await finalizeMatchedResults(jobId);
      activeJobRunners.delete(jobId);
      return;
    }

    // Get total items count (all statuses) for unified progress
    const totalFilesQuery = await supabaseAdmin
      .from("bulk_import_items")
      .select("id", { count: "exact", head: true })
      .eq("job_id", jobId);
    const totalFilesCount = totalFilesQuery.count || items.length;

    // Get already-done count for accurate progress on resume
    const doneQuery = await supabaseAdmin
      .from("bulk_import_items")
      .select("id", { count: "exact", head: true })
      .eq("job_id", jobId)
      .in("status", ["completed", "failed", "skipped"]);
    const alreadyDoneCount = doneQuery.count || 0;

    // Update job to processing
    await supabaseAdmin
      .from("bulk_import_jobs")
      .update({
        status: "processing",
        current_step: `Extracting metadata from PDFs...`,
        progress: Math.min(Math.round(10 + (alreadyDoneCount / totalFilesCount) * 75), 85),
        stats: {
          processed: alreadyDoneCount,
          total: totalFilesCount,
          pending: items.length,
        },
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId);

    // ===== Optimized Queue Setup =====
    const pendingQueue = [...items];
    const concurrencyLimit = 5; // Up from 2
    const geminiSemaphoreMax = 2; // Limit concurrent Gemini calls
    let geminiActiveCount = 0;
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    // In-memory progress tracking (avoid per-item DB queries)
    let processedCount = alreadyDoneCount;
    let lastProgressUpdate = Date.now();
    const PROGRESS_INTERVAL_MS = 5000; // Update DB every 5 seconds
    const PROGRESS_BATCH_SIZE = 10; // Or every 10 items

    // Shared job-status flag (polled every 5s instead of per-item)
    let jobShouldStop = false;
    const statusPollInterval = setInterval(async () => {
      try {
        const { data: jobStatus } = await supabaseAdmin
          .from("bulk_import_jobs")
          .select("status")
          .eq("id", jobId)
          .single();
        if (!jobStatus || jobStatus.status === "paused" || jobStatus.status === "cancelled") {
          jobShouldStop = true;
        }
      } catch {
        // Ignore polling errors
      }
    }, 5000);

    // Helper to compute average confidence of core fields
    const avgConfidence = (result: ExtractionResult): number => {
      const coreFields: Array<keyof ExtractionResult> = ["subject", "department", "semester", "academic_year", "exam_type"];
      let total = 0;
      for (const f of coreFields) {
        const val = result[f];
        total += val ? val.confidence : 0;
      }
      return total / coreFields.length;
    };

    // Helper to flush progress to DB
    const flushProgress = async (force = false) => {
      const now = Date.now();
      const itemsSinceLastUpdate = processedCount - alreadyDoneCount;
      if (!force && itemsSinceLastUpdate % PROGRESS_BATCH_SIZE !== 0 && now - lastProgressUpdate < PROGRESS_INTERVAL_MS) {
        return;
      }
      const progressPercent = Math.min(Math.round(10 + (processedCount / totalFilesCount) * 75), 85);
      await supabaseAdmin
        .from("bulk_import_jobs")
        .update({
          progress: progressPercent,
          current_step: `Processed ${processedCount}/${totalFilesCount} files...`,
          stats: {
            processed: processedCount,
            total: totalFilesCount,
            pending: totalFilesCount - processedCount,
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", jobId);
      lastProgressUpdate = now;
    };

    // Gemini retry with exponential backoff
    const callGeminiWithRetry = async (
      pdfBase64: string,
      fileName: string,
      highConfFields: any,
      maxRetries = 3
    ): Promise<any> => {
      let delayMs = 2000;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const result = await extractMetadataViaGemini(pdfBase64, fileName, highConfFields);
          return result;
        } catch (err: any) {
          const is429 = err?.message?.includes("429") || err?.message?.includes("quota");
          if (is429 && attempt < maxRetries - 1) {
            console.log(`[Gemini] 429 Rate Limit. Retrying in ${delayMs}ms (Attempt ${attempt + 1}/${maxRetries})`);
            await delay(delayMs);
            delayMs *= 2;
            continue;
          }
          throw err;
        }
      }
    };

    // Gemini semaphore acquire/release
    const acquireGeminiSlot = async () => {
      while (geminiActiveCount >= geminiSemaphoreMax) {
        await delay(200);
      }
      geminiActiveCount++;
    };
    const releaseGeminiSlot = () => {
      geminiActiveCount--;
    };

    const worker = async () => {
      while (pendingQueue.length > 0) {
        // Check shared stop flag (no DB query per iteration)
        if (jobShouldStop) {
          console.log(`[Worker] Stopping — job flagged for pause/cancel`);
          break;
        }

        const item = pendingQueue.shift();
        if (!item) break;

        // Update item status to processing
        await supabaseAdmin
          .from("bulk_import_items")
          .update({ status: "processing" })
          .eq("id", item.id);

        let localText = "";
        let finalResult: ExtractionResult | null = null;
        let fileBuffer: Buffer | null = null;
        let extractionError = "";
        let usedAi = false;
        let downloadSkipped = false;

        try {
          // ===== PHASE 2: Download + Text Extraction (Always download to ensure accuracy) =====
          const downloadUrl = `https://www.googleapis.com/drive/v3/files/${item.file_id}?alt=media`;
          const downloadRes = await fetch(downloadUrl, {
            headers: { Authorization: `Bearer ${googleAccessToken}` },
          });
          if (!downloadRes.ok) {
            throw new Error(`Download failed: ${downloadRes.statusText}`);
          }
          const arrayBuffer = await downloadRes.arrayBuffer();
          fileBuffer = Buffer.from(arrayBuffer);

          // Parse text locally (first 2 pages for metadata coverage)
          const parser = new PDFParse({ data: fileBuffer });
          const textData = await parser.getText({ first: 2 });
          await parser.destroy();
          localText = textData.text || "";

          // Full local extraction with text + filename + folder path
          finalResult = await localExtract(localText, item.name, item.path);

          // Level 4 OCR fallback if text is extremely short (< 100 chars)
          if (localText.trim().length < 100 && fileBuffer) {
            console.log(`[OCR] Scanned PDF detected for ${item.name} (${localText.trim().length} chars). Running local Tesseract OCR...`);
            try {
              const ocrText = await ocrViaTesseract(fileBuffer);
              if (ocrText && ocrText.trim().length >= 50) {
                console.log(`[OCR] Tesseract extracted ${ocrText.trim().length} chars for ${item.name}. Re-running local extraction.`);
                localText = ocrText;
                finalResult = await localExtract(localText, item.name, item.path);
              }
            } catch (ocrErr) {
              console.error(`Tesseract OCR failed for ${item.name}:`, ocrErr);
            }
          }
        } catch (err: any) {
          console.error(`Error processing file ${item.name}:`, err);
          extractionError = err instanceof Error ? err.message : String(err);
        }

        if (!finalResult) {
          finalResult = {
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
        }

        const classification = classifyFile(item.name, item.path, localText);

        // Compute average confidence for Gemini gating and metadata
        const currentConf = avgConfidence(finalResult);
        const needsAiExtraction = currentConf < 0.70 && needsAi(finalResult);

        // Mark low-confidence items for review
        if (currentConf < 0.70) {
          (finalResult as any)._needs_review = true;
        }

        // ===== PHASE 3: Gemini AI Extraction (only when truly needed) =====
        if (needsAiExtraction && fileBuffer) {
          const geminiApiKey = process.env.GEMINI_API_KEY;
          if (geminiApiKey) {
            try {
              await acquireGeminiSlot();
              try {
                // Small delay between Gemini calls to respect rate limits
                await delay(500);

                const pdfBase64 = fileBuffer.toString("base64");
                const highConfFields: any = {};
                Object.keys(finalResult).forEach((key) => {
                  if (key.startsWith("_")) return;
                  const field = finalResult![key as keyof ExtractionResult];
                  if (field && field.confidence >= 0.85) {
                    highConfFields[key] = field.value;
                  }
                });

                const apiResult = await callGeminiWithRetry(pdfBase64, item.name, highConfFields);
                if (apiResult) {
                  finalResult = mergeResults(finalResult!, apiResult);
                  usedAi = true;
                  // Re-check confidence after AI merge
                  const newConf = avgConfidence(finalResult!);
                  if (newConf >= 0.70) {
                    (finalResult as any)._needs_review = false;
                  }
                }
              } finally {
                releaseGeminiSlot();
              }
            } catch (geminiErr: any) {
              // NEVER fail the import because of Gemini errors
              const errMsg = geminiErr?.message || String(geminiErr);
              const isQuotaOrTransient = /429|403|500|timeout|quota|ECONNREFUSED|ENOTFOUND|fetch failed/i.test(errMsg);
              if (isQuotaOrTransient) {
                console.warn(`[Gemini] Transient error for ${item.name}: ${errMsg}. Saving with local metadata.`);
              } else {
                console.error(`[Gemini] Unexpected error for ${item.name}:`, geminiErr);
              }
              (finalResult as any)._needs_review = true;
            }
          } else {
            // No Gemini key configured — save with local data, mark for review
            (finalResult as any)._needs_review = true;
          }
        }

        // Pre-compute confidence percentage for the dashboard
        const finalConf = avgConfidence(finalResult!);
        const confidencePercent = Math.round(finalConf * 100);

        // Merge drive sync tracking metadata
        const finalMetadata = {
          ...finalResult,
          averageConfidence: confidencePercent,
          downloadSkipped,
          isUpdate: item.metadata?.isUpdate || false,
          existingPaperId: item.metadata?.existingPaperId || null,
          role: item.metadata?.role || null,
          drive_checksum: item.metadata?.drive_checksum || null,
          drive_modified_time: item.metadata?.drive_modified_time || null,
          drive_size: item.size || null,
        };

        // Update item in database — ALWAYS completed, never failed due to AI
        await supabaseAdmin
          .from("bulk_import_items")
          .update({
            status: "completed",
            metadata: finalMetadata,
            type: classification,
            error: extractionError || null,
            used_ai: usedAi,
          })
          .eq("id", item.id);

        // Update in-memory progress and batch-flush to DB
        processedCount++;
        await flushProgress();

        // Minimal yield to avoid event loop starvation (50ms instead of 1000ms)
        await delay(50);
      }
    };

    // Run parallel workers
    const workers = Array(concurrencyLimit).fill(null).map(worker);
    await Promise.all(workers);

    // Stop status polling
    clearInterval(statusPollInterval);

    // Final progress flush
    await flushProgress(true);

    // Finalize matched results if job completed fully without pause/cancel
    const { data: checkJob } = await supabaseAdmin
      .from("bulk_import_jobs")
      .select("status")
      .eq("id", jobId)
      .single();

    if (checkJob && checkJob.status === "processing") {
      await finalizeMatchedResults(jobId);
    }

  } catch (err) {
    console.error("Queue execution error:", err);
    await supabaseAdmin
      .from("bulk_import_jobs")
      .update({
        status: "failed",
        current_step: "Extraction failed.",
        error: err instanceof Error ? err.message : String(err),
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId);
  } finally {
    activeJobRunners.delete(jobId);
  }
}

// Helper: Pair Question Papers and Answer Keys, detect duplicates and complete the job
async function finalizeMatchedResults(jobId: string) {
  const supabaseAdmin = getSupabaseAdmin();

  // Update progress
  await supabaseAdmin
    .from("bulk_import_jobs")
    .update({
      current_step: "Matching and resolving duplicates...",
      progress: 90,
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId);

  // Fetch all completed/skipped items for this job
  const { data: items } = await supabaseAdmin
    .from("bulk_import_items")
    .select("*")
    .eq("job_id", jobId);

  if (!items || items.length === 0) {
    await supabaseAdmin
      .from("bulk_import_jobs")
      .update({
        status: "completed",
        progress: 100,
        current_step: "Completed. No items found.",
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId);
    return;
  }

  const qps = items.filter((r) => r.type === "Question Paper" && r.status === "completed");
  const aks = items.filter((r) => r.type === "Answer Key" && r.status === "completed");
  const unknowns = items.filter((r) => r.type === "Unknown" && r.status === "completed");
  const skippedItems = items.filter((r) => r.status === "skipped");

  // Fetch existing papers from DB that match the subjects of processed items
  const subjectsInBatch = Array.from(new Set(
    items.map(item => item.metadata?.subject?.value).filter(Boolean)
  ));
  
  let dbPapers: any[] = [];
  if (subjectsInBatch.length > 0) {
    const { data } = await supabaseAdmin
      .from("papers")
      .select("*")
      .in("subject", subjectsInBatch);
    if (data) dbPapers = data;
  }

  const matchedPapers: any[] = [];
  const usedAkIds = new Set<string>();

  // Helper to normalize string for comparison
  const norm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  // Helper to find existing paper in DB by metadata
  const findDbPaperByMeta = (meta: any) => {
    return dbPapers.find(p => 
      norm(p.subject) === norm(meta.subject?.value) &&
      norm(p.department) === norm(meta.department?.value) &&
      p.semester === Number(meta.semester?.value) &&
      norm(p.academic_year) === norm(meta.academic_year?.value) &&
      norm(p.exam_type) === norm(meta.exam_type?.value) &&
      p.marks === Number(meta.marks?.value)
    );
  };

  // Process Question Papers
  for (const qp of qps) {
    const qpMeta = qp.metadata;
    let isUpdate = qpMeta.isUpdate === true;
    let existingPaperId = qpMeta.existingPaperId || null;
    let dbPaper = existingPaperId ? dbPapers.find(p => p.id === existingPaperId) : null;

    if (!dbPaper) {
      // Try to find matching paper by metadata in DB (in case of duplicate or un-tracked file ID)
      dbPaper = findDbPaperByMeta(qpMeta);
      if (dbPaper) {
        isUpdate = true;
        existingPaperId = dbPaper.id;
      }
    }

    // Try to find a matching Answer Key in the current batch
    let bestAk: any = null;
    let bestScore = -1;

    for (const ak of aks) {
      if (usedAkIds.has(ak.id)) continue;
      const score = calculateMatchScore(qp, ak);
      // Auto pair if score >= 20
      if (score >= 20 && score > bestScore) {
        bestScore = score;
        bestAk = ak;
      }
    }

    const needsReview =
      qpMeta._needs_review === true ||
      bestAk?.metadata?._needs_review === true ||
      !qpMeta.subject?.value ||
      qpMeta.subject?.value === "Unknown Subject" ||
      qpMeta.department?.value === "Unknown";

    let status = "Ready";
    if (needsReview) {
      status = "Needs Review";
    }

    // Prepare match record by selecting the highest-confidence values between QP and AK (with DB paper fallbacks)
    const finalSubject = pickHighestConf(qpMeta.subject, bestAk?.metadata?.subject, dbPaper?.subject || "Unknown Subject");
    const finalSubjectCode = pickHighestConf(qpMeta.subject_code, bestAk?.metadata?.subject_code, dbPaper?.subject_code || null);
    const finalDepartment = pickHighestConf(qpMeta.department, bestAk?.metadata?.department, dbPaper?.department || "Unknown");
    const finalSemester = pickHighestConf(qpMeta.semester, bestAk?.metadata?.semester, dbPaper?.semester || 1);
    const finalAcademicYear = pickHighestConf(qpMeta.academic_year, bestAk?.metadata?.academic_year, dbPaper?.academic_year || "2024-25");
    const finalExamType = pickHighestConf(qpMeta.exam_type, bestAk?.metadata?.exam_type, dbPaper?.exam_type || "ESE");
    const finalMarks = pickHighestConf(qpMeta.marks, bestAk?.metadata?.marks, dbPaper?.marks || 70);
    const finalExamDate = pickHighestConf(qpMeta.exam_date, bestAk?.metadata?.exam_date, dbPaper?.exam_date || null);

    const matchRecord: any = {
      subject: finalSubject,
      subject_code: finalSubjectCode,
      department: finalDepartment,
      semester: finalSemester,
      academic_year: finalAcademicYear,
      exam_type: finalExamType,
      marks: finalMarks,
      exam_date: finalExamDate,
      question_paper: {
        id: qp.file_id,
        name: qp.name,
        url: qp.web_view_link || `https://drive.google.com/file/d/${qp.file_id}/view`,
        checksum: qpMeta.drive_checksum || null,
        modifiedTime: qpMeta.drive_modified_time || null,
        size: qp.size || null,
      },
      answer_key: null,
      status: status,
      error: qp.error || bestAk?.error || null,
    };

    // Attach answer key details (either from current batch match or existing DB paper)
    if (bestAk) {
      usedAkIds.add(bestAk.id);
      matchRecord.answer_key = {
        id: bestAk.file_id,
        name: bestAk.name,
        url: bestAk.web_view_link || `https://drive.google.com/file/d/${bestAk.file_id}/view`,
        checksum: bestAk.metadata?.drive_checksum || null,
        modifiedTime: bestAk.metadata?.drive_modified_time || null,
        size: bestAk.size || null,
      };
    } else if (dbPaper && dbPaper.answer_key_url) {
      // Carry over existing AK
      matchRecord.answer_key = {
        id: dbPaper.answer_key_file_id || null,
        name: dbPaper.answer_key_name || "Answer Key",
        url: dbPaper.answer_key_url,
        checksum: dbPaper.answer_key_checksum || null,
        modifiedTime: dbPaper.answer_key_modified_time || null,
        size: dbPaper.answer_key_size || null,
      };
    }

    if (isUpdate && dbPaper) {
      matchRecord.dbPaperId = dbPaper.id;
      // Compare checksums to determine if we actually update
      const isQpIdentical = dbPaper.question_paper_checksum === qpMeta.drive_checksum;
      const isAkIdentical = bestAk 
        ? dbPaper.answer_key_checksum === bestAk.metadata?.drive_checksum
        : true; // no new AK to update
        
      if (isQpIdentical && isAkIdentical) {
        matchRecord.status = "Duplicate";
        matchRecord.duplicateResolution = "skip";
      } else {
        matchRecord.status = "Update Question Paper";
        matchRecord.duplicateResolution = "update";
      }
    } else {
      if (!matchRecord.answer_key) {
        matchRecord.status = needsReview ? "Needs Review" : "Missing Answer Key";
      }
    }

    matchedPapers.push(matchRecord);
  }

  // Process remaining Answer Keys (those not matched with QPs in the current batch)
  for (const ak of aks) {
    if (usedAkIds.has(ak.id)) continue;
    const akMeta = ak.metadata;
    let isUpdate = akMeta.isUpdate === true;
    let existingPaperId = akMeta.existingPaperId || null;
    let dbPaper = existingPaperId ? dbPapers.find(p => p.id === existingPaperId) : null;

    if (!dbPaper) {
      dbPaper = findDbPaperByMeta(akMeta);
    }

    const needsReview =
      akMeta._needs_review === true ||
      !akMeta.subject?.value ||
      akMeta.subject?.value === "Unknown Subject";

    const matchRecord: any = {
      subject: akMeta.subject?.value || dbPaper?.subject || "Unknown Subject",
      subject_code: akMeta.subject_code?.value || dbPaper?.subject_code || null,
      department: akMeta.department?.value || dbPaper?.department || "Unknown",
      semester: akMeta.semester?.value || dbPaper?.semester || 1,
      academic_year: akMeta.academic_year?.value || dbPaper?.academic_year || "2024-25",
      exam_type: akMeta.exam_type?.value || dbPaper?.exam_type || "ESE",
      marks: akMeta.marks?.value || dbPaper?.marks || 70,
      exam_date: akMeta.exam_date?.value || dbPaper?.exam_date || null,
      question_paper: null,
      answer_key: {
        id: ak.file_id,
        name: ak.name,
        url: ak.web_view_link || `https://drive.google.com/file/d/${ak.file_id}/view`,
        checksum: akMeta.drive_checksum || null,
        modifiedTime: akMeta.drive_modified_time || null,
        size: ak.size || null,
      },
      status: needsReview ? "Needs Review" : "Unknown Subject",
      error: ak.error || null,
    };

    if (dbPaper) {
      matchRecord.dbPaperId = dbPaper.id;
      // Carry over existing QP
      matchRecord.question_paper = {
        id: dbPaper.question_paper_file_id || null,
        name: dbPaper.question_paper_name || "Question Paper",
        url: dbPaper.question_paper_url,
        checksum: dbPaper.question_paper_checksum || null,
        modifiedTime: dbPaper.question_paper_modified_time || null,
        size: dbPaper.question_paper_size || null,
      };

      if (!dbPaper.answer_key_url) {
        matchRecord.status = "Attach Answer Key";
        matchRecord.duplicateResolution = "update";
      } else {
        // Compare checksums to see if we update/replace answer key
        const isAkIdentical = dbPaper.answer_key_checksum === akMeta.drive_checksum;
        if (isAkIdentical) {
          matchRecord.status = "Duplicate";
          matchRecord.duplicateResolution = "skip";
        } else {
          matchRecord.status = "Replace Wrong Answer Key";
          matchRecord.duplicateResolution = "update";
        }
      }
    }

    matchedPapers.push(matchRecord);
  }

  // Process Unknowns
  for (const un of unknowns) {
    matchedPapers.push({
      subject: un.metadata?.subject?.value || "Unknown Subject",
      subject_code: un.metadata?.subject_code?.value || null,
      department: un.metadata?.department?.value || "Unknown",
      semester: un.metadata?.semester?.value || 1,
      academic_year: un.metadata?.academic_year?.value || "2024-25",
      exam_type: un.metadata?.exam_type?.value || "ESE",
      marks: un.metadata?.marks?.value || 70,
      exam_date: un.metadata?.exam_date?.value || null,
      question_paper: {
        id: un.file_id,
        name: un.name,
        url: un.web_view_link || `https://drive.google.com/file/d/${un.file_id}/view`,
        checksum: un.metadata?.drive_checksum || null,
        modifiedTime: un.metadata?.drive_modified_time || null,
        size: un.size || null,
      },
      answer_key: null,
      status: "Needs Review",
      error: un.error || null,
    });
  }

  // Stats calculation
  const totalDriveFiles = items.length;
  const alreadyImportedCount = skippedItems.filter(r => r.metadata?.skipReason === "already_imported").length;

  const stats = {
    totalFiles: totalDriveFiles,
    alreadyImported: alreadyImportedCount,
    questionPapers: qps.length,
    answerKeys: aks.length,
    matchedPapers: matchedPapers.filter((p) => p.question_paper && p.answer_key && p.status !== "Duplicate").length,
    missingAnswerKeys: matchedPapers.filter((p) => p.question_paper && !p.answer_key).length,
    duplicates: matchedPapers.filter((p) => p.status === "Duplicate").length,
    unknownFiles: unknowns.length,
    skippedFiles: skippedItems.length,
    needsReview: matchedPapers.filter((p) => p.status === "Needs Review").length,
  };

  // Update bulk_import_jobs with results
  await supabaseAdmin
    .from("bulk_import_jobs")
    .update({
      status: "completed",
      current_step: "Scanning and processing completed successfully.",
      progress: 100,
      stats,
      results: matchedPapers,
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId);
}

/**
 * POST /api/import/scan
 * Admin only — Phase 1: Scan Google Drive, save to bulk_import_items
 */
router.post(
  "/scan",
  requireAuth,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { folderUrl, googleAccessToken } = req.body;
      if (!folderUrl || !googleAccessToken) {
        res.status(400).json({ error: "Missing folderUrl or googleAccessToken" });
        return;
      }

      const folderId = extractFolderId(folderUrl);
      if (!folderId) {
        res.status(400).json({ error: "Invalid Google Drive folder URL" });
        return;
      }

      const supabaseAdmin = getSupabaseAdmin();

      // Create new Database Bulk Import Job
      const { data: job, error: jobErr } = await supabaseAdmin
        .from("bulk_import_jobs")
        .insert({
          status: "scanning",
          folder_url: folderUrl,
          current_step: "Scanning Google Drive folder structure...",
          progress: 5,
        })
        .select("*")
        .single();

      if (jobErr) throw jobErr;

      res.json({ jobId: job.id });

      // Run recursive scan in background
      (async () => {
        try {
          const files = await listPdfFilesRecursively(folderId, googleAccessToken, async (count) => {
            await supabaseAdmin
              .from("bulk_import_jobs")
              .update({
                current_step: `Scanning folders... found ${count} PDF files`,
              })
              .eq("id", job.id);
          });

          if (files.length === 0) {
            await supabaseAdmin
              .from("bulk_import_jobs")
              .update({
                status: "completed",
                current_step: "Scan complete. No PDF files found.",
                progress: 100,
              })
              .eq("id", job.id);
            return;
          }

          // Fetch existing files by ID to identify duplicates/updates/skipped
          const fileIds = files.map((f) => f.id);
          const dbPapersMap = await fetchExistingPapersForFiles(fileIds);

          // Pre-classify files and bulk insert items into database
          const itemsToInsert = files.map((file) => {
            const preClassification = classifyFile(file.name, file.path, "");
            const isAcademic = preClassification === "Question Paper" || preClassification === "Answer Key";
            
            if (!isAcademic) {
              return {
                job_id: job.id,
                file_id: file.id,
                name: file.name,
                path: file.path,
                size: file.size || null,
                web_view_link: file.webViewLink || null,
                status: "skipped",
                type: preClassification,
                metadata: { skipReason: "non_academic" },
              };
            }

            const existing = dbPapersMap.get(file.id);
            if (existing) {
              const isQp = existing.role === "qp";
              const storedChecksum = isQp ? existing.paper.question_paper_checksum : existing.paper.answer_key_checksum;
              const storedSize = isQp ? existing.paper.question_paper_size : existing.paper.answer_key_size;
              const storedModTime = isQp ? existing.paper.question_paper_modified_time : existing.paper.answer_key_modified_time;

              const isIdentical =
                storedChecksum === file.md5Checksum &&
                (storedSize === null || Number(storedSize) === file.size) &&
                (storedModTime === null || new Date(storedModTime).getTime() === new Date(file.modifiedTime || "").getTime());

              if (isIdentical) {
                return {
                  job_id: job.id,
                  file_id: file.id,
                  name: file.name,
                  path: file.path,
                  size: file.size || null,
                  web_view_link: file.webViewLink || null,
                  status: "skipped",
                  type: preClassification,
                  metadata: {
                    skipReason: "already_imported",
                    existingPaperId: existing.paper.id,
                    drive_modified_time: file.modifiedTime || null,
                    drive_checksum: file.md5Checksum || null,
                  },
                };
              } else {
                return {
                  job_id: job.id,
                  file_id: file.id,
                  name: file.name,
                  path: file.path,
                  size: file.size || null,
                  web_view_link: file.webViewLink || null,
                  status: "pending",
                  type: preClassification,
                  metadata: {
                    isUpdate: true,
                    existingPaperId: existing.paper.id,
                    role: existing.role,
                    drive_modified_time: file.modifiedTime || null,
                    drive_checksum: file.md5Checksum || null,
                  },
                };
              }
            }

            // Brand new file
            return {
              job_id: job.id,
              file_id: file.id,
              name: file.name,
              path: file.path,
              size: file.size || null,
              web_view_link: file.webViewLink || null,
              status: "pending",
              type: preClassification,
              metadata: {
                drive_modified_time: file.modifiedTime || null,
                drive_checksum: file.md5Checksum || null,
              },
            };
          });

          // Insert in chunks of 100 to avoid limits
          const chunkSize = 100;
          for (let i = 0; i < itemsToInsert.length; i += chunkSize) {
            const chunk = itemsToInsert.slice(i, i + chunkSize);
            const { error: insErr } = await supabaseAdmin.from("bulk_import_items").insert(chunk);
            if (insErr) throw insErr;
          }

          // Complete Phase 1 scan. Status transitions to paused (awaiting extraction click)
          const skippedTypes = ["Timetable", "Notice", "Circular", "Syllabus", "Unknown"];
          const stats = {
            totalFiles: files.length,
            alreadyImported: itemsToInsert.filter((r) => r.metadata.skipReason === "already_imported").length,
            questionPapers: itemsToInsert.filter((r) => r.type === "Question Paper").length,
            answerKeys: itemsToInsert.filter((r) => r.type === "Answer Key").length,
            matchedPapers: 0,
            missingAnswerKeys: 0,
            duplicates: 0,
            unknownFiles: itemsToInsert.filter((r) => r.type === "Unknown").length,
            skippedFiles: itemsToInsert.filter((r) => r.status === "skipped").length,
          };

          await supabaseAdmin
            .from("bulk_import_jobs")
            .update({
              status: "paused",
              current_step: "scan_completed",
              progress: 100,
              stats,
            })
            .eq("id", job.id);

        } catch (err: any) {
          console.error("Scan Phase background error:", err);
          await supabaseAdmin
            .from("bulk_import_jobs")
            .update({
              status: "failed",
              current_step: "Scanning failed.",
              error: err instanceof Error ? err.message : String(err),
            })
            .eq("id", job.id);
        }
      })();

    } catch (err) {
      console.error("Error starting scan:", err);
      res.status(500).json({ error: "Failed to initialize scan" });
    }
  }
);

/**
 * POST /api/import/process/:jobId
 * Admin only — Phase 2: Start controlled queue processing
 */
router.post(
  "/process/:jobId",
  requireAuth,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const jobId = req.params.jobId as string;
      const { googleAccessToken } = req.body;
      if (!googleAccessToken) {
        res.status(400).json({ error: "Missing googleAccessToken" });
        return;
      }

      const supabaseAdmin = getSupabaseAdmin();

      // Retrieve job
      const { data: job, error: jobErr } = await supabaseAdmin
        .from("bulk_import_jobs")
        .select("*")
        .eq("id", jobId)
        .single();

      if (jobErr || !job) {
        res.status(404).json({ error: "Job not found" });
        return;
      }

      // Check if job can be processed
      if (job.status !== "paused" && job.status !== "scanning") {
        res.status(400).json({ error: `Cannot process job with status: ${job.status}` });
        return;
      }

      res.json({ success: true, message: "Queue processing started in background" });

      // Start asynchronous queue runner
      processQueue(jobId, googleAccessToken);

    } catch (err) {
      console.error("Error starting queue processing:", err);
      res.status(500).json({ error: "Failed to start processing" });
    }
  }
);

/**
 * POST /api/import/pause/:jobId
 * Admin only — Pause processing queue
 */
router.post(
  "/pause/:jobId",
  requireAuth,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const jobId = req.params.jobId as string;
      const supabaseAdmin = getSupabaseAdmin();

      const { data: job, error: fetchErr } = await supabaseAdmin
        .from("bulk_import_jobs")
        .select("status")
        .eq("id", jobId)
        .single();

      if (fetchErr || !job) {
        res.status(404).json({ error: "Job not found" });
        return;
      }

      if (job.status !== "processing") {
        res.status(400).json({ error: "Only active processing jobs can be paused" });
        return;
      }

      await supabaseAdmin
        .from("bulk_import_jobs")
        .update({
          status: "paused",
          current_step: "Processing paused by administrator.",
          updated_at: new Date().toISOString(),
        })
        .eq("id", jobId);

      res.json({ success: true });
    } catch (err) {
      console.error("Error pausing job:", err);
      res.status(500).json({ error: "Failed to pause job" });
    }
  }
);

/**
 * POST /api/import/resume/:jobId
 * Admin only — Resume processing queue
 */
router.post(
  "/resume/:jobId",
  requireAuth,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const jobId = req.params.jobId as string;
      const { googleAccessToken } = req.body;
      if (!googleAccessToken) {
        res.status(400).json({ error: "Missing googleAccessToken" });
        return;
      }

      const supabaseAdmin = getSupabaseAdmin();

      const { data: job, error: fetchErr } = await supabaseAdmin
        .from("bulk_import_jobs")
        .select("status")
        .eq("id", jobId)
        .single();

      if (fetchErr || !job) {
        res.status(404).json({ error: "Job not found" });
        return;
      }

      if (job.status !== "paused") {
        res.status(400).json({ error: "Only paused jobs can be resumed" });
        return;
      }

      await supabaseAdmin
        .from("bulk_import_jobs")
        .update({
          status: "processing",
          current_step: "Resuming metadata extraction...",
          updated_at: new Date().toISOString(),
        })
        .eq("id", jobId);

      res.json({ success: true });

      // Trigger runner in background
      processQueue(jobId, googleAccessToken);
    } catch (err) {
      console.error("Error resuming job:", err);
      res.status(500).json({ error: "Failed to resume job" });
    }
  }
);

/**
 * POST /api/import/cancel/:jobId
 * Admin only — Cancel processing queue
 */
router.post(
  "/cancel/:jobId",
  requireAuth,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const jobId = req.params.jobId as string;
      const supabaseAdmin = getSupabaseAdmin();

      const { data: job, error: fetchErr } = await supabaseAdmin
        .from("bulk_import_jobs")
        .select("status")
        .eq("id", jobId)
        .single();

      if (fetchErr || !job) {
        res.status(404).json({ error: "Job not found" });
        return;
      }

      await supabaseAdmin
        .from("bulk_import_jobs")
        .update({
          status: "cancelled",
          current_step: "Job cancelled by administrator.",
          updated_at: new Date().toISOString(),
        })
        .eq("id", jobId);

      res.json({ success: true });
    } catch (err) {
      console.error("Error cancelling job:", err);
      res.status(500).json({ error: "Failed to cancel job" });
    }
  }
);

/**
 * GET /api/import/status/:jobId
 * Admin only — Check background scanning status from DB
 */
router.get(
  "/status/:jobId",
  requireAuth,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const jobId = req.params.jobId as string;
      const supabaseAdmin = getSupabaseAdmin();

      const { data: job, error: jobErr } = await supabaseAdmin
        .from("bulk_import_jobs")
        .select("*")
        .eq("id", jobId)
        .single();

      if (jobErr || !job) {
        res.status(404).json({ error: "Job not found" });
        return;
      }

      // Query items count to display details if scanning is completed
      const { data: items } = await supabaseAdmin
        .from("bulk_import_items")
        .select("id, name, path, status, type, error, used_ai, metadata, created_at, file_id, size")
        .eq("job_id", jobId)
        .order("created_at", { ascending: true });

      res.json({
        id: job.id,
        status: job.status,
        currentStep: job.current_step,
        progress: job.progress,
        stats: job.stats,
        results: job.results || [],
        items: items || [],
        error: job.error || null,
      });
    } catch (err) {
      console.error("Error fetching job status:", err);
      res.status(500).json({ error: "Failed to fetch status" });
    }
  }
);

/**
 * POST /api/import/execute
 * Admin only — Perform bulk DB import with chosen options
 */
router.post(
  "/execute",
  requireAuth,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { papers } = req.body;
      if (!Array.isArray(papers)) {
        res.status(400).json({ error: "Invalid payload: papers array is required" });
        return;
      }

      const supabaseAdmin = getSupabaseAdmin();
      let importedCount = 0;
      let failedCount = 0;
      let skippedCount = 0;
      let newQpsCount = 0;
      let newAksCount = 0;
      let updatedQpsCount = 0;
      let updatedAksCount = 0;
      let duplicateSkippedCount = 0;
      let needsReviewCount = 0;

      for (const item of papers) {
        try {
          // Determine if we update or insert a new paper
          const isDuplicate = item.status === "Duplicate";
          const hasExisting = !!item.dbPaperId;
          const resolution = item.duplicateResolution || "skip";

          if (isDuplicate && resolution === "skip") {
            skippedCount++;
            duplicateSkippedCount++;
            continue;
          }

          if (item.status === "Needs Review") {
            needsReviewCount++;
          }

          if (hasExisting) {
            if (resolution === "replace") {
              // Delete old paper record
              const { error: delErr } = await supabaseAdmin.from("papers").delete().eq("id", item.dbPaperId);
              if (delErr) throw delErr;
              // Will proceed to insert new record below
            } else {
              // Perform update on existing record (resolution === "update" or status update/replace/attach)
              const updates: any = {
                subject: item.subject,
                subject_code: item.subject_code,
                department: item.department,
                semester: parseInt(item.semester, 10),
                academic_year: item.academic_year,
                exam_type: item.exam_type,
                marks: parseInt(item.marks, 10),
                exam_date: item.exam_date || null,
                updated_at: new Date().toISOString(),
              };

              if (item.question_paper) {
                updates.question_paper_source = "gdrive";
                updates.question_paper_url = item.question_paper.url;
                updates.question_paper_file_id = item.question_paper.id;
                updates.question_paper_checksum = item.question_paper.checksum;
                updates.question_paper_modified_time = item.question_paper.modifiedTime;
                updates.question_paper_size = item.question_paper.size;
              }
              if (item.answer_key) {
                updates.answer_key_source = "gdrive";
                updates.answer_key_url = item.answer_key.url;
                updates.answer_key_file_id = item.answer_key.id;
                updates.answer_key_checksum = item.answer_key.checksum;
                updates.answer_key_modified_time = item.answer_key.modifiedTime;
                updates.answer_key_size = item.answer_key.size;
              }

              const { error: updErr } = await supabaseAdmin.from("papers").update(updates).eq("id", item.dbPaperId);
              if (updErr) throw updErr;

              if (item.status === "Update Question Paper") {
                updatedQpsCount++;
              } else if (
                item.status === "Update Answer Key" ||
                item.status === "Replace Wrong Answer Key" ||
                item.status === "Attach Answer Key"
              ) {
                updatedAksCount++;
              } else {
                updatedQpsCount++;
              }

              // Update item status in bulk_import_items to skipped (already imported)
              const fileIdsToSkip = [];
              if (item.question_paper?.id) fileIdsToSkip.push(item.question_paper.id);
              if (item.answer_key?.id) fileIdsToSkip.push(item.answer_key.id);

              if (fileIdsToSkip.length > 0) {
                await supabaseAdmin
                  .from("bulk_import_items")
                  .update({
                    status: "skipped",
                    metadata: {
                      skipReason: "already_imported",
                      existingPaperId: item.dbPaperId,
                      drive_checksum: item.question_paper?.checksum || item.answer_key?.checksum || null,
                      drive_modified_time: item.question_paper?.modifiedTime || item.answer_key?.modifiedTime || null,
                    }
                  })
                  .in("file_id", fileIdsToSkip);
              }

              // Dynamically learn subject aliases
              await learnAliasesFromImport(item);

              importedCount++;
              continue;
            }
          }

          // If brand new insert, must have at least a QP url
          if (!item.question_paper?.url) {
            skippedCount++;
            continue;
          }

          // Insert new paper record
          const insertPayload: any = {
            subject: item.subject,
            subject_code: item.subject_code,
            department: item.department,
            semester: parseInt(item.semester, 10),
            academic_year: item.academic_year,
            exam_type: item.exam_type,
            marks: parseInt(item.marks, 10),
            exam_date: item.exam_date || null,
            question_paper_source: "gdrive",
            question_paper_url: item.question_paper.url,
            question_paper_file_id: item.question_paper.id,
            question_paper_checksum: item.question_paper.checksum,
            question_paper_modified_time: item.question_paper.modifiedTime,
            question_paper_size: item.question_paper.size,
          };

          if (item.answer_key?.url) {
            insertPayload.answer_key_source = "gdrive";
            insertPayload.answer_key_url = item.answer_key.url;
            insertPayload.answer_key_file_id = item.answer_key.id;
            insertPayload.answer_key_checksum = item.answer_key.checksum;
            insertPayload.answer_key_modified_time = item.answer_key.modifiedTime;
            insertPayload.answer_key_size = item.answer_key.size;
          }

          const { data: insData, error: insErr } = await supabaseAdmin
            .from("papers")
            .insert(insertPayload)
            .select("id")
            .single();

          if (insErr) throw insErr;

          newQpsCount++;
          if (item.answer_key?.url) {
            newAksCount++;
          }

          // Update item status in bulk_import_items to skipped (already imported)
          const fileIdsToSkip = [];
          if (item.question_paper?.id) fileIdsToSkip.push(item.question_paper.id);
          if (item.answer_key?.id) fileIdsToSkip.push(item.answer_key.id);

          if (fileIdsToSkip.length > 0 && insData?.id) {
            await supabaseAdmin
              .from("bulk_import_items")
              .update({
                status: "skipped",
                metadata: {
                  skipReason: "already_imported",
                  existingPaperId: insData.id,
                  drive_checksum: item.question_paper?.checksum || item.answer_key?.checksum || null,
                  drive_modified_time: item.question_paper?.modifiedTime || item.answer_key?.modifiedTime || null,
                }
              })
              .in("file_id", fileIdsToSkip);
          }

          // Dynamically learn subject aliases
          await learnAliasesFromImport(item);

          importedCount++;
        } catch (err) {
          console.error(`Failed to import paper for subject ${item.subject}:`, err);
          failedCount++;
        }
      }

      res.json({
        success: true,
        stats: {
          totalProcessed: papers.length,
          imported: importedCount,
          skipped: skippedCount,
          failed: failedCount,
          newQps: newQpsCount,
          newAks: newAksCount,
          updatedQps: updatedQpsCount,
          updatedAks: updatedAksCount,
          duplicateSkipped: duplicateSkippedCount,
          needsReview: needsReviewCount,
        },
      });
    } catch (err) {
      console.error("Bulk import execution error:", err);
      res.status(500).json({ error: "Bulk import execution failed" });
    }
  }
);

async function learnAliasesFromImport(item: any) {
  const supabaseAdmin = getSupabaseAdmin();
  const filenames = [item.question_paper?.name, item.answer_key?.name].filter(Boolean);
  const cleanSubject = item.subject;
  if (!cleanSubject || cleanSubject === "Unknown Subject") return;

  for (const filename of filenames) {
    const words = filename.split(/[^a-zA-Z0-9\-]/);
    for (const word of words) {
      const upperWord = word.toUpperCase();
      if (/^[A-Z\-]{2,6}$/.test(upperWord) && !["AK", "QP", "SEM", "PDF", "FMS"].includes(upperWord)) {
        try {
          await supabaseAdmin
            .from("learned_aliases")
            .upsert({ alias: upperWord, full_name: cleanSubject }, { onConflict: "alias" });
        } catch (err) {
          // ignore duplicate insert errors
        }
      }
    }
  }
}

export default router;
