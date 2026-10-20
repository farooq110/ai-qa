// PLACEHOLDER testimonials, approved by the product owner for design only.
// Replace every entry with a real, attributed quote before launch.

export type Testimonial = {
  readonly name: string;
  readonly role: string;
  readonly company: string;
  readonly quote: string;
  readonly initials: string;
};

export const testimonials: readonly Testimonial[] = [
  {
    name: "Dana Whitfield",
    role: "Head of QA",
    company: "Northwind Commerce",
    initials: "DW",
    quote:
      "The approval gate is the reason we said yes. My team reviews a candidate with its evidence in a couple of minutes, and nothing sneaks into the pipeline."
  },
  {
    name: "Rahul Menon",
    role: "Engineering Manager",
    company: "Lattice Health",
    initials: "RM",
    quote:
      "Grouping by capability changed our release reviews. We talk about checkout and onboarding coverage now, not about which folder has tests."
  },
  {
    name: "Sofia Kral",
    role: "Staff Engineer",
    company: "Brightline Freight",
    initials: "SK",
    quote:
      "Pinned SHAs and zero-token CI runs made it easy to put in front of platform. Feature branches finally have their own history."
  }
];
