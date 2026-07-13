import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Trash2, Upload, Edit2, X, Plus, LayoutDashboard, FileUp, ListChecks, Search,
  ShieldAlert, MessageSquare, Sparkles, Loader2, CheckCircle2, AlertCircle,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { fetchLookup, fetchPapers, STORAGE_BUCKET, uploadPdf, type Paper, type PaperSource } from "@/lib/db";
import { isValidDriveUrl } from "@/lib/gdrive";
import { Logo } from "@/components/Logo";
import { Footer } from "@/components/Footer";
import { useSession } from "@/lib/auth";
import { extractPdfMetadata, type ExtractionResult, type ExtractionField } from "@/lib/extract.functions";
import { useServerFn } from "@tanstack/react-start";

export const Route = createFileRoute("/_authenticated/admin")({
  component: Admin,
});

type Tab = "dashboard" | "upload" | "manage" | "lookups" | "feedback";

function Admin() {
  const session = useSession();
  const [tab, setTab] = useState<Tab>("dashboard");
  const [editing, setEditing] = useState<Paper | null>(null);

  if (!session.ready) {
    return <div className="flex min-h-screen items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  if (session.role !== "admin") {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="max-w-sm rounded-2xl border border-border bg-card p-8 text-center shadow-[var(--shadow-elevated)]">
          <ShieldAlert className="mx-auto h-8 w-8 text-destructive" />
          <h1 className="mt-3 text-lg font-semibold">Admins only</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            You're signed in as <b>{session.role}</b>. This area is restricted to admin accounts.
          </p>
          <Link
            to="/"
            className="mt-5 inline-flex rounded-full bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Back to search
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Logo />
          <div className="flex items-center gap-2 text-xs">
            <span className="rounded-full bg-muted px-2.5 py-1 font-medium text-muted-foreground">Admin</span>
            <Link to="/" className="rounded-full border border-border px-3 py-1 font-medium hover:bg-accent">View site</Link>
          </div>
        </div>
        <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-6 pb-3">
          <TabButton current={tab} me="dashboard" onClick={setTab} icon={<LayoutDashboard className="h-4 w-4" />}>Dashboard</TabButton>
          <TabButton current={tab} me="upload" onClick={setTab} icon={<FileUp className="h-4 w-4" />}>Upload Paper</TabButton>
          <TabButton current={tab} me="manage" onClick={setTab} icon={<Search className="h-4 w-4" />}>Manage Papers</TabButton>
          <TabButton current={tab} me="lookups" onClick={setTab} icon={<ListChecks className="h-4 w-4" />}>Lookups</TabButton>
          <TabButton current={tab} me="feedback" onClick={setTab} icon={<MessageSquare className="h-4 w-4" />}>Feedback</TabButton>
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        {tab === "dashboard" && <Dashboard onGoUpload={() => setTab("upload")} />}
        {tab === "upload" && <UploadForm initial={editing} onDone={() => { setEditing(null); setTab("manage"); }} />}
        {tab === "manage" && <ManagePapers onEdit={(p) => { setEditing(p); setTab("upload"); }} />}
        {tab === "lookups" && <ManageLookups />}
        {tab === "feedback" && <FeedbackList />}
      </main>
      <Footer />
    </div>
  );
}

function TabButton({ current, me, onClick, children, icon }: {
  current: Tab; me: Tab; onClick: (t: Tab) => void; children: React.ReactNode; icon: React.ReactNode;
}) {
  const active = current === me;
  return (
    <button
      onClick={() => onClick(me)}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
        active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
    >
      {icon}{children}
    </button>
  );
}

function Dashboard({ onGoUpload }: { onGoUpload: () => void }) {
  const { data: papers } = useQuery({ queryKey: ["papers"], queryFn: fetchPapers });
  const total = papers?.length ?? 0;
  const withKey = papers?.filter((p) => p.answer_key_url).length ?? 0;
  const recent = papers?.slice(0, 5) ?? [];
  return (
    <div className="space-y-8">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Total Papers" value={total} />
        <Stat label="With Answer Key" value={withKey} />
        <Stat label="Missing Answer Key" value={total - withKey} />
      </div>
      <div className="flex flex-wrap gap-2">
        <button onClick={onGoUpload} className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
          <Upload className="h-4 w-4" /> Upload New Paper
        </button>
      </div>
      <section>
        <h2 className="mb-3 text-sm font-semibold text-muted-foreground">Recent uploads</h2>
        <div className="rounded-2xl border border-border bg-card">
          {recent.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">No papers yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {recent.map((p) => (
                <li key={p.id} className="flex items-center justify-between px-5 py-3 text-sm">
                  <div>
                    <p className="font-medium">{p.subject}</p>
                    <p className="text-xs text-muted-foreground">
                      {p.department} · Sem {p.semester} · {p.academic_year} · {p.exam_type}
                    </p>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {new Date(p.created_at).toLocaleDateString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 text-3xl font-semibold tracking-tight">{value}</p>
    </div>
  );
}

/* -------- Upload / Edit -------- */

interface FormState {
  subject: string; subjectCode: string; department: string; semester: string; academicYear: string;
  examType: string; marks: string; examDate: string; description: string;
  qpSource: PaperSource; qpFile: File | null; qpUrl: string;
  akEnabled: boolean;
  akSource: PaperSource; akFile: File | null; akUrl: string;
}
const emptyForm: FormState = {
  subject: "", subjectCode: "", department: "", semester: "", academicYear: "",
  examType: "", marks: "", examDate: "", description: "",
  qpSource: "upload", qpFile: null, qpUrl: "",
  akEnabled: false,
  akSource: "upload", akFile: null, akUrl: "",
};

type ExtractStep =
  | { kind: "idle" }
  | { kind: "running"; step: string }
  | { kind: "done"; result: ExtractionResult }
  | { kind: "error"; message: string };

function UploadForm({ initial, onDone }: { initial: Paper | null; onDone: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState>(emptyForm);
  const [extract, setExtract] = useState<ExtractStep>({ kind: "idle" });
  const deptsQ = useQuery({ queryKey: ["lookup", "departments"], queryFn: () => fetchLookup<{ id: string; name: string }>("departments") });
  const yearsQ = useQuery({ queryKey: ["lookup", "academic_years"], queryFn: () => fetchLookup<{ id: string; label: string }>("academic_years") });
  const typesQ = useQuery({ queryKey: ["lookup", "exam_types"], queryFn: () => fetchLookup<{ id: string; name: string }>("exam_types") });

  const runExtract = useServerFn(extractPdfMetadata);

  useEffect(() => {
    if (initial) {
      setForm({
        subject: initial.subject,
        subjectCode: "",
        department: initial.department,
        semester: String(initial.semester),
        academicYear: initial.academic_year,
        examType: initial.exam_type,
        marks: String(initial.marks),
        examDate: initial.exam_date ?? "",
        description: initial.description ?? "",
        qpSource: initial.question_paper_source,
        qpFile: null,
        qpUrl: initial.question_paper_source === "gdrive" ? initial.question_paper_url : "",
        akEnabled: !!initial.answer_key_url,
        akSource: initial.answer_key_source ?? "upload",
        akFile: null,
        akUrl: initial.answer_key_source === "gdrive" ? (initial.answer_key_url ?? "") : "",
      });
    } else {
      setForm(emptyForm);
    }
    setExtract({ kind: "idle" });
  }, [initial]);

  // Trigger AI extraction when a new QP file is picked
  const handleQpFile = async (file: File | null) => {
    setForm((f) => ({ ...f, qpFile: file }));
    if (!file || file.type !== "application/pdf") {
      setExtract({ kind: "idle" });
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setExtract({ kind: "error", message: "PDF too large (max 20MB) — please fill fields manually." });
      return;
    }
    try {
      setExtract({ kind: "running", step: "Reading pages…" });
      const base64 = await fileToBase64(file);
      setExtract({ kind: "running", step: "Analyzing with AI…" });
      const res = await runExtract({ data: { pdfBase64: base64, filename: file.name } });
      if (!res.ok) {
        setExtract({ kind: "error", message: res.error });
        return;
      }
      setExtract({ kind: "running", step: "Auto-filling form…" });
      applyExtraction(res.result);
      setExtract({ kind: "done", result: res.result });
      toast.success("Metadata extracted");
    } catch (e) {
      setExtract({ kind: "error", message: e instanceof Error ? e.message : "Extraction failed" });
    }
  };

  const applyExtraction = (r: ExtractionResult) => {
    setForm((prev) => ({
      ...prev,
      subject: prev.subject || r.subject.value || "",
      subjectCode: prev.subjectCode || r.subject_code.value || "",
      department: prev.department || matchLookup(deptsQ.data ?? [], "name", r.department.value) || "",
      semester: prev.semester || (r.semester.value ? String(r.semester.value) : ""),
      academicYear: prev.academicYear || matchLookup(yearsQ.data ?? [], "label", r.academic_year.value) || r.academic_year.value || "",
      examType: prev.examType || matchLookup(typesQ.data ?? [], "name", r.exam_type.value) || r.exam_type.value || "",
      marks: prev.marks || (r.marks.value ? String(r.marks.value) : ""),
      examDate: prev.examDate || r.exam_date.value || "",
    }));
  };

  const mutation = useMutation({
    mutationFn: async () => {
      if (!form.subject || !form.department || !form.semester || !form.academicYear || !form.examType || !form.marks) {
        throw new Error("Please fill all required fields.");
      }
      let qpUrl = form.qpSource === "gdrive" ? form.qpUrl.trim() : "";
      if (form.qpSource === "gdrive") {
        if (!qpUrl) throw new Error("Question paper Drive link is required.");
        if (!isValidDriveUrl(qpUrl)) throw new Error("Question paper Drive link is invalid.");
      } else {
        if (form.qpFile) qpUrl = await uploadPdf(form.qpFile);
        else if (initial?.question_paper_source === "upload") qpUrl = initial.question_paper_url;
        else throw new Error("Please upload the question paper PDF.");
      }
      let akSource: PaperSource | null = null;
      let akUrl: string | null = null;
      if (form.akEnabled) {
        akSource = form.akSource;
        if (form.akSource === "gdrive") {
          akUrl = form.akUrl.trim();
          if (!akUrl) throw new Error("Answer key Drive link is required.");
          if (!isValidDriveUrl(akUrl)) throw new Error("Answer key Drive link is invalid.");
        } else {
          if (form.akFile) akUrl = await uploadPdf(form.akFile);
          else if (initial?.answer_key_source === "upload" && initial.answer_key_url) akUrl = initial.answer_key_url;
          else throw new Error("Please upload the answer key PDF.");
        }
      }

      const confidenceMap = extract.kind === "done" ? extractionToJson(extract.result) : null;

      const payload = {
        subject: form.subject.trim(),
        subject_code: form.subjectCode.trim() || null,
        department: form.department,
        semester: parseInt(form.semester, 10),
        academic_year: form.academicYear,
        exam_type: form.examType,
        marks: parseInt(form.marks, 10),
        exam_date: form.examDate || null,
        description: form.description || null,
        question_paper_source: form.qpSource,
        question_paper_url: qpUrl,
        answer_key_source: akSource,
        answer_key_url: akUrl,
        extraction_confidence: confidenceMap,
      };

      if (initial) {
        const { error } = await supabase.from("papers").update(payload).eq("id", initial.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("papers").insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success(initial ? "Paper updated" : "Paper uploaded");
      qc.invalidateQueries({ queryKey: ["papers"] });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message ?? "Something went wrong"),
  });

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); mutation.mutate(); }}
      className="mx-auto max-w-3xl space-y-6 rounded-2xl border border-border bg-card p-6 sm:p-8"
    >
      <div>
        <h2 className="text-xl font-semibold tracking-tight">{initial ? "Edit Paper" : "Upload New Paper"}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick a Question Paper PDF and the AI will auto-fill the form. Review every field before saving.
        </p>
      </div>

      <FileSection
        title="Question Paper"
        source={form.qpSource}
        onSource={(s) => setForm({ ...form, qpSource: s })}
        file={form.qpFile}
        onFile={handleQpFile}
        url={form.qpUrl}
        onUrl={(u) => setForm({ ...form, qpUrl: u })}
        existingHint={initial?.question_paper_source === "upload" ? "Existing file will be kept if you don't choose a new one." : undefined}
        required
      />

      <ExtractionBanner state={extract} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Subject *" confidence={confOf(extract, "subject")}>
          <input required value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} className={inputCls} placeholder="e.g. Database Management Systems" />
        </Field>
        <Field label="Subject Code" confidence={confOf(extract, "subject_code")}>
          <input value={form.subjectCode} onChange={(e) => setForm({ ...form, subjectCode: e.target.value })} className={inputCls} placeholder="e.g. CS601" />
        </Field>
        <Field label="Department *" confidence={confOf(extract, "department")}>
          <select required value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} className={inputCls}>
            <option value="">Select</option>
            {deptsQ.data?.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
          </select>
        </Field>
        <Field label="Semester *" confidence={confOf(extract, "semester")}>
          <select required value={form.semester} onChange={(e) => setForm({ ...form, semester: e.target.value })} className={inputCls}>
            <option value="">Select</option>
            {[1,2,3,4,5,6,7,8].map((n) => <option key={n} value={n}>Semester {n}</option>)}
          </select>
        </Field>
        <Field label="Academic Year *" confidence={confOf(extract, "academic_year")}>
          <select required value={form.academicYear} onChange={(e) => setForm({ ...form, academicYear: e.target.value })} className={inputCls}>
            <option value="">Select</option>
            {yearsQ.data?.map((y) => <option key={y.id} value={y.label}>{y.label}</option>)}
          </select>
        </Field>
        <Field label="Exam Type *" confidence={confOf(extract, "exam_type")}>
          <select required value={form.examType} onChange={(e) => setForm({ ...form, examType: e.target.value })} className={inputCls}>
            <option value="">Select</option>
            {typesQ.data?.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
          </select>
        </Field>
        <Field label="Marks *" confidence={confOf(extract, "marks")}>
          <input required type="number" min={1} value={form.marks} onChange={(e) => setForm({ ...form, marks: e.target.value })} className={inputCls} placeholder="e.g. 60" />
        </Field>
        <Field label="Exam Date" confidence={confOf(extract, "exam_date")}>
          <input type="date" value={form.examDate} onChange={(e) => setForm({ ...form, examDate: e.target.value })} className={inputCls} />
        </Field>
        <Field label="Description" className="sm:col-span-2">
          <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={inputCls} rows={3} placeholder="Optional notes / keywords" />
        </Field>
      </div>

      <div className="rounded-2xl border border-border bg-background p-4">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={form.akEnabled} onChange={(e) => setForm({ ...form, akEnabled: e.target.checked })} />
          Include Answer Key
        </label>
        {form.akEnabled && (
          <div className="mt-4">
            <FileSection
              title="Answer Key"
              source={form.akSource}
              onSource={(s) => setForm({ ...form, akSource: s })}
              file={form.akFile}
              onFile={(f) => setForm({ ...form, akFile: f })}
              url={form.akUrl}
              onUrl={(u) => setForm({ ...form, akUrl: u })}
              existingHint={initial?.answer_key_source === "upload" ? "Existing file will be kept if you don't choose a new one." : undefined}
              nested
            />
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onDone} className="rounded-full border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-accent">Cancel</button>
        <button
          type="submit"
          disabled={mutation.isPending || extract.kind === "running"}
          className="inline-flex items-center gap-1.5 rounded-full bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          <Upload className="h-4 w-4" />
          {mutation.isPending ? "Saving..." : initial ? "Save Changes" : "Upload Paper"}
        </button>
      </div>
    </form>
  );
}

function ExtractionBanner({ state }: { state: ExtractStep }) {
  if (state.kind === "idle") return null;
  if (state.kind === "running") {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-primary/30 bg-primary/5 px-4 py-3 text-sm">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        <span className="font-medium">AI extraction in progress</span>
        <span className="text-muted-foreground">— {state.step}</span>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="flex items-start gap-3 rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <div>
          <p className="font-medium">Unable to automatically extract metadata.</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{state.message} — please enter the information manually.</p>
        </div>
      </div>
    );
  }
  const nonEmpty = Object.values(state.result).filter((f) => f.value !== null).length;
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-sm">
      <CheckCircle2 className="h-4 w-4 text-emerald-600" />
      <span className="font-medium">Extraction complete</span>
      <span className="text-muted-foreground">— {nonEmpty} field{nonEmpty === 1 ? "" : "s"} detected. Review each value below before saving.</span>
    </div>
  );
}

function confOf(state: ExtractStep, key: keyof ExtractionResult): number | null {
  if (state.kind !== "done") return null;
  const f = state.result[key] as ExtractionField<unknown>;
  return f.value === null ? -1 : f.confidence;
}

function matchLookup<T extends Record<string, string>>(list: T[], key: keyof T, value: string | null): string | null {
  if (!value) return null;
  const v = value.toLowerCase().trim();
  const hit = list.find((row) => String(row[key]).toLowerCase() === v);
  return hit ? String(hit[key]) : null;
}

function extractionToJson(r: ExtractionResult): Record<string, { value: unknown; confidence: number }> {
  const out: Record<string, { value: unknown; confidence: number }> = {};
  (Object.keys(r) as Array<keyof ExtractionResult>).forEach((k) => {
    const f = r[k] as ExtractionField<unknown>;
    out[k as string] = { value: f.value, confidence: f.confidence };
  });
  return out;
}

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

const inputCls = "w-full rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20";

function Field({ label, children, className = "", confidence }: {
  label: string; children: React.ReactNode; className?: string; confidence?: number | null;
}) {
  return (
    <label className={`flex flex-col gap-1.5 text-xs ${className}`}>
      <span className="flex items-center justify-between font-medium text-muted-foreground">
        <span>{label}</span>
        <ConfidenceBadge confidence={confidence} />
      </span>
      {children}
    </label>
  );
}

function ConfidenceBadge({ confidence }: { confidence?: number | null }) {
  if (confidence === null || confidence === undefined) return null;
  if (confidence === -1) {
    return <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">Not Detected</span>;
  }
  const pct = Math.round(confidence * 100);
  const color = pct >= 85 ? "bg-emerald-500/10 text-emerald-700" : pct >= 60 ? "bg-amber-500/10 text-amber-700" : "bg-destructive/10 text-destructive";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${color}`}>
      <Sparkles className="h-2.5 w-2.5" /> {pct}%
    </span>
  );
}

function FileSection({
  title, source, onSource, file, onFile, url, onUrl, existingHint, required, nested,
}: {
  title: string;
  source: PaperSource;
  onSource: (s: PaperSource) => void;
  file: File | null;
  onFile: (f: File | null) => void;
  url: string;
  onUrl: (u: string) => void;
  existingHint?: string;
  required?: boolean;
  nested?: boolean;
}) {
  return (
    <div className={nested ? "" : "rounded-2xl border border-border bg-background p-4"}>
      {!nested && <p className="mb-2 text-sm font-medium">{title}</p>}
      <div className="flex gap-4 text-sm">
        <label className="flex cursor-pointer items-center gap-1.5">
          <input type="radio" checked={source === "upload"} onChange={() => onSource("upload")} />
          Upload PDF
        </label>
        <label className="flex cursor-pointer items-center gap-1.5">
          <input type="radio" checked={source === "gdrive"} onChange={() => onSource("gdrive")} />
          Google Drive Link
        </label>
      </div>
      <div className="mt-3">
        {source === "upload" ? (
          <>
            <input
              type="file"
              accept="application/pdf"
              onChange={(e) => onFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm file:mr-3 file:rounded-full file:border-0 file:bg-primary file:px-4 file:py-1.5 file:text-sm file:font-medium file:text-primary-foreground hover:file:opacity-90"
            />
            {file && <p className="mt-1 text-xs text-muted-foreground">{file.name} ({(file.size / 1024).toFixed(0)} KB)</p>}
            {!file && existingHint && <p className="mt-1 text-xs text-muted-foreground">{existingHint}</p>}
          </>
        ) : (
          <input
            type="url"
            required={required}
            value={url}
            onChange={(e) => onUrl(e.target.value)}
            className={inputCls}
            placeholder="https://drive.google.com/file/d/..."
          />
        )}
      </div>
    </div>
  );
}

/* -------- Manage Papers -------- */

function ManagePapers({ onEdit }: { onEdit: (p: Paper) => void }) {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const { data: papers } = useQuery({ queryKey: ["papers"], queryFn: fetchPapers });
  const filtered = useMemo(() => {
    const s = q.toLowerCase().trim();
    if (!s) return papers ?? [];
    return (papers ?? []).filter((p) =>
      [p.subject, p.department, p.exam_type, p.academic_year].some((v) => v.toLowerCase().includes(s)),
    );
  }, [papers, q]);

  const del = useMutation({
    mutationFn: async (p: Paper) => {
      const paths: string[] = [];
      if (p.question_paper_source === "upload") paths.push(p.question_paper_url);
      if (p.answer_key_source === "upload" && p.answer_key_url) paths.push(p.answer_key_url);
      if (paths.length) await supabase.storage.from(STORAGE_BUCKET).remove(paths);
      const { error } = await supabase.from("papers").delete().eq("id", p.id);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Deleted"); qc.invalidateQueries({ queryKey: ["papers"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 shadow-[var(--shadow-elevated)]">
        <Search className="h-4 w-4 text-muted-foreground" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search subject, department, year..." className="w-full bg-transparent text-sm outline-none" />
      </div>
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        {filtered.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">No papers found.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Subject</th>
                <th className="px-4 py-3 text-left font-medium">Dept</th>
                <th className="px-4 py-3 text-left font-medium">Sem</th>
                <th className="px-4 py-3 text-left font-medium">Year</th>
                <th className="px-4 py-3 text-left font-medium">Type</th>
                <th className="px-4 py-3 text-left font-medium">Marks</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((p) => (
                <tr key={p.id} className="hover:bg-muted/30">
                  <td className="px-4 py-3 font-medium">{p.subject}</td>
                  <td className="px-4 py-3 text-muted-foreground">{p.department}</td>
                  <td className="px-4 py-3 text-muted-foreground">{p.semester}</td>
                  <td className="px-4 py-3 text-muted-foreground">{p.academic_year}</td>
                  <td className="px-4 py-3 text-muted-foreground">{p.exam_type}</td>
                  <td className="px-4 py-3 text-muted-foreground">{p.marks}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      <button onClick={() => onEdit(p)} className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1 text-xs font-medium hover:bg-accent">
                        <Edit2 className="h-3 w-3" /> Edit
                      </button>
                      <button onClick={() => { if (confirm(`Delete "${p.subject}"?`)) del.mutate(p); }} className="inline-flex items-center gap-1 rounded-full border border-destructive/30 bg-destructive/5 px-3 py-1 text-xs font-medium text-destructive hover:bg-destructive/10">
                        <Trash2 className="h-3 w-3" /> Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/* -------- Manage Lookups -------- */

function ManageLookups() {
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <LookupList table="departments" title="Departments" column="name" />
      <LookupList table="exam_types" title="Exam Types" column="name" />
      <LookupList table="academic_years" title="Academic Years" column="label" placeholder="e.g. 2024-25" />
      <LookupList table="subjects" title="Subjects" column="name" />
    </div>
  );
}

function LookupList({ table, title, column, placeholder }: {
  table: "departments" | "exam_types" | "academic_years" | "subjects";
  title: string; column: "name" | "label"; placeholder?: string;
}) {
  const qc = useQueryClient();
  const [value, setValue] = useState("");
  const { data } = useQuery({ queryKey: ["lookup", table], queryFn: () => fetchLookup<{ id: string } & Record<string, string>>(table) });

  const add = useMutation({
    mutationFn: async () => {
      const v = value.trim();
      if (!v) throw new Error("Value required");
      const { error } = await supabase.from(table).insert({ [column]: v } as never);
      if (error) throw error;
    },
    onSuccess: () => { setValue(""); qc.invalidateQueries({ queryKey: ["lookup", table] }); },
    onError: (e: Error) => toast.error(e.message),
  });
  const del = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from(table).delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lookup", table] }),
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <h3 className="text-sm font-semibold">{title}</h3>
      <form onSubmit={(e) => { e.preventDefault(); add.mutate(); }} className="mt-3 flex gap-2">
        <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder ?? `Add ${title.toLowerCase().slice(0, -1)}`} className={inputCls} />
        <button className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:opacity-90">
          <Plus className="h-3.5 w-3.5" /> Add
        </button>
      </form>
      <ul className="mt-4 divide-y divide-border">
        {data?.length === 0 && <li className="py-2 text-xs text-muted-foreground">Empty</li>}
        {data?.map((row) => (
          <li key={row.id} className="flex items-center justify-between py-2 text-sm">
            <span>{(row as Record<string, string>)[column]}</span>
            <button onClick={() => { if (confirm("Delete?")) del.mutate(row.id); }} className="rounded-full p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" aria-label="Delete">
              <X className="h-4 w-4" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------- Feedback -------- */

interface FeedbackRow {
  id: string; name: string | null; email: string | null; message: string;
  category: string; created_at: string; user_id: string | null;
}

function FeedbackList() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["feedbacks"],
    queryFn: async () => {
      const { data, error } = await supabase.from("feedbacks").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as FeedbackRow[];
    },
  });
  const del = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("feedbacks").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Deleted"); qc.invalidateQueries({ queryKey: ["feedbacks"] }); },
  });
  return (
    <div className="rounded-2xl border border-border bg-card">
      {(data?.length ?? 0) === 0 ? (
        <p className="p-6 text-sm text-muted-foreground">No feedback yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {data?.map((f) => (
            <li key={f.id} className="flex items-start justify-between gap-4 p-5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-xs">
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary">{f.category}</span>
                  <span className="text-muted-foreground">{new Date(f.created_at).toLocaleString()}</span>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm">{f.message}</p>
                {(f.name || f.email) && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {f.name}{f.email ? ` · ${f.email}` : ""}
                  </p>
                )}
              </div>
              <button onClick={() => { if (confirm("Delete this feedback?")) del.mutate(f.id); }} className="rounded-full p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
