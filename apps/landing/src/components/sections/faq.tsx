import { Plus } from "lucide-react";
import { faqs } from "@/content/faq";

export function FaqSection() {
  return (
    <section id="faq" aria-labelledby="faq-title" className="border-t border-line py-24 md:py-32">
      <div className="shell grid gap-12 lg:grid-cols-12 lg:gap-10">
        <h2
          id="faq-title"
          className="text-balance text-[clamp(2rem,4.4vw,3.5rem)] font-semibold leading-[1.02] tracking-[-0.035em] lg:col-span-4"
        >
          Questions reviewers ask first.
        </h2>
        <div className="divide-y divide-line border-y border-line lg:col-span-8">
          {faqs.map((f) => (
            <details key={f.q} className="group">
              <summary className="flex cursor-pointer list-none items-start gap-4 py-5 text-[17px] font-medium leading-snug transition-colors hover:text-white [&::-webkit-details-marker]:hidden">
                <span className="flex-1">{f.q}</span>
                <Plus
                  size={18}
                  aria-hidden
                  className="mt-0.5 shrink-0 text-muted transition-transform duration-300 ease-[var(--ease-out-expo)] group-open:rotate-45 group-open:text-approve"
                />
              </summary>
              <p className="max-w-[64ch] pb-6 pr-10 text-[15.5px] leading-[1.65] text-dim">{f.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
