import { site } from "@/config/site";
import { faqs } from "@/content/faq";
import { pricing } from "@/content/pricing";

type JsonLdValue = string | number | boolean | null | readonly JsonLdValue[] | { readonly [key: string]: JsonLdValue };

/** Renders schema.org JSON-LD. `<` is escaped so content can never close the script tag. */
export function JsonLd({ data }: { data: { [key: string]: JsonLdValue } }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }}
    />
  );
}

export function landingStructuredData(): { [key: string]: JsonLdValue } {
  const orgId = `${site.url}/#organization`;
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": orgId,
        name: site.name,
        url: site.url,
        logo: `${site.url}/icon.svg`
      },
      {
        "@type": "WebSite",
        "@id": `${site.url}/#website`,
        url: site.url,
        name: site.name,
        publisher: { "@id": orgId },
        inLanguage: "en"
      },
      {
        "@type": "SoftwareApplication",
        name: site.name,
        applicationCategory: "DeveloperApplication",
        operatingSystem: "Web",
        description: site.description,
        url: site.url,
        publisher: { "@id": orgId },
        featureList: pricing.included
      },
      {
        "@type": "FAQPage",
        mainEntity: faqs.map((f) => ({
          "@type": "Question",
          name: f.q,
          acceptedAnswer: { "@type": "Answer", text: f.a }
        }))
      }
    ]
  };
}
