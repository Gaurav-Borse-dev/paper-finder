import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, SlidersHorizontal, X, ArrowRight, ShieldAlert } from "lucide-react";
import { fetchLookup, fetchPapers, scorePaper, normalize } from "@/lib/db";
import { PaperCard } from "@/components/PaperCard";
import { Logo } from "@/components/Logo";
import { Footer } from "@/components/Footer";

export const Route = createFileRoute("/")({
  component: Home,
});

const PAGE_SIZE = 12;

interface Filters {
  department: string;
  semester: string;
  subject: string;
  academicYear: string;
  examType: string;
  marks: string;
  examDate: string;
}
const emptyFilters: Filters = {
  department: "",
  semester: "",
  subject: "",
  academicYear: "",
  examType: "",
  marks: "",
  examDate: "",
};

function Select({
  value, onChange, children, label, ariaLabel,
}: { value: string; onChange: (v: string) => void; children: React.ReactNode; label: string; ariaLabel?: string }) {
  return (
    <label className="flex flex-col gap-1.5 text-xs">
      <span className="font-medium text-muted-foreground">{label}</span>
      <select
        aria-label={ariaLabel ?? label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
      >
        {children}
      </select>
    </label>
  );
}
function TextInput({
  value, onChange, label, type = "text", placeholder,
}: { value: string; onChange: (v: string) => void; label: string; type?: string; placeholder?: string }) {
  return (
    <label className="flex flex-col gap-1.5 text-xs">
      <span className="font-medium text-muted-foreground">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
      />
    </label>
  );
}

function Home() {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [showFilters, setShowFilters] = useState(false);
  const [visible, setVisible] = useState(PAGE_SIZE);

  const papersQ = useQuery({ queryKey: ["papers"], queryFn: fetchPapers });
  const deptsQ = useQuery({ queryKey: ["lookup", "departments"], queryFn: () => fetchLookup<{ id: string; name: string }>("departments") });
  const yearsQ = useQuery({ queryKey: ["lookup", "academic_years"], queryFn: () => fetchLookup<{ id: string; label: string }>("academic_years") });
  const typesQ = useQuery({ queryKey: ["lookup", "exam_types"], queryFn: () => fetchLookup<{ id: string; name: string }>("exam_types") });

  const hasFilters = useMemo(
    () => Object.values(filters).some(Boolean) || query.trim().length > 0,
    [filters, query],
  );

  const activeFilterCount = useMemo(
    () => Object.values(filters).filter(Boolean).length,
    [filters],
  );

  const results = useMemo(() => {
    const list = papersQ.data ?? [];
    const q = normalize(query);
    let filtered = list.filter((p) => {
      if (filters.department && p.department !== filters.department) return false;
      if (filters.semester && String(p.semester) !== filters.semester) return false;
      if (filters.academicYear && p.academic_year !== filters.academicYear) return false;
      if (filters.examType && p.exam_type !== filters.examType) return false;
      if (filters.marks && String(p.marks) !== filters.marks) return false;
      if (filters.examDate && p.exam_date !== filters.examDate) return false;
      if (filters.subject && !normalize(p.subject).includes(normalize(filters.subject))) return false;
      return true;
    });
    if (q) {
      filtered = filtered
        .map((p) => ({ p, s: scorePaper(p, q) }))
        .filter(({ s }) => s > 0)
        .sort((a, b) => b.s - a.s)
        .map(({ p }) => p);
    }
    return filtered;
  }, [papersQ.data, query, filters]);

  const paged = results.slice(0, visible);

  const uniqueMarks = useMemo(
    () => Array.from(new Set((papersQ.data ?? []).map((p) => p.marks))).sort((a, b) => a - b),
    [papersQ.data],
  );

  const resetFilters = () => { setFilters(emptyFilters); setQuery(""); setVisible(PAGE_SIZE); };

  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <Logo />
      </header>

      <main className="mx-auto max-w-6xl px-6">
        {/* Hero + Search */}
        <section className="mt-6 text-center sm:mt-14">
          <h1 className="mx-auto max-w-3xl text-3xl font-semibold tracking-tight sm:text-5xl">
            Find Previous Year Question Papers in Seconds
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-base text-muted-foreground sm:text-lg">
            Search and download previous year question papers and answer keys instantly without
            browsing complicated folders.
          </p>

          <div className="relative mx-auto mt-8 max-w-3xl">
            <div className="flex items-center rounded-full border border-border bg-card px-5 py-3 shadow-[var(--shadow-search)] focus-within:border-primary focus-within:ring-4 focus-within:ring-primary/10">
              <Search className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
              <input
                type="search"
                value={query}
                onChange={(e) => { setQuery(e.target.value); setVisible(PAGE_SIZE); }}
                placeholder="Search Subject..."
                aria-label="Search subject"
                className="ml-3 w-full bg-transparent text-base outline-none placeholder:text-muted-foreground"
                autoFocus
              />
              {query && (
                <button
                  onClick={() => setQuery("")}
                  aria-label="Clear search"
                  className="mr-2 rounded-full p-1 text-muted-foreground hover:bg-muted"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
              <button
                onClick={() => setShowFilters((v) => !v)}
                className="ml-1 inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent"
                aria-expanded={showFilters}
                aria-label="Toggle advanced filters"
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                Filters
                {activeFilterCount > 0 && (
                  <span className="ml-1 rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
                    {activeFilterCount}
                  </span>
                )}
              </button>
            </div>

            {showFilters && (
              <div className="mt-4 rounded-2xl border border-border bg-card p-5 text-left shadow-[var(--shadow-elevated)]">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  <Select label="Department" value={filters.department} onChange={(v) => setFilters({ ...filters, department: v })}>
                    <option value="">Any</option>
                    {deptsQ.data?.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
                  </Select>
                  <Select label="Semester" value={filters.semester} onChange={(v) => setFilters({ ...filters, semester: v })}>
                    <option value="">Any</option>
                    {[1,2,3,4,5,6,7,8].map((n) => <option key={n} value={n}>Semester {n}</option>)}
                  </Select>
                  <TextInput label="Subject" placeholder="e.g. DBMS" value={filters.subject} onChange={(v) => setFilters({ ...filters, subject: v })} />
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
                  <TextInput label="Exam Date" type="date" value={filters.examDate} onChange={(v) => setFilters({ ...filters, examDate: v })} />
                </div>
                {hasFilters && (
                  <div className="mt-4 flex justify-end">
                    <button
                      onClick={resetFilters}
                      className="text-xs font-medium text-muted-foreground hover:text-foreground"
                    >
                      Clear all
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        {/* Results */}
        <section className="mt-12">
          {papersQ.isLoading && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-56 animate-pulse rounded-2xl bg-muted" />
              ))}
            </div>
          )}

          {papersQ.error && (
            <div className="mx-auto max-w-md rounded-2xl border border-destructive/30 bg-destructive/5 p-6 text-center">
              <ShieldAlert className="mx-auto h-6 w-6 text-destructive" />
              <p className="mt-2 text-sm font-medium">Couldn't load papers</p>
              <p className="mt-1 text-xs text-muted-foreground">Please check your connection and try again.</p>
            </div>
          )}

          {!papersQ.isLoading && !papersQ.error && (
            <>
              {hasFilters && (
                <div className="mb-4 flex items-center justify-between text-sm text-muted-foreground">
                  <span>
                    {results.length} result{results.length === 1 ? "" : "s"}
                  </span>
                </div>
              )}

              {results.length === 0 ? (
                <div className="mx-auto max-w-md rounded-2xl border border-border bg-card p-8 text-center">
                  {hasFilters ? (
                    <>
                      <p className="text-base font-medium">No matching papers found.</p>
                      <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
                        <li>• Check spelling</li>
                        <li>• Remove some filters</li>
                        <li>• Search another subject</li>
                      </ul>
                      <button
                        onClick={resetFilters}
                        className="mt-4 inline-flex items-center gap-1 rounded-full border border-border bg-background px-4 py-2 text-xs font-medium hover:bg-accent"
                      >
                        Reset search
                      </button>
                    </>
                  ) : (
                    <>
                      <p className="text-base font-medium">No papers yet</p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Once papers are uploaded, they'll appear here instantly.
                      </p>
                    </>
                  )}
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
        </section>

        <div className="mt-16 text-center">
          <Link to="/admin" className="text-xs text-muted-foreground/60 hover:text-muted-foreground">
            Staff area
          </Link>
        </div>
      </main>

      <Footer />
    </div>
  );
}
