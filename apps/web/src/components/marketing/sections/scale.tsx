import { scale } from "@/content/scale";
import { SectionHeading } from "@/components/marketing/ui/section-heading";
import { ShardSimulator } from "@/components/marketing/motion/shard-simulator";

export function Scale() {
  return (
    <section id="scale" aria-labelledby="scale-title" className="border-t border-line bg-sunken py-24 md:py-32">
      <div className="mkt-shell flex flex-col gap-14">
        <SectionHeading id="scale-title" title={scale.heading} intro={scale.intro} />
        <ShardSimulator />
      </div>
    </section>
  );
}
