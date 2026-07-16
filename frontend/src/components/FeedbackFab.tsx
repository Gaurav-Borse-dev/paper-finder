import { useState } from "react";
import { MessageSquarePlus, X, Send } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/lib/auth";
import { submitFeedback } from "@/services/feedback";
export function FeedbackFab() {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim()) {
      toast.error("Please write a message");
      return;
    }
    setSubmitting(true);
    const displayName = session.role !== "guest" ? session.name : name.trim();
    const displayEmail = session.role !== "guest" ? session.email : email.trim();

    try {
      await submitFeedback({
        name: displayName || undefined,
        email: displayEmail || undefined,
        message: message.trim(),
        user_id: session.user?.id,
      });
      toast.success("Thanks for your feedback!");
      setMessage("");
      setName("");
      setEmail("");
      setOpen(false);
    } catch {
      toast.error("Could not send feedback");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Give feedback"
        className="fixed bottom-6 left-6 z-40 inline-flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[var(--shadow-elevated)] transition hover:scale-105 hover:opacity-90"
      >
        <MessageSquarePlus className="h-6 w-6" />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-start bg-black/40 p-4 sm:items-center sm:justify-center"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-[var(--shadow-elevated)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-lg font-semibold tracking-tight">Send Feedback</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Report an issue or suggest an improvement.
                </p>
              </div>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="rounded-full p-1.5 text-muted-foreground hover:bg-muted"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={submit} className="mt-5 space-y-3">

              {session.role === "guest" && (
                <div className="grid grid-cols-2 gap-3">
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Name (optional)"
                    className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                  />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="Email (optional)"
                    className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                  />
                </div>
              )}
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Your feedback..."
                required
                rows={4}
                className="w-full resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
              <button
                type="submit"
                disabled={submitting}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
              >
                <Send className="h-4 w-4" /> {submitting ? "Sending..." : "Send feedback"}
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
