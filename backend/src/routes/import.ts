import { Router, type Response } from "express";
import { PDFParse } from "pdf-parse";
import { getSupabaseAdmin } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/admin.js";
import type { AuthenticatedRequest, ExtractionResult, ExtractionField } from "../types.js";
import { localExtract, needsAi, mergeResults, SYSTEM_PROMPT, parseExtraction } from "./extract.js";
import crypto from "crypto";

const router = Router();

interface ScanJob {
  id: string;
  status: "scanning" | "processing" | "completed" | "failed";
  currentStep: string;
  progress: number;
  stats: {
    totalFiles: number;
    questionPapers: number;
    answerKeys: number;
    matchedPapers: number;
    missingAnswerKeys: number;
    duplicates: number;
    unknownFiles: number;
  };
  results: any[];
  error?: string;
}

const jobs = new Map<string, ScanJob>();

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
  const queue: Array<{ id: string; path: string }> = [{ id: folderId, path: "" }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    let nextPageToken: string | undefined;

    do {
      const q = `'${current.id}' in parents and trashed = false and (mimeType = 'application/vnd.google-apps.folder' or mimeType = 'application/pdf')`;
      const url = new URL("https://www.googleapis.com/drive/v3/files");
      url.searchParams.append("q", q);
      url.searchParams.append("fields", "nextPageToken, files(id, name, mimeType, size, webViewLink)");
      url.searchParams.append("pageSize", "1000");
      if (nextPageToken) {
        url.searchParams.append("pageToken", nextPageToken);
      }

      const response = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
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
          const subPath = current.path ? `${current.path}/${file.name}` : file.name;
          queue.push({ id: file.id, path: subPath });
        } else if (file.mimeType === "application/pdf") {
          const sizeBytes = file.size ? parseInt(file.size, 10) : undefined;
          files.push({
            id: file.id,
            name: file.name,
            size: sizeBytes,
            webViewLink: file.webViewLink,
            path: current.path,
          });
        }
      }

      nextPageToken = data.nextPageToken;
    } while (nextPageToken);

    onFolderScanned(files.length);
  }

  return files;
}

/**
 * POST /api/import/scan
 * Admin only — Start background Google Drive folder scanning
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

      const jobId = crypto.randomUUID();
      const job: ScanJob = {
        id: jobId,
        status: "scanning",
        currentStep: "Scanning Google Drive folder...",
        progress: 5,
        stats: {
          totalFiles: 0,
          questionPapers: 0,
          answerKeys: 0,
          matchedPapers: 0,
          missingAnswerKeys: 0,
          duplicates: 0,
          unknownFiles: 0,
        },
        results: [],
      };

      jobs.set(jobId, job);
      res.json({ jobId });

      // Run scanning recursively in background
      (async () => {
        try {
          const files = await listPdfFilesRecursively(folderId, googleAccessToken, (count) => {
            job.currentStep = `Scanning folders... found ${count} PDF files`;
            job.stats.totalFiles = count;
          });

          if (files.length === 0) {
            job.status = "completed";
            job.currentStep = "Scan complete. No PDF files found.";
            job.progress = 100;
            return;
          }

          job.status = "processing";
          job.progress = 10;
          job.currentStep = `Discovered ${files.length} PDFs. Commencing extraction...`;

          const totalFiles = files.length;
          const pdfResults: any[] = [];
          let processedCount = 0;
          const concurrencyLimit = 5;

          const filesCopy = [...files];

          const runWorker = async () => {
            while (filesCopy.length > 0) {
              const file = filesCopy.shift()!;
              let localText = "";
              let localResult: ExtractionResult | null = null;
              let fileBuffer: Buffer | null = null;
              let extractionError = "";

              try {
                // Download
                const downloadUrl = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`;
                const downloadRes = await fetch(downloadUrl, {
                  headers: { Authorization: `Bearer ${googleAccessToken}` },
                });
                if (!downloadRes.ok) {
                  throw new Error(`Download failed: ${downloadRes.statusText}`);
                }
                const arrayBuffer = await downloadRes.arrayBuffer();
                fileBuffer = Buffer.from(arrayBuffer);

                // Parse
                const parser = new PDFParse({ data: fileBuffer });
                const textData = await parser.getText();
                await parser.destroy();
                localText = textData.text || "";

                // Local extract
                localResult = await localExtract(localText, file.name);
              } catch (err) {
                console.error(`Error processing file ${file.name}:`, err);
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

              const requiresAi = needsAi(finalResult);
              let usedAi = false;
              let aiUnavailable = false;

              if (requiresAi && fileBuffer) {
                const geminiApiKey = process.env.GEMINI_API_KEY;
                if (geminiApiKey) {
                  try {
                    const pdfBase64 = fileBuffer.toString("base64");
                    const highConfFields: any = {};
                    Object.keys(finalResult).forEach((key) => {
                      const field = finalResult[key as keyof ExtractionResult];
                      if (field && field.confidence >= 0.85) {
                        highConfFields[key] = field.value;
                      }
                    });

                    const apiResult = await extractMetadataViaGemini(pdfBase64, file.name, highConfFields);
                    if (apiResult) {
                      finalResult = mergeResults(finalResult, apiResult);
                      usedAi = true;
                    }
                  } catch (geminiErr) {
                    console.error(`Gemini fallback failed for ${file.name}:`, geminiErr);
                  }
                } else {
                  aiUnavailable = true;
                }
              }

              const classification = classifyFile(file.name, file.path, localText);

              pdfResults.push({
                id: file.id,
                name: file.name,
                path: file.path,
                webViewLink: file.webViewLink,
                size: file.size,
                metadata: finalResult,
                type: classification,
                error: extractionError || null,
                usedAi,
                aiUnavailable,
              });

              processedCount++;
              job.progress = Math.round(10 + (processedCount / totalFiles) * 70); // 10% to 80%
              job.currentStep = `Processed ${processedCount}/${totalFiles} files...`;
            }
          };

          const workers = Array(concurrencyLimit).fill(null).map(runWorker);
          await Promise.all(workers);

          // Pairing
          job.currentStep = "Matching Question Papers & Answer Keys...";
          job.progress = 85;

          const qps = pdfResults.filter((r) => r.type === "Question Paper");
          const aks = pdfResults.filter((r) => r.type === "Answer Key");
          const unknowns = pdfResults.filter((r) => r.type === "Unknown");

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
                  id: qp.id,
                  name: qp.name,
                  url: qp.webViewLink || `https://drive.google.com/file/d/${qp.id}/view`,
                },
                answer_key: {
                  id: bestAk.id,
                  name: bestAk.name,
                  url: bestAk.webViewLink || `https://drive.google.com/file/d/${bestAk.id}/view`,
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
                  id: qp.id,
                  name: qp.name,
                  url: qp.webViewLink || `https://drive.google.com/file/d/${qp.id}/view`,
                },
                answer_key: null,
                status: "Missing Answer Key",
                error: qp.error || null,
              });
            }
          }

          // Remaining Answer Keys that weren't paired
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
                id: ak.id,
                name: ak.name,
                url: ak.webViewLink || `https://drive.google.com/file/d/${ak.id}/view`,
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
                id: un.id,
                name: un.name,
                url: un.webViewLink || `https://drive.google.com/file/d/${un.id}/view`,
              },
              answer_key: null,
              status: "Unknown Subject",
              error: un.error || null,
            });
          }

          // Duplicate detection
          job.currentStep = "Checking duplicate papers in database...";
          job.progress = 90;

          const supabaseAdmin = getSupabaseAdmin();
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

          job.stats = {
            totalFiles: pdfResults.length,
            questionPapers: qps.length,
            answerKeys: aks.length,
            matchedPapers: matchedPapers.filter((p) => p.question_paper && p.answer_key).length,
            missingAnswerKeys: matchedPapers.filter((p) => p.question_paper && !p.answer_key).length,
            duplicates: matchedPapers.filter((p) => p.status === "Duplicate").length,
            unknownFiles: unknowns.length,
          };

          job.results = matchedPapers;
          job.status = "completed";
          job.currentStep = "Scanning and processing completed successfully.";
          job.progress = 100;
        } catch (err) {
          console.error("Background scanner error:", err);
          job.status = "failed";
          job.error = err instanceof Error ? err.message : String(err);
          job.currentStep = "Scanning failed.";
        }
      })();
    } catch (err) {
      console.error("Error starting scan:", err);
      res.status(500).json({ error: "Failed to initialize scan" });
    }
  }
);

/**
 * GET /api/import/status/:jobId
 * Admin only — Check background scanning status
 */
router.get(
  "/status/:jobId",
  requireAuth,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const jobId = req.params.jobId as string;
    const job = jobs.get(jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    res.json(job);
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
