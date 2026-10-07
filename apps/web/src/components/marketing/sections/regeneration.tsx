import { regeneration } from "@/content/regeneration";
import { SectionHeading } from "@/components/marketing/ui/section-heading";
import { RegenerateControl } from "@/components/marketing/motion/regenerate-control";

export function Regeneration() {
  return (
    <section id="regenerate" aria-labelledby="regenerate-title" className="border-t border-line bg-sunken py-24 md:py-32">
      <div className="mkt-shell grid gap-12 lg:grid-cols-12 lg:items-center lg:gap-10">
        <div className="min-w-0 lg:col-span-5">
          <SectionHeading id="regenerate-title" title={regeneration.heading} intro={regeneration.intro} />
        </div>
        <div className="min-w-0 lg:col-span-7">
          <RegenerateControl />
        </div>
      </div>
    </section>
  );
}
