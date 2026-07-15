import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Calendar, Download, ExternalLink } from "lucide-react";
import { useState } from "react";
import { fetchPaper, getFileUrl } from "@/services/papers";
import { driveDownloadUrl, driveOpenUrl } from "@/lib/gdrive";
import { PdfViewer } from "@/components/PdfViewer";
import { Logo } from "@/components/Logo";
import { Footer } from "@/components/Footer";

export const Route = createFileRoute("/paper/$id")({
  component: PaperDetail,
});

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
      {children}
    </span>
  );
}

async function openResolved(paperId: string, source: "upload" | "gdrive", url: string, type: "question" | "answer") {
  try {
    if (source === "gdrive") {
      window.open(driveOpenUrl(url), "_blank", "noopener,noreferrer");
    } else {
      const data = await getFileUrl(paperId, type);
      window.open(data.url, "_blank", "noopener,noreferrer");
    }
  } catch { window.open(url, "_blank", "noopener,noreferrer"); }
}

async function downloadResolved(paperId: string, source: "upload" | "gdrive", url: string, type: "question" | "answer") {
  try {
    let target: string;
    if (source === "gdrive") {
      target = driveDownloadUrl(url);
    } else {
      const data = await getFileUrl(paperId, type);
      target = data.url;
    }
    const a = document.createElement("a");
    a.href = target; a.rel = "noopener noreferrer"; a.target = "_blank";
    document.body.appendChild(a); a.click(); a.remove();
  } catch { window.open(url, "_blank", "noopener,noreferrer"); }
}

function PaperDetail() {
  const { id } = Route.useParams();
  const { data: paper, isLoading, error } = useQuery({
    queryKey: ["paper", id],
    queryFn: () => fetchPaper(id),
  });

  const [tab, setTab] = useState<"question" | "answer">("question");

  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-6">
        <Logo />
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to search
        </Link>
      </header>

      <main className="mx-auto max-w-5xl px-6 pb-16">
        {isLoading && <div className="h-40 animate-pulse rounded-2xl bg-muted" />}
        {error && (
          <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
            Couldn't load this paper.
          </div>
        )}
        {paper && (
          <>
            <section className="rounded-3xl border border-border bg-card p-6 sm:p-8 shadow-[var(--shadow-elevated)]">
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{paper.subject}</h1>
              <div className="mt-3 flex flex-wrap gap-2">
                <Chip>{paper.department}</Chip>
                <Chip>Semester {paper.semester}</Chip>
                <Chip>{paper.academic_year}</Chip>
                <Chip>{paper.exam_type}</Chip>
                <Chip>{paper.marks} marks</Chip>
                {paper.exam_date && (
                  <Chip>
                    <Calendar className="mr-1 inline h-3 w-3" />
                    {new Date(paper.exam_date).toLocaleDateString()}
                  </Chip>
                )}
              </div>
              {paper.description && (
                <p className="mt-4 max-w-3xl text-sm leading-relaxed text-muted-foreground">
                  {paper.description}
                </p>
              )}

              <div className="mt-6 flex flex-wrap gap-2 border-b border-border">
                <button
                  onClick={() => setTab("question")}
                  className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
                    tab === "question" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Question Paper
                </button>
                <button
                  onClick={() => setTab("answer")}
                  disabled={!paper.answer_key_url}
                  className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors disabled:opacity-40 ${
                    tab === "answer" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Answer Key
                  {!paper.answer_key_url && <span className="ml-1 text-xs">(not available)</span>}
                </button>
              </div>

              {tab === "question" ? (
                <div className="mt-6 space-y-4">
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => downloadResolved(paper.id, paper.question_paper_source, paper.question_paper_url, "question")}
                      className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
                    >
                      <Download className="h-4 w-4" /> Download
                    </button>
                    <button
                      onClick={() => openResolved(paper.id, paper.question_paper_source, paper.question_paper_url, "question")}
                      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-accent"
                    >
                      <ExternalLink className="h-4 w-4" /> Open
                    </button>
                  </div>
                  <PdfViewer
                    paperId={paper.id}
                    source={paper.question_paper_source}
                    url={paper.question_paper_url}
                    type="question"
                    title={`${paper.subject} — Question Paper`}
                  />
                </div>
              ) : paper.answer_key_url && paper.answer_key_source ? (
                <div className="mt-6 space-y-4">
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => downloadResolved(paper.id, paper.answer_key_source!, paper.answer_key_url!, "answer")}
                      className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
                    >
                      <Download className="h-4 w-4" /> Download
                    </button>
                    <button
                      onClick={() => openResolved(paper.id, paper.answer_key_source!, paper.answer_key_url!, "answer")}
                      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-accent"
                    >
                      <ExternalLink className="h-4 w-4" /> Open
                    </button>
                  </div>
                  <PdfViewer
                    paperId={paper.id}
                    source={paper.answer_key_source}
                    url={paper.answer_key_url}
                    type="answer"
                    title={`${paper.subject} — Answer Key`}
                  />
                </div>
              ) : (
                <div className="mt-6 rounded-2xl border border-dashed border-border bg-muted/30 p-8 text-center text-sm text-muted-foreground">
                  Answer Key Not Available Yet
                </div>
              )}
            </section>
          </>
        )}
      </main>
      <Footer />
    </div>
  );
}
