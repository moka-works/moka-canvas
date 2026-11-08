/**
 * The light that goes round a card while its node is being worked on.
 *
 * Everything here is arithmetic: how long the ring is, how the bright arcs,
 * their wakes, the sonar rings and the sweep across the card are cut out of
 * it, and where all of that has got to at a given moment. The drawing module
 * puts these numbers on a stack of shapes, and the controller asks for a fresh
 * frame on every tick of the browser's clock. Nothing here knows what a leafer
 * is, so the light can be reasoned about — and tested — as the shapes it is.
 */

/** A card's own box, in the world's units. */
export interface HaloBounds {
  width: number;
  height: number;
}

/** The corner a card is drawn with, which the ring has to match. */
export const HALO_CORNER_RADIUS = 12;
/** How far the ring stands off the edge of the card it goes round. */
export const HALO_OFFSET = 4;
/**
 * How far it stands off a card that is also selected.
 *
 * The outline a selected card wears is drawn five pixels out from it and painted
 * over everything the card owns, so a ring at its usual distance would sit
 * behind it — and a card is selected at the very moment it is asked to run,
 * which is the one moment the ring has to be seen. The ring steps outside the
 * outline instead of arguing with it.
 */
export const HALO_SELECTED_OFFSET = 9;
/** How thick the arcs are drawn, and the light under them. */
export const HALO_STROKE = 4;
export const HALO_GLOW_STROKE = 8;
export const HALO_GLOW_BLUR = 20;

/**
 * The stretch of ring one arc is asked to cover.
 *
 * The count of arcs follows from this rather than being fixed, so a card of
 * ordinary size carries about one arc per corner, a small one two, and a very
 * wide one no more than the ceiling: an arc stays about this long whatever the
 * card, and never crowds a corner or leaves a small one wearing a single comma.
 */
export const HALO_ARC_SPACING = 200;
export const HALO_MIN_ARCS = 2;
export const HALO_MAX_ARCS = 6;
/** What fraction of its own stretch an arc lights up; the rest stays dark. */
export const HALO_ARC_SPAN = 0.3;

/** One lap of the arcs, in milliseconds, for a node being worked on. */
export const HALO_TURN_MS = 2400;
/**
 * One lap for a node still waiting its turn.
 *
 * Waiting is drawn slower and fainter rather than not drawn at all: a card in
 * the queue still says something is coming, without claiming to be working.
 */
export const HALO_QUEUED_TURN_MS = 9000;
/** One breath of the light under the arcs. */
export const HALO_BREATH_MS = 2400;

/**
 * The wake each arc drags round with it: how far it reaches back along the
 * ring (in arc-lengths), how thick that stretch is drawn, and how much of the
 * light under the arcs it carries.
 *
 * Two layers, the far one first, so the near wake keeps the comet solid behind
 * the head and the far one lets it die away instead of stopping short. A wake
 * always reaches less than the gap to the arc behind it, and ends inside its
 * own arc's lit stretch, so its round cap hides under the head rather than
 * poking past the leading edge.
 */
export const HALO_TAILS = [
  { reach: 1.5, width: 6.5, alpha: 0.34 },
  { reach: 0.8, width: 5, alpha: 0.75 },
] as const;
/** How much of its own arc a wake runs under, hiding its front end. */
export const HALO_TAIL_OVERLAP = 0.25;

/** How bright the light under the arcs gets, at the bottom and top of a breath. */
export const HALO_GLOW = {
  working: { dim: 0.62, bright: 0.9 },
  waiting: { dim: 0.22, bright: 0.38 },
};
/** How bright the arcs themselves get over the same breath. */
export const HALO_ARC = {
  working: { dim: 0.85, bright: 1 },
  waiting: { dim: 0.45, bright: 0.62 },
};

/**
 * The wide, soft aura the card sits in, which breathes with the rest.
 *
 * It is a second ring, standing further off and drawn much wider and softer
 * than the arcs, so a card being worked on reads as hot from across the canvas
 * even where the thin strokes have gone out of sight.
 */
export const HALO_BLOOM = {
  working: { dim: 0.18, bright: 0.36 },
  waiting: { dim: 0.05, bright: 0.11 },
};
/** How far that aura stands off, how wide it is drawn, and how soft it fades. */
export const HALO_BLOOM_STANDOFF = 8;
export const HALO_BLOOM_STROKE = 14;
export const HALO_BLOOM_BLUR = 44;

/**
 * The sonar rings sent out from the card, and their rhythm.
 *
 * A fresh ring leaves the card on a fixed beat, widens as it goes and fades as
 * it widens. Two are in flight at once, half a beat apart, so the card keeps
 * pulsing rather than blinking once per period. A waiting card sends them far
 * more slowly and fainter.
 */
export const HALO_SONAR = {
  working: { period: 1800, alpha: 0.5 },
  waiting: { period: 5200, alpha: 0.18 },
};
export const HALO_SONAR_RINGS = 2;
/** How far out a ring has travelled by the end of its flight. */
export const HALO_SONAR_SPREAD = 36;
/** How thick a ring is at the start of its flight and at the end. */
export const HALO_SONAR_STROKE = { start: 4, end: 1 };

/**
 * The band of light that sweeps across the card itself, and its rhythm.
 *
 * It is the one effect that crosses the card rather than going round it, so it
 * is kept to a faint tint of the node's own colour and fades out at both ends
 * of its travel instead of popping in and out.
 */
export const HALO_SHEEN = {
  working: { period: 2600, alpha: 0.45 },
  waiting: { period: 7000, alpha: 0.18 },
};
/** How much of the card's width the lit band covers. */
export const HALO_SHEEN_BAND = 0.34;

/** Where the ring sits, measured from the card's own top-left corner. */
export interface HaloRing {
  x: number;
  y: number;
  width: number;
  height: number;
  cornerRadius: number;
}

/** How the bright arcs are cut out of a ring this size. */
export interface HaloArcs {
  /** The lit stretch of one arc. */
  dash: number;
  /** The dark stretch between it and the next. */
  gap: number;
  /** The whole ring, which is also the distance of one lap. */
  lap: number;
  /** How many arcs the ring carries. */
  arcs: number;
  /** The wakes the arcs drag behind them, far layer first. */
  tails: HaloTailCut[];
  /** The ring all of the above was cut for. */
  ring: HaloRing;
  /** The card that ring stands round, which the sweep and the sonar use. */
  card: HaloBounds;
}

/** A point in the card's own units, which is where the ring is drawn. */
export interface HaloPoint {
  x: number;
  y: number;
}

/** How one wake layer is cut out of the same ring as the arcs. */
export interface HaloTailCut {
  /** The lit stretch of this wake layer. */
  dash: number;
  /** The dark stretch that completes its slot round the ring. */
  gap: number;
  /** How far ahead of its arc's stretch this layer begins, so it trails behind. */
  lead: number;
  /** How thick the layer is drawn. */
  width: number;
  /** The share of the ring's light this layer carries. */
  alpha: number;
}

/** One wake layer's place in a frame. */
export interface HaloTailFrame {
  /** Where this layer's stretch begins. */
  dashOffset: number;
  /** How bright it is on this frame. */
  opacity: number;
}

/** One sonar ring's place in a frame. */
export interface HaloRippleFrame {
  /** The ring to draw, already grown to where it has got to. */
  ring: HaloRing;
  /** How bright it is on this frame, from fresh to spent. */
  opacity: number;
  /** How thick its stroke is on this frame, thinning as it travels. */
  width: number;
}

/** The band of light crossing the card on this frame. */
export interface HaloSheenFrame {
  /** Where the band's leading edge has got to, in the card's own units. */
  x: number;
  /** How wide the band is on this card. */
  width: number;
  /** How bright it is, fading out at both ends of its travel. */
  opacity: number;
}

/** One frame of the halo's movement. */
export interface HaloFrame {
  /** Where the dashes begin, and so how far the arcs have travelled. */
  dashOffset: number;
  /** How bright the light under the arcs is on this frame. */
  glow: number;
  /** How bright the wide aura under everything is on this frame. */
  bloom: number;
  /** How bright the arcs are on this frame. */
  arc: number;
  /** One entry per wake layer, in the order they are cut. */
  tails: HaloTailFrame[];
  /** The sonar rings in flight, the freshest first. */
  ripples: HaloRippleFrame[];
  /** The sweep across the card. */
  sheen: HaloSheenFrame;
  /** The bright point at the leading end of every arc. */
  heads: HaloPoint[];
}

/**
 * How far the ring stands off a card in this state.
 *
 * A selected card steps its ring out past the outline it is wearing; any other
 * card keeps the ring close, where it reads as the card's own light.
 */
export function haloOffset(selected: boolean): number {
  return selected ? HALO_SELECTED_OFFSET : HALO_OFFSET;
}

/**
 * The box the ring is drawn in, standing off the card on every side.
 *
 * Its corner is the card's own grown by the standoff, so the ring keeps the
 * same distance from the card round a corner as it does along a straight, and
 * never more than the shorter side of the ring can carry.
 */
export function haloRing(bounds: HaloBounds, offset = HALO_OFFSET): HaloRing {
  const width = Math.max(1, bounds.width + offset * 2);
  const height = Math.max(1, bounds.height + offset * 2);
  return {
    x: -offset,
    y: -offset,
    width,
    height,
    cornerRadius: Math.min(HALO_CORNER_RADIUS + offset, width / 2, height / 2),
  };
}

/**
 * How far it is round a ring this size.
 *
 * The four straights plus the four quarter-corners, which is the distance the
 * dashes are laid along and so the distance one lap of them covers.
 */
export function ringPerimeter(
  width: number,
  height: number,
  cornerRadius: number,
): number {
  const radius = Math.min(
    Math.max(0, cornerRadius),
    Math.max(0, width) / 2,
    Math.max(0, height) / 2,
  );
  const straight = 2 * (width - radius * 2) + 2 * (height - radius * 2);
  return Math.max(0, straight) + 2 * Math.PI * radius;
}

/**
 * The dashes that make the arcs of a ring round a card this size.
 *
 * Cut so that a whole number of them fits the ring exactly: a pattern that
 * comes up short shows the seam where it starts again, and a seam that travels
 * round the card is the one thing this light should not appear to have.
 */
export function haloArcs(bounds: HaloBounds, offset = HALO_OFFSET): HaloArcs {
  const ring = haloRing(bounds, offset);
  const lap = ringPerimeter(ring.width, ring.height, ring.cornerRadius);
  const wanted = Math.round(lap / HALO_ARC_SPACING);
  const arcs = Math.min(HALO_MAX_ARCS, Math.max(HALO_MIN_ARCS, wanted));
  const slot = lap / arcs;
  const dash = slot * HALO_ARC_SPAN;
  const gap = slot - dash;
  const overlap = dash * HALO_TAIL_OVERLAP;
  const tails = HALO_TAILS.map((tail) => {
    // A wake reaches back less than the gap to the arc behind it, and runs
    // past its own arc's start only as far as the overlap, so its front cap
    // sits under the head rather than past the arc's leading edge.
    const reach = Math.min(tail.reach * dash, gap * 0.95);
    return {
      dash: reach + overlap,
      gap: slot - reach - overlap,
      lead: reach,
      width: tail.width,
      alpha: tail.alpha,
    };
  });
  return { dash, gap, lap, arcs, tails, ring, card: bounds };
}

/** Wraps a distance into the half-open range [0, length). */
function wrap(value: number, length: number): number {
  return ((value % length) + length) % length;
}

/**
 * The point a given distance round the ring.
 *
 * Walks from the end of the top-left corner clockwise, the same way the dashes
 * are laid, so a bright head can be put exactly on the leading end of an arc.
 * Distances past one lap, or below zero, wrap round.
 */
export function ringPointAt(ring: HaloRing, distance: number): HaloPoint {
  const radius = Math.min(
    Math.max(0, ring.cornerRadius),
    Math.max(0, ring.width) / 2,
    Math.max(0, ring.height) / 2,
  );
  const width = Math.max(0, ring.width);
  const height = Math.max(0, ring.height);
  const top = width - radius * 2;
  const side = height - radius * 2;
  const quarter = (Math.PI * radius) / 2;
  const lap = Math.max(0, 2 * top + 2 * side) + 4 * quarter;
  if (lap <= 0) return { x: ring.x, y: ring.y };
  let left = wrap(distance, lap);

  if (left <= top) return { x: ring.x + radius + left, y: ring.y };
  left -= top;

  if (radius > 0 && left <= quarter) {
    const angle = -Math.PI / 2 + left / radius;
    return {
      x: ring.x + width - radius + radius * Math.cos(angle),
      y: ring.y + radius + radius * Math.sin(angle),
    };
  }
  left -= quarter;

  if (left <= side) return { x: ring.x + width, y: ring.y + radius + left };
  left -= side;

  if (radius > 0 && left <= quarter) {
    const angle = left / radius;
    return {
      x: ring.x + width - radius + radius * Math.cos(angle),
      y: ring.y + height - radius + radius * Math.sin(angle),
    };
  }
  left -= quarter;

  if (left <= top) {
    return { x: ring.x + width - radius - left, y: ring.y + height };
  }
  left -= top;

  if (radius > 0 && left <= quarter) {
    const angle = Math.PI / 2 + left / radius;
    return {
      x: ring.x + radius + radius * Math.cos(angle),
      y: ring.y + height - radius + radius * Math.sin(angle),
    };
  }
  left -= quarter;

  if (left <= side) return { x: ring.x, y: ring.y + height - radius - left };
  left -= side;

  if (radius > 0 && left <= quarter) {
    const angle = Math.PI + left / radius;
    return {
      x: ring.x + radius + radius * Math.cos(angle),
      y: ring.y + radius + radius * Math.sin(angle),
    };
  }

  return { x: ring.x + radius, y: ring.y };
}

/** The sonar rings in flight at this moment, the freshest first. */
function haloRipples(
  at: number,
  pattern: HaloArcs,
  waiting: boolean,
): HaloRippleFrame[] {
  const rhythm = waiting ? HALO_SONAR.waiting : HALO_SONAR.working;
  const offset = -pattern.ring.x;
  return Array.from({ length: HALO_SONAR_RINGS }, (_, index) => {
    const phase =
      (wrap(at, rhythm.period) / rhythm.period + index / HALO_SONAR_RINGS) % 1;
    // Fast at first and slowing as it goes, the way a wave leaves its source.
    const reach = 1 - (1 - phase) ** 2;
    const fade = 1 - phase;
    return {
      ring: haloRing(pattern.card, offset + reach * HALO_SONAR_SPREAD),
      opacity: rhythm.alpha * fade,
      width:
        HALO_SONAR_STROKE.end +
        (HALO_SONAR_STROKE.start - HALO_SONAR_STROKE.end) * fade,
    };
  });
}

/** Where the band of light crossing the card has got to. */
function haloSheen(
  at: number,
  card: HaloBounds,
  waiting: boolean,
): HaloSheenFrame {
  const rhythm = waiting ? HALO_SHEEN.waiting : HALO_SHEEN.working;
  const phase = wrap(at, rhythm.period) / rhythm.period;
  const width = Math.max(0, card.width) * HALO_SHEEN_BAND;
  return {
    x: -width + phase * (Math.max(0, card.width) + width),
    width,
    opacity: rhythm.alpha * Math.sin(Math.PI * phase),
  };
}

/** One point per arc, on the leading end of its lit stretch. */
function haloHeads(pattern: HaloArcs, dashOffset: number): HaloPoint[] {
  const slot = pattern.dash + pattern.gap;
  const phase = -dashOffset;
  return Array.from({ length: pattern.arcs }, (_, index) =>
    ringPointAt(pattern.ring, phase + index * slot + pattern.dash),
  );
}

function between(dim: number, bright: number, breath: number): number {
  return dim + (bright - dim) * breath;
}

/**
 * Where the halo has got to.
 *
 * The arcs travel a fixed distance per lap and the light under them breathes on
 * a clock of its own, so two cards that began at different moments still look
 * like the same effect: both are read off the one clock rather than from when
 * each of them happened to start. A card that is only waiting its turn turns
 * more slowly and glows less, which is the difference between "soon" and "now".
 *
 * Each wake keeps its place a fixed distance behind its arc and takes its
 * brightness from the same breath as the light it sits in, so the comet reads
 * as one body rather than as a line chasing another. The sonar rings and the
 * sweep are read off the same clock too, and the heads ride the leading end of
 * every arc.
 */
export function haloFrame(
  at: number,
  pattern: HaloArcs,
  waiting: boolean,
): HaloFrame {
  const turn = waiting ? HALO_QUEUED_TURN_MS : HALO_TURN_MS;
  const progress = wrap(at, turn) / turn;
  const breath =
    (1 - Math.cos((2 * Math.PI * wrap(at, HALO_BREATH_MS)) / HALO_BREATH_MS)) /
    2;
  const glow = waiting ? HALO_GLOW.waiting : HALO_GLOW.working;
  const bloom = waiting ? HALO_BLOOM.waiting : HALO_BLOOM.working;
  const arc = waiting ? HALO_ARC.waiting : HALO_ARC.working;
  const dashOffset = -progress * pattern.lap;
  const light = between(glow.dim, glow.bright, breath);
  return {
    dashOffset,
    glow: light,
    bloom: between(bloom.dim, bloom.bright, breath),
    arc: between(arc.dim, arc.bright, breath),
    tails: pattern.tails.map((tail) => ({
      dashOffset: dashOffset + tail.lead,
      opacity: light * tail.alpha,
    })),
    ripples: haloRipples(at, pattern, waiting),
    sheen: haloSheen(at, pattern.card, waiting),
    heads: haloHeads(pattern, dashOffset),
  };
}
