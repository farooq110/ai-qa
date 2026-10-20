import type { ReactNode } from "react";
import { CircleCheck, CircleX, GitBranch, Minus, ShieldCheck, TriangleAlert } from "lucide-react";
import { ci, type BranchResult } from "@/content/ci";
import { SectionHeading } from "@/components/marketing/ui/section-heading";
import { PipelineRun } from "@/components/marketing/motion/pipeline-run";

const resultIcon: Record<BranchResult, ReactNode> = {
  pass: <CircleCheck size={16} className="text-approve" aria-hidden />,
  fail: <CircleX size={16} className="text-change" aria-hidden />,
  env: <TriangleAlert size={16} className="text-pending" aria-hidden />,
  none: <Minus size={16} className="text-muted" aria-hidden />
};

const resultLabel = Object.fromEntries(ci.legend.map((l) => [l.result, l.label])) as Record<BranchResult, string>;

export function Ci() {
  return (
    <section id="checks" aria-labelledby="checks-title" className="border-t border-line py-24 md:py-32">
      <div className="mkt-shell flex flex-col gap-14">
        <div className="flex flex-col justify-between gap-8 lg:flex-row lg:items-end">
          <SectionHeading id="checks-title" title={ci.heading} intro={ci.intro} />
          <ul className="flex flex-wrap gap-2 lg:justify-end" aria-label="Supported pipelines">
            {ci.providers.map((p) => (
              <li key={p} className="rounded-lg border border-line-strong bg-raised px-3 py-1.5 font-mono text-[12.5px] text-dim">
                {p}
              </li>
            ))}
          </ul>
        </div>

        <PipelineRun />

        <div className="grid gap-10 lg:grid-cols-12">
          <div className="mkt-panel min-w-0 overflow-hidden lg:col-span-8">
            <div className="flex items-center gap-2.5 border-b border-line px-4 py-3 sm:px-5">
              <GitBranch size={15} className="text-muted" aria-hidden />
              <h3 className="text-[14px] font-semibold">Same tests, separate history per branch</h3>
            </div>
            <div className="relative hidden overflow-x-auto sm:block">
              <table className="w-full min-w-[560px] border-collapse text-left">
                <caption className="sr-only">Latest result of four approved tests on four branches (demonstration data)</caption>
                <thead>
                  <tr className="border-b border-line">
                    <th scope="col" className="px-4 py-3 text-xs font-normal text-muted sm:px-5">
                      Test
                    </th>
                    {ci.branches.map((b) => (
                      <th key={b} scope="col" className="px-3 py-3 font-mono text-[11.5px] font-normal text-dim">
                        {b}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {ci.history.map((row) => (
                    <tr key={row.test} className="border-b border-line last:border-0 hover:bg-raised/50">
                      <th scope="row" className="px-4 py-3.5 text-[14px] font-medium sm:px-5">
                        {row.test}
                      </th>
                      {row.results.map((r, i) => (
                        <td key={`${row.test}-${ci.branches[i]}`} className="px-3 py-3.5">
                          <span className="inline-flex" title={resultLabel[r]}>
                            {resultIcon[r]}
                            <span className="sr-only">{resultLabel[r]}</span>
                          </span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="flex flex-col divide-y divide-line sm:hidden">
              {ci.history.map((row) => (
                <li key={row.test} className="flex flex-col gap-2.5 px-4 py-3.5">
                  <span className="text-[14px] font-medium">{row.test}</span>
                  <dl className="grid grid-cols-1 gap-y-1.5">
                    {row.results.map((r, i) => (
                      <div key={`${row.test}-${ci.branches[i]}`} className="flex min-w-0 items-center gap-2">
                        {resultIcon[r]}
                        <dt className="break-all font-mono text-[11.5px] text-dim">{ci.branches[i]}</dt>
                        <dd className="sr-only">{resultLabel[r]}</dd>
                      </div>
                    ))}
                  </dl>
                </li>
              ))}
            </ul>
            <ul className="flex flex-wrap gap-x-5 gap-y-2 border-t border-line px-4 py-3 text-[12px] text-muted sm:px-5">
              {ci.legend.map((l) => (
                <li key={l.result} className="flex items-center gap-1.5">
                  {resultIcon[l.result]}
                  {l.label}
                </li>
              ))}
              <li className="ml-auto font-mono text-[10.5px]">Demonstration data</li>
            </ul>
          </div>

          <ul className="flex flex-col gap-6 lg:col-span-4 lg:pt-2">
            {ci.rules.map((rule) => (
              <li key={rule} className="flex gap-3.5 text-[15.5px] leading-relaxed text-dim">
                <ShieldCheck size={18} className="mt-0.5 shrink-0 text-approve" aria-hidden />
                {rule}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
