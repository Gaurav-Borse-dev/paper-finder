import { apiFetch } from "./api";

/**
 * Fetch all entries from a lookup table.
 */
export async function fetchLookup<T>(
  table: "departments" | "exam_types" | "academic_years" | "subjects"
): Promise<T[]> {
  return apiFetch<T[]>(`/lookups/${table}`);
}

/**
 * Add an entry to a lookup table (admin only).
 */
export async function addLookup(
  table: "departments" | "exam_types" | "academic_years" | "subjects",
  value: string
): Promise<unknown> {
  return apiFetch(`/lookups/${table}`, {
    method: "POST",
    body: { value },
  });
}

/**
 * Delete an entry from a lookup table (admin only).
 */
export async function deleteLookup(
  table: "departments" | "exam_types" | "academic_years" | "subjects",
  id: string
): Promise<void> {
  await apiFetch(`/lookups/${table}/${id}`, { method: "DELETE" });
}
