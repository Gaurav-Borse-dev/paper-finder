import { supabase } from "@/integrations/supabase/client";

export type PaperSource = "upload" | "gdrive";

export interface Paper {
  id: string;
  subject: string;
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
  created_at: string;
  updated_at: string;
}

export const STORAGE_BUCKET = "papers";

export async function fetchPapers(): Promise<Paper[]> {
  const { data, error } = await supabase
    .from("papers")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as Paper[];
}

export async function fetchPaper(id: string): Promise<Paper | null> {
  const { data, error } = await supabase.from("papers").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as Paper) ?? null;
}

export async function fetchLookup<T extends { id: string }>(
  table: "departments" | "exam_types" | "academic_years" | "subjects",
): Promise<T[]> {
  const { data, error } = await supabase.from(table).select("*").order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as T[];
}

/**
 * Resolve a paper file reference to a URL you can preview / download from the browser.
 * - For uploads we use a Supabase Storage signed URL (bucket is private).
 * - For Google Drive links we return the raw share URL — Drive helpers handle preview/download.
 */
export async function resolveFileUrl(
  source: PaperSource,
  urlOrPath: string,
): Promise<string> {
  if (source === "gdrive") return urlOrPath;
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(urlOrPath, 60 * 60);
  if (error || !data?.signedUrl) throw error ?? new Error("Failed to create signed URL");
  return data.signedUrl;
}

export async function uploadPdf(file: File, prefix = "papers"): Promise<string> {
  if (file.type !== "application/pdf") {
    throw new Error("Only PDF files are allowed.");
  }
  const path = `${prefix}/${Date.now()}-${crypto.randomUUID()}.pdf`;
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(path, file, { contentType: "application/pdf", upsert: false });
  if (error) throw error;
  return path;
}

export function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Small fuzzy score: exact/starts-with/includes/token-match, tolerant to typos. */
export function scorePaper(paper: Paper, query: string): number {
  if (!query) return 0;
  const q = normalize(query);
  const subject = normalize(paper.subject);
  const desc = normalize(paper.description ?? "");
  if (subject === q) return 100;
  if (subject.startsWith(q)) return 80;
  if (subject.includes(q)) return 60;
  const tokens = q.split(" ").filter(Boolean);
  const matched = tokens.filter((t) => subject.includes(t) || desc.includes(t)).length;
  if (matched > 0) return 20 + matched * 5;
  // very light typo tolerance: single-char difference
  if (Math.abs(subject.length - q.length) <= 2) {
    let diffs = 0;
    for (let i = 0; i < Math.min(subject.length, q.length); i++) {
      if (subject[i] !== q[i]) diffs++;
      if (diffs > 2) break;
    }
    if (diffs <= 2) return 15;
  }
  return 0;
}
