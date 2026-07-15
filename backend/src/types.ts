import type { Request } from "express";

// ── Paper types ──
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

// ── Auth types ──
export type Role = "guest" | "student" | "admin";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

// Extend Express Request to include authenticated user
export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
}

// ── Extraction types ──
export interface ExtractionField<T> {
  value: T | null;
  confidence: number; // 0..1
}

export interface ExtractionResult {
  subject: ExtractionField<string>;
  subject_code: ExtractionField<string>;
  department: ExtractionField<string>;
  semester: ExtractionField<number>;
  academic_year: ExtractionField<string>;
  exam_type: ExtractionField<"ESE" | "RE-ESE" | "Supplementary" | "Complementary">;
  marks: ExtractionField<number>;
  exam_date: ExtractionField<string>; // ISO YYYY-MM-DD
  exam_month: ExtractionField<string>;
  exam_year: ExtractionField<number>;
}

// ── Lookup types ──
export type LookupTable = "departments" | "exam_types" | "academic_years" | "subjects";

// ── Feedback types ──
export type FeedbackCategory = "bug" | "missing_paper" | "ui_issue" | "other";

export interface Feedback {
  id: string;
  name: string | null;
  email: string | null;
  message: string;
  category: string;
  user_id: string | null;
  created_at: string;
}
