export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id="fs-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8b6dff" />
          <stop offset="0.6" stopColor="#c04bff" />
          <stop offset="1" stopColor="#ff5c8a" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#fs-logo)" />
      {/* Three nodes joined into a flow. */}
      <path d="M9 11h6.5a3.5 3.5 0 0 1 3.5 3.5v3a3.5 3.5 0 0 0 3.5 3.5H24" stroke="#0b0920" strokeWidth="2.4" fill="none" strokeLinecap="round" />
      <circle cx="9" cy="11" r="2.6" fill="#c6f432" stroke="#0b0920" strokeWidth="1.6" />
      <circle cx="19" cy="16" r="2.2" fill="#fff" stroke="#0b0920" strokeWidth="1.6" />
      <circle cx="24" cy="21" r="2.6" fill="#fff" stroke="#0b0920" strokeWidth="1.6" />
    </svg>
  );
}
