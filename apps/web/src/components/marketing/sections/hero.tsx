import { ArrowRight, Check } from "lucide-react";
import { hero } from "@/content/hero";
import { site } from "@/config/site";
import { ButtonLink } from "@/components/marketing/ui/button-link";
import { ReviewSequence } from "@/components/marketing/motion/review-sequence";

export function Hero() {
  return (
    <section id="top" aria-labelledby="hero-title" className="relative overflow-hidden">
      <div className="mkt-shell relative grid items-center gap-x-10 gap-y-10 pb-20 pt-10 md:pt-20 xl:grid-cols-12 lg:pb-28 lg:pt-24">
        <div className="flex min-w-0 max-w-[44rem] flex-col gap-7 xl:max-w-none xl:col-span-5 xl:row-start-1 xl:self-end">
          <h1
            id="hero-title"
            className="text-balance text-[clamp(2.6rem,5.6vw,4.75rem)] font-semibold leading-[0.96] tracking-[-0.04em]"
          >
            {hero.headline.map((line, i) => (
              <span
                key={line}
                className={`hero-line block ${i === 1 ? "text-approve" : ""}`}
                style={{ animationDelay: `${120 + i * 140}ms` }}
              >
                {line}
              </span>
            ))}
          </h1>

          <p className="hero-line max-w-[34rem] text-pretty text-[17px] leading-[1.6] text-dim md:text-lg" style={{ animationDelay: "380ms" }}>
            {hero.subhead}
          </p>

          <div className="hero-line flex flex-wrap items-center gap-3" style={{ animationDelay: "500ms" }}>
            <ButtonLink href={site.links.signup} size="lg" icon={<Check size={17} strokeWidth={2.5} aria-hidden />}>
              {hero.primaryCta}
            </ButtonLink>
            <ButtonLink
              href="#review"
              size="lg"
              variant="secondary"
              icon={<ArrowRight size={16} aria-hidden className="order-last transition-transform group-hover:translate-x-0.5" />}
            >
              {hero.secondaryCta}
            </ButtonLink>
          </div>

        </div>

        <div className="hero-panel min-w-0 xl:col-span-7 xl:col-start-6 xl:row-span-2 xl:row-start-1 xl:pl-4">
          <ReviewSequence />
        </div>

        <dl className="hero-line grid min-w-0 xl:col-span-5 xl:row-start-2 xl:self-start gap-x-8 gap-y-3 border-t border-line pt-6 sm:grid-cols-3 xl:grid-cols-1" style={{ animationDelay: "620ms" }}>
            {hero.facts.map((f) => (
              <div key={f.label} className="flex flex-col gap-1 xl:flex-row xl:items-baseline xl:justify-between xl:gap-4">
                <dt className="text-xs text-muted">{f.label}</dt>
                <dd className="font-mono text-[13px] text-fg">{f.value}</dd>
              </div>
            ))}
        </dl>
      </div>
    </section>
  );
}
