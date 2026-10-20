import Link from "next/link";
import { Check, X } from "lucide-react";

/** Stays on screen until dismissed, so starting a run never ends in silence. */
export function RunQueued({ count, onClose }: { count: number; onClose: () => void }) {
  return (
    <section className="banner success" role="status">
      <Check size={16} aria-hidden="true" />
      <span><strong>{count} approved test{count === 1 ? "" : "s"} queued.</strong> The run starts as soon as a worker is free.</span>
      <Link className="text-button" href="/executions">Watch the run</Link>
      <button className="icon-button" aria-label="Dismiss" onClick={onClose}><X size={14} /></button>
    </section>
  );
}
