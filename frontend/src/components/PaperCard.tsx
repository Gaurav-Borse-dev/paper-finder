import { Link } from "@tanstack/react-router";
import { Download, Eye, ExternalLink, FileText, FileX } from "lucide-react";
import { getFileUrl, type Paper } from "@/services/papers";
import { driveDownloadUrl, driveOpenUrl } from "@/lib/gdrive";

async function openResolved(paperId: string, source: "upload" | "gdrive", url: string, type: "question" | "answer") {
  try {
    if (source === "gdrive") {
      window.open(driveOpenUrl(url), "_blank", "noopener,noreferrer");
    } else {
      const data = await getFileUrl(paperId, type);
      window.open(data.url, "_blank", "noopener,noreferrer");
    }
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
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
    a.href = target;
    a.download = "";
    a.rel = "noopener noreferrer";
    a.target = "_blank";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
      {children}
    </span>
  );
}

interface FileRowProps {
  label: string;
  paperId: string;
  source: "upload" | "gdrive" | null;
  url: string | null;
  type: "question" | "answer";
}
function FileRow({ label, paperId, source, url, type }: FileRowProps) {
  if (!source || !url) {
    return (
      <div className="flex items-center justify-between rounded-xl border border-dashed border-border bg-muted/30 px-4 py-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <FileX className="h-4 w-4" />
          <span className="font-medium">{label}</span>
          <span className="text-xs">— Not Available Yet</span>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-background px-4 py-3">
      <div className="flex items-center gap-2 text-sm">
        <FileText className="h-4 w-4 text-primary" />
        <span className="font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">
          {source === "gdrive" ? "Google Drive" : "PDF"}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => openResolved(paperId, source, url, type)}
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent"
        >
          <Eye className="h-3.5 w-3.5" />
          Preview
        </button>
        <button
          onClick={() => downloadResolved(paperId, source, url, type)}
          className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          <Download className="h-3.5 w-3.5" />
          Download
        </button>
        <button
          onClick={() => openResolved(paperId, source, url, type)}
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Open
        </button>
      </div>
    </div>
  );
}

export function PaperCard({ paper }: { paper: Paper }) {
  return (
    <article className="group rounded-2xl border border-border bg-card p-5 shadow-[var(--shadow-elevated)] transition-all hover:-translate-y-0.5 hover:border-primary/40">
      <Link
        to="/paper/$id"
        params={{ id: paper.id }}
        className="block"
      >
        <h3 className="text-lg font-semibold tracking-tight group-hover:text-primary">
          {paper.subject}
        </h3>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Chip>{paper.department}</Chip>
          <Chip>Sem {paper.semester}</Chip>
          <Chip>{paper.academic_year}</Chip>
          <Chip>{paper.exam_type}</Chip>
          <Chip>{paper.marks} marks</Chip>
          {paper.exam_date && <Chip>{new Date(paper.exam_date).toLocaleDateString()}</Chip>}
        </div>
        {paper.description && (
          <p className="mt-3 line-clamp-2 text-sm text-muted-foreground">{paper.description}</p>
        )}
      </Link>
      <div className="mt-4 space-y-2">
        <FileRow label="Question Paper" paperId={paper.id} source={paper.question_paper_source} url={paper.question_paper_url} type="question" />
        <FileRow label="Answer Key" paperId={paper.id} source={paper.answer_key_source} url={paper.answer_key_url} type="answer" />
      </div>
    </article>
  );
}
