export function Logo({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden>
      <defs>
        <linearGradient id="holo-a" x1="4" y1="4" x2="36" y2="36" gradientUnits="userSpaceOnUse">
          <stop stopColor="#b59cff" />
          <stop offset="1" stopColor="#6a3df5" />
        </linearGradient>
        <linearGradient id="holo-b" x1="20" y1="2" x2="20" y2="38" gradientUnits="userSpaceOnUse">
          <stop stopColor="#ffffff" stopOpacity=".85" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d="M20 2 35.6 11v18L20 38 4.4 29V11L20 2Z" fill="url(#holo-a)" />
      <path d="M20 2 35.6 11 20 20 4.4 11 20 2Z" fill="url(#holo-b)" opacity=".45" />
      <path d="M20 20v18" stroke="#fff" strokeOpacity=".35" />
      <path d="m13 15.5 7 4 7-4" stroke="#fff" strokeOpacity=".7" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
