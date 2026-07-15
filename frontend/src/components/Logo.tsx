import { Link } from "@tanstack/react-router";

export function Logo({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const dims = size === "lg" ? "h-11 w-11" : size === "sm" ? "h-8 w-8" : "h-9 w-9";
  const title = size === "lg" ? "text-2xl" : "text-lg";
  return (
    <Link to="/" className="group inline-flex items-center gap-2.5" aria-label="Rcpit PaperVault home">
      <span
        className={`${dims} inline-flex items-center justify-center rounded-xl bg-gradient-to-br from-primary to-indigo-500 text-primary-foreground font-bold tracking-tight shadow-sm transition-transform group-hover:scale-[1.03]`}
        aria-hidden
      >
        PV
      </span>
      <span className={`${title} font-semibold tracking-tight`}>
        Rcpit <span className="text-primary">PaperVault</span>
      </span>
    </Link>
  );
}
