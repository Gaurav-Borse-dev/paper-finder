import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ShieldAlert, Filter } from "lucide-react";
import { fetchPapers } from "@/services/papers";
import { fetchLookup } from "@/services/lookups";
import { PaperCard } from "@/components/PaperCard";
import { Logo } from "@/components/Logo";
import { Footer } from "@/components/Footer";
import { UserMenu } from "@/components/UserMenu";
import { FeedbackFab } from "@/components/FeedbackFab";

export const Route = createFileRoute("/")({
  component: Home,
});

const PAGE_SIZE = 12;

interface Filters {
  department: string;
  semester: string;
  academicYear: string;
  examType: string;
  marks: string;
}
const emptyFilters: Filters = {
  department: "",
  semester: "",
  academicYear: "",
  examType: "",
  marks: "",
};

function Select({
  value, onChange, children, label,
}: { value: string; onChange: (v: string) => void; children: React.ReactNode; label: string }) {
  return (
    <label className="flex flex-col gap-1.5 text-xs">
      <span className="font-medium text-muted-foreground">{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-xl border border-border bg-background px-3 py-2.5 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
      >
        {children}
      </select>
    </label>
  );
}

function Home() {
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [visible, setVisible] = useState(PAGE_SIZE);

  const papersQ = useQuery({ queryKey: ["papers"], queryFn: fetchPapers });
  const deptsQ = useQuery({ queryKey: ["lookup", "departments"], queryFn: () => fetchLookup<{ id: string; name: string }>("departments") });
  const yearsQ = useQuery({ queryKey: ["lookup", "academic_years"], queryFn: () => fetchLookup<{ id: string; label: string }>("academic_years") });
  const typesQ = useQuery({ queryKey: ["lookup", "exam_types"], queryFn: () => fetchLookup<{ id: string; name: string }>("exam_types") });

  const hasFilters = useMemo(() => Object.values(filters).some(Boolean), [filters]);
  const activeFilterCount = useMemo(() => Object.values(filters).filter(Boolean).length, [filters]);

  const results = useMemo(() => {
    const list = papersQ.data ?? [];
    return list.filter((p) => {
      if (filters.department && p.department !== filters.department) return false;
      if (filters.semester && String(p.semester) !== filters.semester) return false;
      if (filters.academicYear && p.academic_year !== filters.academicYear) return false;
      if (filters.examType && p.exam_type !== filters.examType) return false;
      if (filters.marks && String(p.marks) !== filters.marks) return false;
      return true;
    });
  }, [papersQ.data, filters]);

  const paged = results.slice(0, visible);

  const uniqueMarks = useMemo(
    () => Array.from(new Set((papersQ.data ?? []).map((p) => p.marks))).sort((a, b) => a - b),
    [papersQ.data],
  );

  const resetFilters = () => { setFilters(emptyFilters); setVisible(PAGE_SIZE); };

  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <Logo />
        <UserMenu />
      </header>

      <main className="mx-auto max-w-6xl px-6">
        <section className="mt-4 text-center sm:mt-10">
          <h1 className="mx-auto max-w-3xl text-3xl font-semibold tracking-tight sm:text-5xl">
            Find Previous Year Question Papers
          </h1>
        </section>

        {/* Filters */}
        <section className="mx-auto mt-8 max-w-4xl">
          <div className="rounded-2xl border border-border bg-card p-5 shadow-[var(--shadow-elevated)]">
            <div className="mb-4 flex items-center justify-between">
              <div className="inline-flex items-center gap-2 text-sm font-medium">
                <Filter className="h-4 w-4 text-primary" />
                Filters
                {activeFilterCount > 0 && (
                  <span className="rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
                    {activeFilterCount}
                  </span>
                )}
              </div>
              {hasFilters && (
                <button
                  onClick={resetFilters}
                  className="text-xs font-medium text-muted-foreground hover:text-foreground"
                >
                  Clear all
                </button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <Select label="Department" value={filters.department} onChange={(v) => setFilters({ ...filters, department: v })}>
                <option value="">Any</option>
                {deptsQ.data?.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
              </Select>
              <Select label="Semester" value={filters.semester} onChange={(v) => setFilters({ ...filters, semester: v })}>
                <option value="">Any</option>
                {[1,2,3,4,5,6,7,8].map((n) => <option key={n} value={n}>Semester {n}</option>)}
              </Select>
              <Select label="Academic Year" value={filters.academicYear} onChange={(v) => setFilters({ ...filters, academicYear: v })}>
                <option value="">Any</option>
                {yearsQ.data?.map((y) => <option key={y.id} value={y.label}>{y.label}</option>)}
              </Select>
              <Select label="Exam Type" value={filters.examType} onChange={(v) => setFilters({ ...filters, examType: v })}>
                <option value="">Any</option>
                {typesQ.data?.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
              </Select>
              <Select label="Marks" value={filters.marks} onChange={(v) => setFilters({ ...filters, marks: v })}>
                <option value="">Any</option>
                {uniqueMarks.map((m) => <option key={m} value={m}>{m}</option>)}
              </Select>
            </div>
          </div>
        </section>

        {/* Results */}
        <section className="mt-10">
          {papersQ.error && (
            <div className="mx-auto max-w-md rounded-2xl border border-destructive/30 bg-destructive/5 p-6 text-center">
              <ShieldAlert className="mx-auto h-6 w-6 text-destructive" />
              <p className="mt-2 text-sm font-medium">Couldn't load papers</p>
              <p className="mt-1 text-xs text-muted-foreground">Please check your connection and try again.</p>
            </div>
          )}

          {!papersQ.error && !hasFilters && (
            <div className="mx-auto max-w-md rounded-2xl border border-border bg-card p-8 text-center">
              <Filter className="mx-auto h-8 w-8 text-primary/60" />
              <p className="mt-3 text-base font-medium">Select a filter to find papers</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Use the filters above to search by department, semester, year, exam type or marks.
              </p>
            </div>
          )}

          {!papersQ.error && hasFilters && (
            <>
              {papersQ.isLoading && (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="h-56 animate-pulse rounded-2xl bg-muted" />
                  ))}
                </div>
              )}

              {!papersQ.isLoading && (
                <>
                  <div className="mb-4 flex items-center justify-between text-sm text-muted-foreground">
                    <span>{results.length} result{results.length === 1 ? "" : "s"}</span>
                  </div>

                  {results.length === 0 ? (
                    <div className="mx-auto max-w-md rounded-2xl border border-border bg-card p-8 text-center">
                      <p className="text-base font-medium">No matching papers found.</p>
                      <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
                        <li>• Try removing a filter</li>
                        <li>• Pick a different semester or year</li>
                      </ul>
                      <button
                        onClick={resetFilters}
                        className="mt-4 inline-flex items-center gap-1 rounded-full border border-border bg-background px-4 py-2 text-xs font-medium hover:bg-accent"
                      >
                        Reset filters
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {paged.map((p) => <PaperCard key={p.id} paper={p} />)}
                      </div>
                      {results.length > visible && (
                        <div className="mt-8 text-center">
                          <button
                            onClick={() => setVisible((v) => v + PAGE_SIZE)}
                            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-5 py-2.5 text-sm font-medium hover:bg-accent"
                          >
                            Load more <ArrowRight className="h-4 w-4" />
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </>
          )}
        </section>
      </main>

      <Footer />
      <FeedbackFab />
    </div>
  );
}
