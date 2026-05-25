/**
 * Starfleet Command delta. The TMP-era version was a slightly more
 * stylized variant of the TOS arrowhead — softer curves, broader base,
 * the star in the centre slightly compressed.
 *
 * Drawn as an SVG so it scales cleanly to any header height.
 */

export function DeltaShield({ size = 32, color = '#f4e8c8', glow = true }: { size?: number; color?: string; glow?: boolean }) {
  // Coordinates traced from the TMP delta — flattened-arrowhead silhouette
  // with the inset star, rendered as one path so it stays a single shape.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Starfleet Command"
      role="img"
      style={glow ? { filter: `drop-shadow(0 0 6px ${color}aa)` } : undefined}
    >
      {/* Outer delta — arrowhead with curved leading edge. */}
      <path
        d="M 32 4
           C 30 4, 27 7, 22 18
           C 15 33, 6 48, 4 56
           C 4 58, 5 60, 8 60
           C 18 58, 25 56, 32 50
           C 39 56, 46 58, 56 60
           C 59 60, 60 58, 60 56
           C 58 48, 49 33, 42 18
           C 37 7, 34 4, 32 4 Z"
        fill={color}
        stroke="#3a2c1a"
        strokeWidth="1"
      />
      {/* Inset star — a small 4-point + circle in the upper middle. */}
      <path
        d="M 32 22
           L 33.5 28
           L 39 29
           L 33.5 30
           L 32 36
           L 30.5 30
           L 25 29
           L 30.5 28 Z"
        fill="#3a2c1a"
      />
      {/* Small dot signature */}
      <circle cx="32" cy="29" r="1.4" fill="#3a2c1a" />
    </svg>
  );
}
