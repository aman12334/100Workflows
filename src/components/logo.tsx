/** The mark: three nodes joined into a flow, in ink on a solid tile (no gradients). */
export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="9" fill="#111113" />
      <path d="M9 11h6.5a3.5 3.5 0 0 1 3.5 3.5v3a3.5 3.5 0 0 0 3.5 3.5H24" stroke="#ffffff" strokeWidth="2.2" fill="none" strokeLinecap="round" />
      <circle cx="9" cy="11" r="2.6" fill="#ffffff" />
      <circle cx="19" cy="16" r="2.2" fill="#111113" stroke="#ffffff" strokeWidth="1.6" />
      <circle cx="24" cy="21" r="2.6" fill="#ffffff" />
    </svg>
  );
}
