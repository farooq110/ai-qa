/** ProoflineQA mark (same drawing as the landing logo): a review line with an approved node. */
export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <svg className="brand-mark" viewBox="0 0 28 28" width={size} height={size} aria-hidden="true">
      <rect x="0.5" y="0.5" width="27" height="27" rx="7.5" fill="#0f1418" stroke="#2c373e" />
      <path d="M9 4v20" stroke="#2c373e" strokeWidth="2" strokeLinecap="round" />
      <circle cx="9" cy="9" r="2.4" fill="#7f8c8a" />
      <circle cx="9" cy="18.5" r="4.6" fill="#35d08f" />
      <path d="m6.9 18.6 1.5 1.5 2.9-3" stroke="#04150d" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16 9h6M16 13h4" stroke="#7f8c8a" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M16 18.5h6" stroke="#35d08f" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
