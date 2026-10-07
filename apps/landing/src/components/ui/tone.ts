export type Tone = "ai" | "pending" | "approve" | "change" | "neutral";

/** Text, wash and border classes per review state. One source of truth for state color. */
export const toneClass: Record<Tone, { text: string; wash: string; border: string; dot: string }> = {
  ai: { text: "text-ai", wash: "bg-ai-wash", border: "border-ai/30", dot: "bg-ai" },
  pending: { text: "text-pending", wash: "bg-pending-wash", border: "border-pending/30", dot: "bg-pending" },
  approve: { text: "text-approve", wash: "bg-approve-wash", border: "border-approve/30", dot: "bg-approve" },
  change: { text: "text-change", wash: "bg-change-wash", border: "border-change/30", dot: "bg-change" },
  neutral: { text: "text-dim", wash: "bg-raised", border: "border-line-strong", dot: "bg-dim" }
};
