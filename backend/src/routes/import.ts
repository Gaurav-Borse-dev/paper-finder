import { Router, type Response } from "express";
import { PDFParse } from "pdf-parse";
import { getSupabaseAdmin } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/admin.js";
import type { AuthenticatedRequest, ExtractionResult, ExtractionField } from "../types.js";
import { localExtract, needsAi, mergeResults, SYSTEM_PROMPT, parseExtraction } from "./extract.js";
import crypto from "crypto";

const router = Router();

// Track active jobs in memory to prevent duplicate runner instantiation
const activeJobRunners = new Set<string>();

function extractFolderId(url: string): string | null {
  if (!url) return null;
  const match = url.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

function classifyFile(filename: string, folderPath: string, text: string): "Question Paper" | "Answer Key" | "Unknown" {
  const nameLower = filename.toLowerCase();
  const pathLower = folderPath.toLowerCase();
  const textLower = text.slice(0, 1000).toLowerCase();

  const akKeywords = ["solution", "answer key", "solved paper", "soln", "solutions", "ak", "answer-key", "answer_key"];
  const qpKeywords = ["question paper", "qp", "question-paper", "question_paper", "paper"];

  const pathParts = pathLower.split("/");
  const lastPathPart = pathParts[pathParts.length - 1] || "";
  const secondLastPathPart = pathParts[pathParts.length - 2] || "";

  if (lastPathPart.includes("solution") || lastPathPart.includes("answer") || secondLastPathPart.includes("solution")) {
    return "Answer Key";
  }
  if (lastPathPart.includes("question") || lastPathPart.includes("qp") || secondLastPathPart.includes("question")) {
    return "Question Paper";
  }

  for (const keyword of akKeywords) {
    if (nameLower.includes(keyword)) {
      return "Answer Key";
    }
  }
  for (const keyword of qpKeywords) {
    if (nameLower.includes(keyword)) {
      return "Question Paper";
    }
  }

  if (textLower.includes("scheme of valuation") || textLower.includes("solution") || textLower.includes("answer key") || textLower.includes("marking scheme")) {
    return "Answer Key";
  }
  if (textLower.includes("question paper") || textLower.includes("maximum marks")) {
    return "Question Paper";
  }

  return "Unknown";
}

function calculateMatchScore(qp: any, ak: any): number {
  let score = 0;

  const qpPathClean = qp.path.replace(/\b(question\s*papers?|question|qp|solutions?|answers?|ak)\b/ig, "").replace(/\/+/g, "/").trim();
  const akPathClean = ak.path.replace(/\b(question\s*papers?|question|qp|solutions?|answers?|ak)\b/ig, "").replace(/\/+/g, "/").trim();
  if (qpPathClean && qpPathClean === akPathClean) {
    score += 15;
  }

  const qpSub = (qp.metadata.subject?.value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const akSub = (ak.metadata.subject?.value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (qpSub && qpSub === akSub) {
    score += 15;
  } else if (qpSub && akSub && (qpSub.includes(akSub) || akSub.includes(qpSub))) {
    score += 8;
  }

  const cleanName = (name: string) => name.toLowerCase()
    .replace(/\.pdf$/i, "")
    .replace(/\b(solution|soln|solved|answer|key|qp|question|paper|ak)\b/ig, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
  const qpNameClean = cleanName(qp.name);
  const akNameClean = cleanName(ak.name);
  if (qpNameClean && qpNameClean === akNameClean) {
    score += 10;
  } else if (qpNameClean && akNameClean && (qpNameClean.includes(akNameClean) || akNameClean.includes(qpNameClean))) {
    score += 5;
  }

  if (qp.metadata.academic_year?.value && qp.metadata.academic_year?.value === ak.metadata.academic_year?.value) {
    score += 5;
  }

  if (qp.metadata.exam_type?.value && qp.metadata.exam_type?.value === ak.metadata.exam_type?.value) {
    score += 5;
  }

  if (qp.metadata.semester?.value && qp.metadata.semester?.value === ak.metadata.semester?.value) {
    score += 5;
  }

  if (qp.metadata.department?.value && qp.metadata.department?.value === ak.metadata.department?.value) {
    score += 5;
  }

  return score;
}

/**
 * Level 4 OCR: Lightweight Gemini Vision call to extract raw text from scanned PDFs.
 * This is MUCH cheaper than a full metadata extraction call — we just ask for the text,
 * then run our local heuristic pipeline on the OCR'd output.
 * Only called when pdf-parse returns < 100 chars of text (indicating a scanned/image PDF).
 */
async function ocrViaGemini(pdfBase64: string): Promise<string> {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) return "";

  const model = process.env.GEMINI_MODEL || "gemini-flash-latest";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;

  const prompt = `Extract ALL visible text from this PDF page exactly as it appears. Return ONLY the raw text, no formatting, no JSON, no explanation. Include headers, footers, exam details, subject names, dates, marks — everything visible.`;

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

async function listPdfFilesRecursively(
  folderId: string,
  accessToken: string,
  onFolderScanned: (count: number) => void
): Promise<Array<{ id: string; name: string; size?: number; webViewLink?: string; path: string }>> {
  const files: Array<{ id: string; name: string; size?: number; webViewLink?: string; path: string }> = [];
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
      url.searchParams.append("fields", "nextPageToken, files(id, name, mimeType, size, webViewLink)");
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
        files: Array<{ id: string; name: string; mimeType: string; size?: string; webViewLink?: string }>;
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
          });
        }
      }
      nextPageToken = data.nextPageToken;
    } while (nextPageToken);

    onFolderScanned(files.length);

    // Scan subfolders concurrently with a concurrency limit of 5
    const limit = 5;
    for (let i = 0; i < subfolders.length; i += limit) {
      const chunk = subfolders.slice(i, i + limit);
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

// Background Queue Processor
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

    // Get current job progress to check if starting first-time vs resume
    const { data: job } = await supabaseAdmin
      .from("bulk_import_jobs")
      .select("progress, current_step")
      .eq("id", jobId)
      .single();

    const initialProgress = (job && job.current_step === "scan_completed") ? 10 : (job?.progress || 10);

    // Update job to processing
    await supabaseAdmin
      .from("bulk_import_jobs")
      .update({
        status: "processing",
        current_step: "Extracting metadata from PDFs...",
        progress: initialProgress,
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId);

    // Controlled Queue setup
    const pendingQueue = [...items];
    const totalFilesQuery = await supabaseAdmin
      .from("bulk_import_items")
      .select("id", { count: "exact", head: true })
      .eq("job_id", jobId);

    const totalFilesCount = totalFilesQuery.count || pendingQueue.length;
    const concurrencyLimit = 2;
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    // Exponential Backoff caller
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
          if (is429) {
            if (attempt < maxRetries - 1) {
              console.log(`[Gemini] 429 Rate Limit. Retrying in ${delayMs}ms (Attempt ${attempt + 1}/${maxRetries})`);
              await delay(delayMs);
              delayMs *= 2;
              continue;
            } else {
              // Rate limit fully hit after retries, trigger Phase 5: Auto-pause job for 60 seconds
              console.log(`[Gemini] Rate limit fully exhausted. Pausing queue for 60 seconds...`);
              await supabaseAdmin
                .from("bulk_import_jobs")
                .update({
                  current_step: "Rate limit hit. Pausing extraction for 60 seconds before auto-resuming...",
                  updated_at: new Date().toISOString(),
                })
                .eq("id", jobId);

              await delay(60000); // 60-second pause

              // Update back to active step and retry one final time
              await supabaseAdmin
                .from("bulk_import_jobs")
                .update({
                  current_step: "Auto-resuming extraction...",
                  updated_at: new Date().toISOString(),
                })
                .eq("id", jobId);

              return await extractMetadataViaGemini(pdfBase64, fileName, highConfFields);
            }
          }
          throw err;
        }
      }
    };

    const worker = async () => {
      while (pendingQueue.length > 0) {
        // Double-check job status to support Pause & Cancel
        const { data: job, error: statusErr } = await supabaseAdmin
          .from("bulk_import_jobs")
          .select("status")
          .eq("id", jobId)
          .single();

        if (statusErr || !job || job.status === "paused" || job.status === "cancelled") {
          console.log(`[Worker] Worker stopping because job is ${job?.status || "undefined"}`);
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
        let localResult: ExtractionResult | null = null;
        let fileBuffer: Buffer | null = null;
        let extractionError = "";
        let usedAi = false;

        try {
          // 1. Download
          const downloadUrl = `https://www.googleapis.com/drive/v3/files/${item.file_id}?alt=media`;
          const downloadRes = await fetch(downloadUrl, {
            headers: { Authorization: `Bearer ${googleAccessToken}` },
          });
          if (!downloadRes.ok) {
            throw new Error(`Download failed: ${downloadRes.statusText}`);
          }
          const arrayBuffer = await downloadRes.arrayBuffer();
          fileBuffer = Buffer.from(arrayBuffer);

          // 2. Parse text locally
          const parser = new PDFParse({ data: fileBuffer });
          const textData = await parser.getText();
          await parser.destroy();
          localText = textData.text || "";

          // 3. Local extraction
          localResult = await localExtract(localText, item.name, item.path);
        } catch (err: any) {
          console.error(`Error processing file ${item.name}:`, err);
          extractionError = err instanceof Error ? err.message : String(err);
        }

        let finalResult = localResult || {
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

        const classification = classifyFile(item.name, item.path, localText);

        // Phase 3: Smart Extraction Threshold
        // Calculate average local confidence of core fields
        const coreFields = ["subject", "department", "semester", "academic_year", "exam_type"];
        let totalConf = 0;
        coreFields.forEach((field) => {
          const val = finalResult[field as keyof ExtractionResult];
          totalConf += val ? val.confidence : 0;
        });
        const avgConf = totalConf / coreFields.length;

        // Only call Gemini if confidence is below 60% (0.60)
        const needsAiExtraction = avgConf < 0.60 && needsAi(finalResult);

        if (needsAiExtraction && fileBuffer) {
          const geminiApiKey = process.env.GEMINI_API_KEY;
          if (geminiApiKey) {
            try {
              // Delay 1 second between jobs (staggered delay)
              await delay(1000 + Math.random() * 500);

              const pdfBase64 = fileBuffer.toString("base64");
              const highConfFields: any = {};
              Object.keys(finalResult).forEach((key) => {
                const field = finalResult[key as keyof ExtractionResult];
                if (field && field.confidence >= 0.85) {
                  highConfFields[key] = field.value;
                }
              });

              const apiResult = await callGeminiWithRetry(pdfBase64, item.name, highConfFields);
              if (apiResult) {
                finalResult = mergeResults(finalResult, apiResult);
                usedAi = true;
              }
            } catch (geminiErr: any) {
              console.error(`Gemini fallback failed for ${item.name}:`, geminiErr);
              extractionError = geminiErr instanceof Error ? geminiErr.message : String(geminiErr);
            }
          }
        }

        // Update item in database
        await supabaseAdmin
          .from("bulk_import_items")
          .update({
            status: extractionError && !usedAi ? "failed" : "completed",
            metadata: finalResult,
            type: classification,
            error: extractionError || null,
            used_ai: usedAi,
          })
          .eq("id", item.id);

        // Update current progress stats
        const { count: doneCount, error: countErr } = await supabaseAdmin
          .from("bulk_import_items")
          .select("id", { count: "exact", head: true })
          .eq("job_id", jobId)
          .in("status", ["completed", "failed", "skipped"]);

        const doneCountVal = doneCount || 0;
        const progressPercent = Math.min(Math.round(10 + (doneCountVal / totalFilesCount) * 75), 85); // 10% to 85%

        await supabaseAdmin
          .from("bulk_import_jobs")
          .update({
            progress: progressPercent,
            current_step: `Processed ${doneCountVal}/${totalFilesCount} files...`,
            updated_at: new Date().toISOString(),
          })
          .eq("id", jobId);

        // Stagger spacing between jobs
        await delay(1000);
      }
    };

    // Run parallel workers (Max 2 concurrent)
    const workers = Array(concurrencyLimit).fill(null).map(worker);
    await Promise.all(workers);

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
      current_step: "Matching Question Papers & Answer Keys...",
      progress: 90,
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId);

  // Fetch all completed items
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

  const qps = items.filter((r) => r.type === "Question Paper");
  const aks = items.filter((r) => r.type === "Answer Key");
  const unknowns = items.filter((r) => r.type === "Unknown");

  const matchedPapers: any[] = [];
  const usedAkIds = new Set<string>();

  for (const qp of qps) {
    let bestAk: any = null;
    let bestScore = -1;

    for (const ak of aks) {
      if (usedAkIds.has(ak.id)) continue;
      const score = calculateMatchScore(qp, ak);
      if (score >= 25 && score > bestScore) {
        bestScore = score;
        bestAk = ak;
      }
    }

    if (bestAk) {
      usedAkIds.add(bestAk.id);
      matchedPapers.push({
        subject: qp.metadata.subject?.value || bestAk.metadata.subject?.value || "Unknown Subject",
        subject_code: qp.metadata.subject_code?.value || bestAk.metadata.subject_code?.value || null,
        department: qp.metadata.department?.value || bestAk.metadata.department?.value || "Unknown",
        semester: qp.metadata.semester?.value || bestAk.metadata.semester?.value || 1,
        academic_year: qp.metadata.academic_year?.value || bestAk.metadata.academic_year?.value || "2024-25",
        exam_type: qp.metadata.exam_type?.value || bestAk.metadata.exam_type?.value || "ESE",
        marks: qp.metadata.marks?.value || bestAk.metadata.marks?.value || 70,
        exam_date: qp.metadata.exam_date?.value || bestAk.metadata.exam_date?.value || null,
        question_paper: {
          id: qp.file_id,
          name: qp.name,
          url: qp.web_view_link || `https://drive.google.com/file/d/${qp.file_id}/view`,
        },
        answer_key: {
          id: bestAk.file_id,
          name: bestAk.name,
          url: bestAk.web_view_link || `https://drive.google.com/file/d/${bestAk.file_id}/view`,
        },
        status: "Ready",
        error: qp.error || bestAk.error || null,
      });
    } else {
      matchedPapers.push({
        subject: qp.metadata.subject?.value || "Unknown Subject",
        subject_code: qp.metadata.subject_code?.value || null,
        department: qp.metadata.department?.value || "Unknown",
        semester: qp.metadata.semester?.value || 1,
        academic_year: qp.metadata.academic_year?.value || "2024-25",
        exam_type: qp.metadata.exam_type?.value || "ESE",
        marks: qp.metadata.marks?.value || 70,
        exam_date: qp.metadata.exam_date?.value || null,
        question_paper: {
          id: qp.file_id,
          name: qp.name,
          url: qp.web_view_link || `https://drive.google.com/file/d/${qp.file_id}/view`,
        },
        answer_key: null,
        status: "Missing Answer Key",
        error: qp.error || null,
      });
    }
  }

  // Remaining Answer Keys
  for (const ak of aks) {
    if (usedAkIds.has(ak.id)) continue;
    matchedPapers.push({
      subject: ak.metadata.subject?.value || "Unknown Subject",
      subject_code: ak.metadata.subject_code?.value || null,
      department: ak.metadata.department?.value || "Unknown",
      semester: ak.metadata.semester?.value || 1,
      academic_year: ak.metadata.academic_year?.value || "2024-25",
      exam_type: ak.metadata.exam_type?.value || "ESE",
      marks: ak.metadata.marks?.value || 70,
      exam_date: ak.metadata.exam_date?.value || null,
      question_paper: null,
      answer_key: {
        id: ak.file_id,
        name: ak.name,
        url: ak.web_view_link || `https://drive.google.com/file/d/${ak.file_id}/view`,
      },
      status: "Unknown Subject",
      error: ak.error || null,
    });
  }

  // Unknowns
  for (const un of unknowns) {
    matchedPapers.push({
      subject: un.metadata.subject?.value || "Unknown Subject",
      subject_code: un.metadata.subject_code?.value || null,
      department: un.metadata.department?.value || "Unknown",
      semester: un.metadata.semester?.value || 1,
      academic_year: un.metadata.academic_year?.value || "2024-25",
      exam_type: un.metadata.exam_type?.value || "ESE",
      marks: un.metadata.marks?.value || 70,
      exam_date: un.metadata.exam_date?.value || null,
      question_paper: {
        id: un.file_id,
        name: un.name,
        url: un.web_view_link || `https://drive.google.com/file/d/${un.file_id}/view`,
      },
      answer_key: null,
      status: "Unknown Subject",
      error: un.error || null,
    });
  }

  // Duplicate detection
  const { data: dbPapers } = await supabaseAdmin
    .from("papers")
    .select("id, subject, department, semester, academic_year, exam_type");

  const normalizeString = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  if (dbPapers) {
    for (const item of matchedPapers) {
      const duplicate = dbPapers.find(
        (p) =>
          normalizeString(p.subject) === normalizeString(item.subject) &&
          normalizeString(p.department) === normalizeString(item.department) &&
          p.semester === item.semester &&
          normalizeString(p.academic_year) === normalizeString(item.academic_year) &&
          normalizeString(p.exam_type) === normalizeString(item.exam_type)
      );

      if (duplicate) {
        item.status = "Duplicate";
        item.dbPaperId = duplicate.id;
        item.duplicateResolution = "skip";
      }
    }
  }

  const stats = {
    totalFiles: items.length,
    questionPapers: qps.length,
    answerKeys: aks.length,
    matchedPapers: matchedPapers.filter((p) => p.question_paper && p.answer_key).length,
    missingAnswerKeys: matchedPapers.filter((p) => p.question_paper && !p.answer_key).length,
    duplicates: matchedPapers.filter((p) => p.status === "Duplicate").length,
    unknownFiles: unknowns.length,
  };

  // Update bulk_import_jobs
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

          // Pre-classify files and bulk insert items into database
          const itemsToInsert = files.map((file) => {
            const preClassification = classifyFile(file.name, file.path, "");
            return {
              job_id: job.id,
              file_id: file.id,
              name: file.name,
              path: file.path,
              size: file.size || null,
              web_view_link: file.webViewLink || null,
              status: "pending",
              type: preClassification,
              metadata: {},
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
          const stats = {
            totalFiles: files.length,
            questionPapers: itemsToInsert.filter((r) => r.type === "Question Paper").length,
            answerKeys: itemsToInsert.filter((r) => r.type === "Answer Key").length,
            matchedPapers: 0,
            missingAnswerKeys: 0,
            duplicates: 0,
            unknownFiles: itemsToInsert.filter((r) => r.type === "Unknown").length,
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
        .select("id, name, path, status, type, error, used_ai")
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

      for (const item of papers) {
        try {
          if (item.status === "Duplicate") {
            const resolution = item.duplicateResolution || "skip";

            if (resolution === "skip") {
              skippedCount++;
              continue;
            }

            if (resolution === "replace" && item.dbPaperId) {
              // Delete old paper
              const { error: delErr } = await supabaseAdmin.from("papers").delete().eq("id", item.dbPaperId);
              if (delErr) throw delErr;
            } else if (resolution === "update" && item.dbPaperId) {
              // Update existing record
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

              if (item.question_paper?.url) {
                updates.question_paper_source = "gdrive";
                updates.question_paper_url = item.question_paper.url;
              }
              if (item.answer_key?.url) {
                updates.answer_key_source = "gdrive";
                updates.answer_key_url = item.answer_key.url;
              }

              const { error: updErr } = await supabaseAdmin.from("papers").update(updates).eq("id", item.dbPaperId);
              if (updErr) throw updErr;

              importedCount++;
              continue;
            }
          }

          // If skipping (either skipped duplicate or unpaired answer key with no QP URL)
          if (!item.question_paper?.url) {
            skippedCount++;
            continue;
          }

          // Insert new record
          const { error: insErr } = await supabaseAdmin.from("papers").insert({
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
            answer_key_source: item.answer_key?.url ? "gdrive" : null,
            answer_key_url: item.answer_key?.url || null,
          });

          if (insErr) throw insErr;
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
        },
      });
    } catch (err) {
      console.error("Bulk import execution error:", err);
      res.status(500).json({ error: "Bulk import execution failed" });
    }
  }
);

export default router;
