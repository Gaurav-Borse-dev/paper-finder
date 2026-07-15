import { apiFetch } from "./api";

export type FeedbackCategory = "bug" | "missing_paper" | "ui_issue" | "other";

export interface FeedbackRow {
  id: string;
  name: string | null;
  email: string | null;
  message: string;
  category: string;
  created_at: string;
  user_id: string | null;
}

/**
 * Submit feedback (public — no auth required).
 */
export async function submitFeedback(payload: {
  message: string;
  category?: FeedbackCategory;
  name?: string;
  email?: string;
  user_id?: string;
}): Promise<FeedbackRow> {
  return apiFetch<FeedbackRow>("/feedback", {
    method: "POST",
    body: payload,
  });
}

/**
 * List all feedback (admin only).
 */
export async function fetchFeedback(): Promise<FeedbackRow[]> {
  return apiFetch<FeedbackRow[]>("/feedback");
}

/**
 * Delete a feedback entry (admin only).
 */
export async function deleteFeedbackById(id: string): Promise<void> {
  await apiFetch(`/feedback/${id}`, { method: "DELETE" });
}
