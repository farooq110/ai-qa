import { Check } from "lucide-react";
import { capabilities } from "@/content/capabilities";
import { SectionHeading } from "@/components/ui/section-heading";
import { CapabilityBoard } from "@/components/motion/capability-board";

export function Capabilities() {
  return (
    <section id="capabilities" aria-labelledby="capabilities-title" className="border-t border-line py-24 md:py-32">
      <div className="shell grid gap-12 lg:grid-cols-12 lg:gap-10">
        <div className="flex min-w-0 flex-col gap-8 lg:col-span-4">
          <SectionHeading id="capabilities-title" title={capabilities.heading} intro={capabilities.intro} />
          <ul className="flex flex-col gap-3">
            {capabilities.notes.map((n) => (
              <li key={n} className="flex gap-3 text-[15px] leading-relaxed text-dim">
                <Check size={16} className="mt-1 shrink-0 text-approve" aria-hidden />
                {n}
              </li>
            ))}
          </ul>
        </div>
        <div className="min-w-0 lg:col-span-8">
          <CapabilityBoard />
          <p className="mt-3 font-mono text-[11px] text-muted">Demonstration data</p>
        </div>
      </div>
    </section>
  );
}
