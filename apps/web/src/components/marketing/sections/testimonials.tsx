import { Check } from "lucide-react";
import { testimonials } from "@/content/testimonials";

export function Testimonials() {
  return (
    <section aria-labelledby="voices-title" className="border-t border-line py-24 md:py-32">
      <div className="mkt-shell grid gap-12 lg:grid-cols-12 lg:gap-10">
        <h2
          id="voices-title"
          className="text-balance text-[clamp(2rem,4.4vw,3.5rem)] font-semibold leading-[1.02] tracking-[-0.035em] lg:col-span-4"
        >
          Reviewed by the people who sign off releases.
        </h2>

        <ol className="relative flex flex-col gap-8 lg:col-span-8">
          <span aria-hidden className="absolute bottom-4 left-[17px] top-4 w-px bg-line" />
          {testimonials.map((t) => (
            <li key={t.name} className="relative flex gap-4">
              <span
                aria-hidden
                className="relative z-10 grid size-9 shrink-0 place-items-center rounded-full border border-line-strong bg-raised text-[12px] font-semibold text-dim"
              >
                {t.initials}
              </span>
              <figure className="mkt-panel min-w-0 flex-1 overflow-hidden">
                <figcaption className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-raised/40 px-4 py-2.5 text-[13px] sm:px-5">
                  <span className="font-semibold text-fg">{t.name}</span>
                  <span className="inline-flex items-center gap-1 text-approve">
                    <Check size={13} strokeWidth={2.5} aria-hidden />
                    approved
                  </span>
                  <span className="text-muted">
                    · {t.role}, {t.company}
                  </span>
                </figcaption>
                <blockquote className="px-4 py-4 text-pretty text-[16.5px] leading-[1.6] text-fg sm:px-5 sm:py-5 sm:text-[17.5px]">
                  {t.quote}
                </blockquote>
              </figure>
            </li>
          ))}
        </ol>
        <p className="font-mono text-[11px] text-muted lg:col-span-8 lg:col-start-5 lg:-mt-6 lg:pl-[52px]">Placeholder testimonials</p>
      </div>
    </section>
  );
}
