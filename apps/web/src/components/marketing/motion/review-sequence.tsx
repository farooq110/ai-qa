"use client";

import { useCallback, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import {
  CircleCheck,
  FileCode,
  GitCommitHorizontal,
  GitPullRequest,
  LoaderCircle,
  MousePointer2,
  ScanSearch,
  Check
} from "lucide-react";
import { reviewDemo as demo } from "@/content/hero";
import { StatusPill } from "@/components/marketing/ui/status-pill";
import type { Tone } from "@/components/marketing/ui/tone";
import { useSequence } from "./use-sequence";

// Step map. Each entry is the wait (ms) before the next step.
const LINE_START = 3;
const LINE_END = LINE_START + demo.lines.length - 1; // 10
const S = {
  commit: 1,
  analysis: 2,
  evidence: LINE_END + 1, // 11
  review: LINE_END + 2, // 12
  cursor: LINE_END + 3, // 13
  approved: LINE_END + 4, // 14
  checks: LINE_END + 5, // 15
  shard: LINE_END + 6, // 16..18
  passed: LINE_END + 9 // 19
} as const;

const DELAYS = [
  500, 700, 900,
  ...demo.lines.slice(1).map(() => 210),
  650, 700, 900, 650, 600, 900, 450, 450, 400
] as const;

const reveal = (on: boolean) =>
  `transition-[opacity,transform,filter] duration-700 ease-[var(--ease-out-expo)] ${
    on ? "opacity-100 translate-y-0 blur-0" : "opacity-0 translate-y-1.5 blur-[3px]"
  }`;

function statusFor(step: number): { tone: Tone; label: string } {
  if (step >= S.passed) return { tone: "approve", label: "All checks passed" };
  if (step >= S.approved) return { tone: "approve", label: "Approved" };
  if (step >= S.review) return { tone: "pending", label: "Pending review" };
  return { tone: "ai", label: "Generating" };
}

export function ReviewSequence() {
  const [ref, step] = useSequence<HTMLDivElement>({ delays: DELAYS, loopAfter: 5200 });
  const status = statusFor(step);

  const onPointerMove = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty("--mx", `${e.clientX - r.left}px`);
    e.currentTarget.style.setProperty("--my", `${e.clientY - r.top}px`);
  }, []);

  return (
    <div
      ref={ref}
      onPointerMove={onPointerMove}
      className="group/panel mkt-panel relative overflow-hidden"
      style={{ "--mx": "70%", "--my": "0px" } as CSSProperties}
    >
      {/* Pointer-following sheen on the mkt-panel edge. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 transition-opacity duration-500 group-hover/panel:opacity-100"
        style={{
          background:
            "radial-gradient(420px circle at var(--mx) var(--my), rgb(53 208 143 / 0.07), transparent 60%)"
        }}
      />

      <div className="relative flex items-start gap-3 border-b border-line px-4 py-3.5 sm:px-5">
        <GitPullRequest size={18} className={`mt-0.5 shrink-0 ${status.tone === "approve" ? "text-approve" : "text-ai"}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold leading-snug tracking-[-0.01em] sm:truncate">{demo.title}</p>
          <p className="mt-0.5 font-mono text-[11.5px] text-muted sm:truncate">
            {demo.candidates} candidates · {demo.repo} @ {demo.commit}
          </p>
        </div>
        <span className="hidden sm:contents">
          <StatusPill
            tone={status.tone}
            icon={status.tone === "ai" ? <LoaderCircle size={11} className="animate-spin" aria-hidden /> : undefined}
          >
            {status.label}
          </StatusPill>
        </span>
      </div>

      <ol className="relative flex flex-col gap-4 px-4 py-5 sm:px-5" aria-label="Demonstration: generating and approving a test">
        <span aria-hidden className="absolute bottom-6 left-[27px] top-7 w-px bg-line sm:left-[31px]" />

        <TimelineRow on={step >= S.commit} icon={<GitCommitHorizontal size={14} />}>
          <span className="text-dim">Pinned commit </span>
          <code className="rounded bg-raised px-1.5 py-0.5 font-mono text-[12px] text-fg">{demo.commit}</code>
          <span className="text-dim"> on {demo.branch}</span>
        </TimelineRow>

        <TimelineRow on={step >= S.analysis} icon={<ScanSearch size={14} />}>
          <span className="text-dim">Mapped application</span>
          <span className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[12px]">
            {demo.analysis.map((a) => (
              <span key={a.label}>
                <span className="text-fg">{a.value}</span> <span className="text-muted">{a.label.toLowerCase()}</span>
              </span>
            ))}
          </span>
        </TimelineRow>

        <li className={`relative pl-9 ${reveal(step >= LINE_START)}`}>
          <span aria-hidden className="absolute left-0 top-1.5 grid size-6 place-items-center rounded-full border border-ai/40 bg-ai-wash text-ai">
            <FileCode size={13} />
          </span>
          <div className="overflow-hidden rounded-lg border border-line bg-sunken">
            <div className="flex items-center justify-between gap-3 border-b border-line px-3 py-2 font-mono text-[11.5px]">
              <span className="min-w-0 break-all text-dim sm:truncate sm:break-normal">{demo.file}</span>
              <span className="shrink-0 text-approve">+{Math.max(0, Math.min(step, LINE_END) - LINE_START + 1)}</span>
            </div>
            <div className="overflow-x-auto py-1.5">
              <pre className="font-mono text-[11.5px] leading-[1.75] sm:min-w-max sm:text-[12px]">
                {demo.lines.map((line, i) => {
                  const on = step >= LINE_START + i;
                  return (
                    <span
                      key={line.code}
                      className={`flex transition-[opacity,background-color] duration-500 ${on ? "diff-add opacity-100" : "opacity-0"}`}
                    >
                      <span className="w-8 shrink-0 select-none pr-2 text-right text-muted/70">{i + 1}</span>
                      <span className="w-4 shrink-0 select-none text-approve">+</span>
                      <span className={`min-w-0 whitespace-pre-wrap break-words pr-3 sm:whitespace-pre sm:pr-4 ${line.tone === "key" ? "text-fg" : line.tone === "string" ? "text-[#c9e7d8]" : "text-dim"}`}>
                        {line.code}
                      </span>
                    </span>
                  );
                })}
              </pre>
            </div>
          </div>
          <div className={`mt-2.5 flex flex-wrap items-center gap-1.5 ${reveal(step >= S.evidence)}`}>
            <span className="mr-1 font-mono text-[11px] text-muted">evidence</span>
            {demo.evidence.map((e) => (
              <code key={e} className="rounded-md border border-line bg-raised px-1.5 py-0.5 font-mono text-[11px] text-dim">
                {e}
              </code>
            ))}
            <span className="ml-auto font-mono text-[11px] text-muted">
              confidence <span className="text-fg">{demo.confidence}</span>
            </span>
          </div>
        </li>

        <li className={`relative pl-9 ${reveal(step >= S.review)}`}>
          <span
            aria-hidden
            className={`absolute left-0 top-2 grid size-6 place-items-center rounded-full border text-[10px] font-semibold transition-colors duration-500 ${
              step >= S.approved ? "border-approve/50 bg-approve-wash text-approve" : "border-pending/40 bg-pending-wash text-pending"
            }`}
          >
            MO
          </span>
          <div className="relative flex flex-wrap items-center gap-2 rounded-lg border border-line bg-raised/60 px-3 py-2">
            <p className="mr-auto text-[13px] text-dim">
              {step >= S.approved ? (
                <>
                  <span className="font-semibold text-fg">{demo.reviewer}</span> approved this version
                </>
              ) : (
                <>
                  Review requested from <span className="font-semibold text-fg">{demo.reviewer}</span>
                </>
              )}
            </p>
            <span className="rounded-md border border-line-strong px-2.5 py-1 text-[12px] text-dim">Request changes</span>
            <span
              className={`relative inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-semibold transition-[background-color,color,transform] duration-200 ${
                step >= S.approved ? "bg-approve text-approve-ink" : "bg-approve/15 text-approve"
              } ${step === S.approved ? "scale-95" : "scale-100"}`}
            >
              <Check size={13} aria-hidden />
              {step >= S.approved ? "Approved" : "Approve"}
            </span>
            <MousePointer2
              aria-hidden
              size={18}
              className="pointer-events-none absolute right-6 top-6 fill-fg text-ground drop-shadow-[0_4px_8px_rgb(0_0_0/0.6)] transition-[transform,opacity] duration-[900ms] ease-[var(--ease-out-quint)]"
              style={{
                opacity: step >= S.cursor && step < S.checks ? 1 : 0,
                transform: step >= S.cursor ? "translate(0,0)" : "translate(-120px, 40px)"
              }}
            />
          </div>
        </li>

        <li className={`relative pl-9 ${reveal(step >= S.checks)}`}>
          <span aria-hidden className="absolute left-0 top-1 grid size-6 place-items-center rounded-full border border-line-strong bg-raised text-dim">
            <CircleCheck size={13} />
          </span>
          <div className="flex flex-col gap-1">
            {demo.checks.map((c, i) => {
              const done = step >= S.shard + i;
              return (
                <div key={c.name} className="flex items-center gap-2.5 font-mono text-[12px]">
                  {done ? (
                    <CircleCheck size={13} className="text-approve" aria-hidden />
                  ) : (
                    <LoaderCircle size={13} className="animate-spin text-pending" aria-hidden />
                  )}
                  <span className="text-dim">Playwright · {c.name}</span>
                  <span className="ml-auto text-muted">{done ? c.duration : "running"}</span>
                </div>
              );
            })}
          </div>
        </li>
      </ol>

      <div className="flex items-center justify-between border-t border-line px-4 py-2.5 font-mono text-[10.5px] text-muted sm:px-5">
        <span>Demonstration data</span>
        <span className="sm:hidden">{status.label}</span>
        <span className="hidden sm:inline">Only approved versions reach a runner</span>
      </div>
    </div>
  );
}

function TimelineRow({ on, icon, children }: { on: boolean; icon: ReactNode; children: ReactNode }) {
  return (
    <li className={`relative pl-9 text-[13px] leading-6 ${reveal(on)}`}>
      <span aria-hidden className="absolute left-0 top-0 grid size-6 place-items-center rounded-full border border-line-strong bg-raised text-dim">
        {icon}
      </span>
      <div>{children}</div>
    </li>
  );
}
