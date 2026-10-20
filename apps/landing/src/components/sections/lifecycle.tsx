import { lifecycle } from "@/content/lifecycle";
import { SectionHeading } from "@/components/ui/section-heading";
import { LifecycleScroller } from "@/components/motion/lifecycle-scroller";

export function Lifecycle() {
  return (
    <section id="review" aria-labelledby="review-title" className="border-t border-line py-24 md:py-32">
      <div className="shell">
        <SectionHeading id="review-title" title={lifecycle.heading} intro={lifecycle.intro} />
        <LifecycleScroller />
      </div>
    </section>
  );
}
