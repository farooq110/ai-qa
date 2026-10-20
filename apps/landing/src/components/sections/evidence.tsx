import { evidence } from "@/content/evidence";
import { SectionHeading } from "@/components/ui/section-heading";
import { EvidenceLinks } from "@/components/motion/evidence-links";

export function Evidence() {
  return (
    <section id="evidence" aria-labelledby="evidence-title" className="border-t border-line bg-sunken py-24 md:py-32">
      <div className="shell flex flex-col gap-14">
        <SectionHeading id="evidence-title" title={evidence.heading} intro={evidence.intro} />
        <EvidenceLinks />

        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-3 lg:grid-cols-6">
          {evidence.meta.map((m) => (
            <div key={m.label} className="flex flex-col gap-1.5 bg-panel px-4 py-4">
              <dt className="text-xs text-muted">{m.label}</dt>
              <dd className="font-mono text-[12.5px] leading-snug text-fg">{m.value}</dd>
            </div>
          ))}
        </dl>

        <div className="flex flex-col gap-4 md:flex-row md:items-baseline md:gap-8">
          <h3 className="shrink-0 text-[15px] font-semibold">Eight categories per capability</h3>
          <ul className="flex flex-wrap gap-2">
            {evidence.categories.map((c) => (
              <li key={c} className="rounded-full border border-line-strong px-3 py-1 text-[13px] text-dim">
                {c}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
