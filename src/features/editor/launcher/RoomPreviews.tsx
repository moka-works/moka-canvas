/**
 * The three rooms as miniature drawings rather than screenshots.
 *
 * A new project holds no work for a screenshot to show, and a screenshot of
 * somebody else's project would promise material this one does not have. The
 * drawings show each room's shape instead — the steps a telling moves through,
 * the nodes a board is wired from, the tracks a cut is laid on — and follow the
 * theme's own colours through the CSS variables.
 */

export function StoryPreview() {
  return (
    <svg
      aria-hidden="true"
      className="room-preview"
      focusable="false"
      preserveAspectRatio="xMidYMid meet"
      viewBox="0 0 320 200"
    >
      <rect fill="var(--canvas)" height="200" width="320" />

      {/* The stories a project tells, with the one being looked at marked. */}
      <rect
        fill="var(--surface-raised)"
        height="176"
        rx="8"
        stroke="var(--stroke)"
        width="70"
        x="10"
        y="12"
      />
      <rect fill="var(--stroke)" height="4" rx="2" width="28" x="20" y="24" />
      <rect
        fill="var(--yellow)"
        height="22"
        opacity="0.18"
        rx="5"
        width="54"
        x="18"
        y="36"
      />
      <rect
        fill="var(--yellow)"
        height="3"
        opacity="0.9"
        rx="1.5"
        width="32"
        x="24"
        y="43"
      />
      <rect
        fill="var(--muted)"
        height="3"
        opacity="0.35"
        rx="1.5"
        width="18"
        x="24"
        y="50"
      />
      <rect
        fill="var(--surface)"
        height="18"
        rx="5"
        stroke="var(--stroke)"
        width="54"
        x="18"
        y="66"
      />
      <rect
        fill="var(--muted)"
        height="3"
        opacity="0.4"
        rx="1.5"
        width="30"
        x="24"
        y="73"
      />
      <rect
        fill="var(--surface)"
        height="18"
        rx="5"
        stroke="var(--stroke)"
        width="54"
        x="18"
        y="92"
      />
      <rect
        fill="var(--muted)"
        height="3"
        opacity="0.4"
        rx="1.5"
        width="22"
        x="24"
        y="99"
      />

      {/* The five steps, with the board being stood on. */}
      <rect
        fill="var(--surface)"
        height="176"
        rx="8"
        stroke="var(--stroke)"
        width="216"
        x="92"
        y="12"
      />
      <path d="M112 38h176" stroke="var(--stroke)" strokeWidth="1.2" />
      {[112, 156, 200, 244, 288].map((x, step) => (
        <g key={x}>
          <circle
            cx={x}
            cy="38"
            fill={step === 3 ? "var(--yellow)" : "var(--surface)"}
            r="7"
            stroke={step === 3 ? "var(--yellow)" : "var(--stroke)"}
          />
          {step === 3 && <circle cx={x} cy="38" fill="var(--canvas)" r="2.5" />}
          <rect
            fill="var(--muted)"
            height="2.5"
            opacity={step === 3 ? 0.8 : 0.35}
            rx="1.25"
            width="20"
            x={x - 10}
            y="52"
          />
        </g>
      ))}

      {/* Storyboard frames and the script under them. */}
      <rect
        fill="var(--canvas)"
        height="56"
        rx="5"
        stroke="var(--stroke)"
        width="88"
        x="106"
        y="66"
      />
      <path
        d="m114 110 15-15 11 10 9-8 17 13"
        fill="none"
        stroke="var(--yellow)"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
      <circle cx="176" cy="80" fill="var(--yellow)" opacity="0.85" r="4" />
      <rect
        fill="var(--canvas)"
        height="56"
        rx="5"
        stroke="var(--stroke)"
        width="88"
        x="202"
        y="66"
      />
      <rect fill="var(--stroke)" height="9" rx="2" width="36" x="212" y="75" />
      <rect fill="var(--stroke)" height="9" rx="2" width="58" x="212" y="89" />
      <rect
        fill="var(--muted)"
        height="3"
        opacity="0.4"
        rx="1.5"
        width="48"
        x="212"
        y="105"
      />
      <rect
        fill="var(--canvas)"
        height="42"
        rx="5"
        stroke="var(--stroke)"
        width="184"
        x="106"
        y="132"
      />
      {[141, 153, 165].map((y) => (
        <g key={y}>
          <circle cx="116" cy={y} fill="var(--stroke)" r="2.5" />
          <rect
            fill="var(--muted)"
            height="2.5"
            opacity="0.35"
            rx="1.25"
            width="144"
            x="124"
            y={y - 1.25}
          />
        </g>
      ))}
    </svg>
  );
}

export function CanvasPreview() {
  return (
    <svg
      aria-hidden="true"
      className="room-preview"
      focusable="false"
      preserveAspectRatio="xMidYMid meet"
      viewBox="0 0 320 200"
    >
      <defs>
        <pattern
          height="14"
          id="room-canvas-grid"
          patternUnits="userSpaceOnUse"
          width="14"
        >
          <circle cx="1.5" cy="1.5" fill="var(--stroke)" r="1" />
        </pattern>
        <marker
          id="room-canvas-arrow"
          markerHeight="6"
          markerWidth="6"
          orient="auto"
          refX="5"
          refY="3"
          viewBox="0 0 6 6"
        >
          <path d="M0 0 6 3 0 6Z" fill="var(--success)" />
        </marker>
      </defs>
      <rect fill="var(--canvas)" height="200" width="320" />
      <rect
        fill="url(#room-canvas-grid)"
        height="200"
        opacity="0.75"
        width="320"
      />

      {/* A text card feeding a picture and a clip, both arriving at one result. */}
      <path
        d="M98 98C116 98 114 56 132 56M98 98c18 0 16 46 34 46M210 56c16 0 14 42 30 42M210 144c16 0 14-42 30-42"
        fill="none"
        markerEnd="url(#room-canvas-arrow)"
        stroke="var(--success)"
        strokeWidth="1.4"
      />

      <g>
        <rect
          fill="var(--surface)"
          height="52"
          rx="7"
          stroke="var(--stroke)"
          width="74"
          x="24"
          y="72"
        />
        <rect
          fill="var(--yellow)"
          height="3"
          opacity="0.8"
          rx="1.5"
          width="18"
          x="34"
          y="82"
        />
        <rect
          fill="var(--muted)"
          height="3"
          opacity="0.45"
          rx="1.5"
          width="50"
          x="34"
          y="94"
        />
        <rect
          fill="var(--muted)"
          height="3"
          opacity="0.35"
          rx="1.5"
          width="42"
          x="34"
          y="102"
        />
        <rect
          fill="var(--muted)"
          height="3"
          opacity="0.28"
          rx="1.5"
          width="48"
          x="34"
          y="110"
        />
      </g>

      <g>
        <rect
          fill="var(--surface)"
          height="52"
          rx="7"
          stroke="var(--stroke)"
          width="78"
          x="132"
          y="30"
        />
        <rect
          fill="var(--success)"
          height="3"
          opacity="0.8"
          rx="1.5"
          width="18"
          x="142"
          y="40"
        />
        <rect
          fill="var(--canvas)"
          height="30"
          rx="4"
          stroke="var(--stroke)"
          width="58"
          x="142"
          y="48"
        />
        <path
          d="m147 72 11-11 8 7 6-5 12 9"
          fill="none"
          stroke="var(--success)"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.4"
        />
        <circle cx="191" cy="55" fill="var(--success)" opacity="0.8" r="3" />
      </g>

      <g>
        <rect
          fill="var(--surface)"
          height="52"
          rx="7"
          stroke="var(--stroke)"
          width="78"
          x="132"
          y="118"
        />
        <rect
          fill="var(--coral)"
          height="3"
          opacity="0.8"
          rx="1.5"
          width="18"
          x="142"
          y="128"
        />
        <rect
          fill="var(--canvas)"
          height="30"
          rx="4"
          stroke="var(--stroke)"
          width="58"
          x="142"
          y="136"
        />
        <circle
          cx="171"
          cy="151"
          fill="none"
          r="8"
          stroke="var(--coral)"
          strokeWidth="1.4"
        />
        <path d="M168 147l7 4-7 4Z" fill="var(--coral)" />
      </g>

      <g>
        <rect
          fill="var(--surface-raised)"
          height="52"
          rx="7"
          stroke="var(--stroke)"
          width="58"
          x="240"
          y="72"
        />
        <rect
          fill="var(--muted)"
          height="3"
          opacity="0.6"
          rx="1.5"
          width="16"
          x="250"
          y="82"
        />
        <rect
          fill="var(--canvas)"
          height="18"
          rx="3"
          stroke="var(--stroke)"
          width="38"
          x="250"
          y="92"
        />
        <rect
          fill="var(--canvas)"
          height="18"
          rx="3"
          stroke="var(--stroke)"
          width="38"
          x="250"
          y="114"
        />
        <path
          d="m255 106 5-5 4 3 5-4"
          fill="none"
          stroke="var(--muted)"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.2"
        />
      </g>

      {/* The corner map, and the part of the board the window is over. */}
      <rect
        fill="var(--surface-glass)"
        height="30"
        rx="5"
        stroke="var(--stroke)"
        width="48"
        x="260"
        y="158"
      />
      <rect
        fill="none"
        height="18"
        rx="2"
        stroke="var(--success)"
        strokeWidth="1.2"
        width="28"
        x="270"
        y="164"
      />
    </svg>
  );
}

export function ClipPreview() {
  return (
    <svg
      aria-hidden="true"
      className="room-preview"
      focusable="false"
      preserveAspectRatio="xMidYMid meet"
      viewBox="0 0 320 200"
    >
      <rect fill="var(--canvas)" height="200" width="320" />

      {/* What the cut looks like, with a line of subtitle under it. */}
      <rect
        fill="var(--surface)"
        height="92"
        rx="8"
        stroke="var(--stroke)"
        width="300"
        x="10"
        y="10"
      />
      <rect fill="#050506" height="76" rx="5" width="284" x="18" y="18" />
      <circle
        cx="160"
        cy="56"
        fill="var(--surface-raised)"
        r="15"
        stroke="var(--coral)"
        strokeWidth="1.4"
      />
      <path d="M155 47 168 56 155 65Z" fill="var(--coral)" />
      <rect
        fill="var(--ink)"
        height="4"
        opacity="0.72"
        rx="2"
        width="72"
        x="124"
        y="82"
      />

      {/* The tracks, the material on them, and the playhead. */}
      <rect
        fill="var(--surface)"
        height="78"
        rx="8"
        stroke="var(--stroke)"
        width="300"
        x="10"
        y="112"
      />
      <rect fill="var(--canvas)" height="62" rx="4" width="34" x="18" y="120" />
      <rect
        fill="var(--muted)"
        height="3"
        opacity="0.5"
        rx="1.5"
        width="20"
        x="25"
        y="130"
      />
      <rect
        fill="var(--muted)"
        height="3"
        opacity="0.35"
        rx="1.5"
        width="15"
        x="25"
        y="140"
      />
      <rect
        fill="var(--muted)"
        height="3"
        opacity="0.35"
        rx="1.5"
        width="18"
        x="25"
        y="150"
      />
      <path d="M58 118v70" stroke="var(--stroke)" strokeWidth="1.2" />
      <rect
        fill="var(--coral)"
        height="16"
        opacity="0.9"
        rx="3"
        width="70"
        x="65"
        y="124"
      />
      <rect
        fill="var(--surface-raised)"
        height="16"
        rx="3"
        stroke="var(--stroke)"
        width="52"
        x="139"
        y="124"
      />
      <rect
        fill="var(--coral)"
        height="16"
        opacity="0.68"
        rx="3"
        width="66"
        x="195"
        y="124"
      />
      <rect
        fill="var(--success)"
        height="13"
        opacity="0.7"
        rx="3"
        width="42"
        x="65"
        y="144"
      />
      <rect
        fill="var(--surface-raised)"
        height="13"
        rx="3"
        stroke="var(--stroke)"
        width="80"
        x="111"
        y="144"
      />
      <rect
        fill="var(--canvas)"
        height="14"
        rx="3"
        width="210"
        x="65"
        y="162"
      />
      <path
        d="M68 169c4-5 6-5 8 0s4 5 8 0 6-5 8 0 4 5 8 0 6-5 8 0 4 5 8 0 6-5 8 0 4 5 8 0 6-5 8 0 4 5 8 0 6-5 8 0 4 5 8 0 6-5 8 0 4 5 8 0 6-5 8 0 4 5 8 0 6-5 8 0 4 5 8 0 6-5 8 0 4 5 8 0 6-5 8 0 4 5 8 0"
        fill="none"
        stroke="var(--yellow)"
        strokeLinecap="round"
        strokeWidth="1.2"
      />
      <path d="M176 118v70" stroke="var(--ink)" strokeWidth="1.4" />
      <path d="M172 118h8l-4 6Z" fill="var(--ink)" />
    </svg>
  );
}
