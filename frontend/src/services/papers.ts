import { apiFetch } from "./api";

export type PaperSource = "upload" | "gdrive";

export interface Paper {
  id: string;
  subject: string;
  subject_code: string | null;
  department: string;
  semester: number;
  academic_year: string;
  exam_type: string;
  marks: number;
  exam_date: string | null;
  description: string | null;
  question_paper_source: PaperSource;
  question_paper_url: string;
  answer_key_source: PaperSource | null;
  answer_key_url: string | null;
  extraction_confidence: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

/**
 * Fetch all papers.
 */
export async function fetchPapers(): Promise<Paper[]> {
  return apiFetch<Paper[]>("/papers");
}

/**
 * Fetch a single paper by ID.
 */
export async function fetchPaper(id: string): Promise<Paper | null> {
  try {
    return await apiFetch<Paper>(`/papers/${id}`);
  } catch {
    return null;
  }
}

/**
 * Get a signed/viewable URL for a paper file.
 */
export async function getFileUrl(
  paperId: string,
  type: "question" | "answer" = "question"
): Promise<{ url: string; source: PaperSource }> {
  return apiFetch<{ url: string; source: PaperSource }>(
    `/papers/${paperId}/file-url?type=${type}`
  );
}

/**
 * Upload a PDF file and get the storage path.
 */
export async function uploadPdf(file: File): Promise<string> {
  const formData = new FormData();
  formData.append("file", file);

  const data = await apiFetch<{ path: string }>("/upload", {
    method: "POST",
    body: formData,
  });
  return data.path;
}

/**
 * Create a new paper.
 */
export async function createPaper(
  payload: Omit<Paper, "id" | "created_at" | "updated_at">
): Promise<Paper> {
  return apiFetch<Paper>("/papers", {
    method: "POST",
    body: payload,
  });
}

/**
 * Update an existing paper.
 */
export async function updatePaper(
  id: string,
  payload: Partial<Paper>
): Promise<Paper> {
  return apiFetch<Paper>(`/papers/${id}`, {
    method: "PUT",
    body: payload,
  });
}

/**
 * Delete a paper.
 */
export async function deletePaper(id: string): Promise<void> {
  await apiFetch(`/papers/${id}`, { method: "DELETE" });
}

/**
 * AI-powered PDF metadata extraction.
 */
export interface ExtractionField<T> {
  value: T | null;
  confidence: number;
}

export interface ExtractionResult {
  subject: ExtractionField<string>;
  subject_code: ExtractionField<string>;
  department: ExtractionField<string>;
  semester: ExtractionField<number>;
  academic_year: ExtractionField<string>;
  exam_type: ExtractionField<
    "ESE" | "RE-ESE" | "Supplementary" | "Complementary"
  >;
  marks: ExtractionField<number>;
  exam_date: ExtractionField<string>;
  exam_month: ExtractionField<string>;
  exam_year: ExtractionField<number>;
}

export async function extractPdfMetadata(
  payload: { pdfBase64?: string; gdriveUrl?: string; filename?: string } | string,
  filenameParam?: string
): Promise<
  | { ok: true; result: ExtractionResult; usedAi?: boolean; aiUnavailable?: boolean }
  | { ok: false; error: string }
> {
  const body = typeof payload === "string" 
    ? { pdfBase64: payload, filename: filenameParam } 
    : payload;
  return apiFetch("/extract", {
    method: "POST",
    body,
  });
}
