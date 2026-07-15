import { useEffect, useState } from "react";
import { getFileUrl, type PaperSource } from "@/services/papers";
import { drivePreviewUrl } from "@/lib/gdrive";

interface Props {
  paperId: string;
  source: PaperSource;
  url: string;
  type: "question" | "answer";
  title?: string;
}

export function PdfViewer({ paperId, source, url, type, title = "Preview" }: Props) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (source === "gdrive") {
          const preview = drivePreviewUrl(url);
          if (!preview) throw new Error("Invalid Google Drive link");
          if (!cancelled) setSrc(preview);
        } else {
          const data = await getFileUrl(paperId, type);
          if (!cancelled) setSrc(data.url);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Preview unavailable");
      }
    })();
    return () => { cancelled = true; };
  }, [paperId, source, url, type]);

  if (error) {
    return (
      <div className="flex h-[70vh] items-center justify-center rounded-2xl border border-border bg-muted/40 text-sm text-muted-foreground">
        Preview unavailable. Try downloading instead.
      </div>
    );
  }
  if (!src) {
    return <div className="h-[70vh] animate-pulse rounded-2xl bg-muted" />;
  }
  return (
    <iframe
      src={src}
      title={title}
      className="h-[80vh] w-full rounded-2xl border border-border bg-background"
      allow="autoplay"
    />
  );
}
