import { Check, CircleCheck, GitMerge } from "lucide-react";
import { site } from "@/config/site";
import { ButtonLink } from "@/components/marketing/ui/button-link";

const checks = [
  "Every generated test is reviewed by a person",
  "Every run is pinned to an exact commit",
  "No unapproved version can reach a runner"
] as const;

export function Closing() {
  return (
    <section aria-labelledby="closing-title" className="relative overflow-hidden border-t border-line py-24 md:py-36">
      <div className="mkt-shell relative">
        <div className="mkt-panel mx-auto max-w-4xl overflow-hidden">
          <div className="flex items-start gap-4 border-b border-line p-6 sm:p-8">
            <span className="grid size-11 shrink-0 place-items-center rounded-full bg-approve text-approve-ink">
              <GitMerge size={20} aria-hidden />
            </span>
            <div className="flex flex-col gap-3">
              <h2 id="closing-title" className="text-balance text-[clamp(1.9rem,4vw,3.25rem)] font-semibold leading-[1.02] tracking-[-0.035em]">
                Put a reviewer between AI and your pipeline.
              </h2>
              <p className="max-w-[52ch] text-[16.5px] leading-relaxed text-dim">
                Connect a repository, review the first candidates, and run only what your team approves.
              </p>
            </div>
          </div>
          <ul className="flex flex-col divide-y divide-line">
            {checks.map((c) => (
              <li key={c} className="flex items-center gap-3 px-6 py-3.5 text-[14.5px] text-dim sm:px-8">
                <CircleCheck size={16} className="shrink-0 text-approve" aria-hidden />
                {c}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-3 border-t border-line bg-raised/40 p-6 sm:px-8">
            <ButtonLink href={site.links.signup} size="lg" icon={<Check size={17} strokeWidth={2.5} aria-hidden />}>
              Create your organization
            </ButtonLink>
            <ButtonLink href={site.links.signin} size="lg" variant="ghost">
              Sign in
            </ButtonLink>
          </div>
        </div>
      </div>
    </section>
  );
}
