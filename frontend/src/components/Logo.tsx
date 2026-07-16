import { Link } from "@tanstack/react-router";

export function Logo({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const dims = size === "lg" ? "h-11 w-11" : size === "sm" ? "h-8 w-8" : "h-9 w-9";
  const title = size === "lg" ? "text-2xl" : "text-lg";
  const textClass = size === "lg" ? "text-sm" : size === "sm" ? "text-[10px]" : "text-xs";
  return (
    <Link to="/" className="group inline-flex items-center gap-2.5" aria-label="Rcpit PYQ Paper home">
      <span
        className={`${dims} ${textClass} inline-flex items-center justify-center rounded-xl bg-gradient-to-br from-primary to-indigo-500 text-primary-foreground font-bold tracking-tight shadow-sm transition-transform group-hover:scale-[1.03]`}
        aria-hidden
      >
        PYQ
      </span>
      <span className={`${title} font-semibold tracking-tight`}>
        Rcpit <span className="text-primary">PYQ Paper</span>
      </span>
    </Link>
  );
}
