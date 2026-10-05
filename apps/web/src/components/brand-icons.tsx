/// Brand icons not shipped by lucide-react, drawn to match its 24×24 stroke style.

export function BitbucketIcon({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M3.5 5h17l-2.4 14.2a1.5 1.5 0 0 1-1.5 1.3H7.4a1.5 1.5 0 0 1-1.5-1.3L3.5 5Z" />
      <path d="M8.6 9h6.8l-.7 5H9.3l-.7-5Z" />
    </svg>
  );
}
