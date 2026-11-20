import React from "react";

/**
 * Agent avatars: the role sets the colour, the member's number the shape.
 * coder1 is a blue circle, coder2 a blue square, planner1 a red circle…
 */
export const ROLE_COLORS: Record<string, string> = {
  planner: "#ef4444",
  coder: "#3b82f6",
  generator: "#22c55e",
  reviewer: "#a855f7",
  researcher: "#f59e0b",
  debugger: "#14b8a6",
};
const OTHER_COLOR = "#64748b";

export const SHAPES = [
  "circle",
  "square",
  "triangle",
  "diamond",
  "hexagon",
  "star",
  "pentagon",
] as const;
export type Shape = (typeof SHAPES)[number];

export function roleColor(role?: string): string {
  return (role && ROLE_COLORS[role.toLowerCase()]) || OTHER_COLOR;
}

/** coder1 → circle, coder2 → square…; names without a number get a stable shape. */
export function shapeFor(name?: string): Shape {
  const n = name?.match(/(\d+)\s*$/)?.[1];
  if (n) return SHAPES[(Math.max(1, Number(n)) - 1) % SHAPES.length]!;
  let hash = 0;
  for (const ch of name ?? "") hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return SHAPES[hash % SHAPES.length]!;
}

function points(count: number, radius: number, rotate = -90, inner = 0) {
  const out: string[] = [];
  const steps = inner ? count * 2 : count;
  for (let i = 0; i < steps; i++) {
    const r = inner && i % 2 ? inner : radius;
    const a = ((rotate + (360 / steps) * i) * Math.PI) / 180;
    out.push(`${(16 + r * Math.cos(a)).toFixed(2)},${(16 + r * Math.sin(a)).toFixed(2)}`);
  }
  return out.join(" ");
}

function ShapePath({ shape, color }: { shape: Shape; color: string }) {
  const props = {
    fill: color,
    fillOpacity: 1,
    stroke: color,
    strokeWidth: 1.5,
    strokeLinejoin: "round" as const,
  };
  switch (shape) {
    case "circle":
      return <circle cx="16" cy="16" r="11" {...props} />;
    case "square":
      return <rect x="6" y="6" width="20" height="20" rx="3" {...props} />;
    case "triangle":
      return <polygon points={points(3, 13, -90)} {...props} transform="translate(0 2)" />;
    case "diamond":
      return <polygon points={points(4, 13, -90)} {...props} />;
    case "hexagon":
      return <polygon points={points(6, 12, -90)} {...props} />;
    case "star":
      return <polygon points={points(5, 13, -90, 6)} {...props} />;
    case "pentagon":
      return <polygon points={points(5, 12, -90)} {...props} />;
  }
}

/** Where the face sits inside each shape (triangles carry it lower). */
const FACE_Y: Partial<Record<Shape, number>> = { triangle: 19, star: 17 };

function Face({ y, scale = 1 }: { y: number; scale?: number }) {
  const ink = "#0f172a";
  return (
    <g transform={`translate(16 ${y}) scale(${scale})`}>
      <circle cx="-3.6" cy="-1.6" r="1.6" fill={ink} />
      <circle cx="3.6" cy="-1.6" r="1.6" fill={ink} />
      <circle cx="-3.1" cy="-2.1" r="0.5" fill="#fff" />
      <circle cx="4.1" cy="-2.1" r="0.5" fill="#fff" />
      <path
        d="M -3 2.2 Q 0 4.8 3 2.2"
        fill="none"
        stroke={ink}
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </g>
  );
}

/** Cobble itself: always the same grey pebble with a face. */
export const COBBLE_COLOR = "#94a3b8";

export function AgentGlyph({
  role,
  name,
  size = 32,
  title,
}: {
  role?: string;
  name?: string;
  size?: number;
  title?: string;
}) {
  if (role === "cobble")
    return (
      <svg
        className="ui-glyph"
        width={size}
        height={size}
        viewBox="0 0 32 32"
        role="img"
        aria-label={title ?? "Cobble"}
        data-shape="pebble"
        data-role="cobble"
      >
        <ellipse
          cx="16"
          cy="17"
          rx="13"
          ry="10.5"
          fill={COBBLE_COLOR}
          stroke={COBBLE_COLOR}
          strokeWidth="1.5"
        />
        <Face y={17} />
      </svg>
    );
  const shape = shapeFor(name ?? role);
  const color = roleColor(role);
  return (
    <svg
      className="ui-glyph"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label={title ?? `${name ?? role ?? "agent"} (${role ?? "agent"})`}
      data-shape={shape}
      data-role={role}
    >
      <ShapePath shape={shape} color={color} />
      <Face
        y={FACE_Y[shape] ?? 16}
        scale={shape === "triangle" || shape === "star" ? 0.8 : 1}
      />
    </svg>
  );
}
