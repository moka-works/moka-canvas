import { describe, expect, it } from "vitest";
import {
  HALO_ARC,
  HALO_BREATH_MS,
  HALO_CORNER_RADIUS,
  HALO_GLOW,
  HALO_MAX_ARCS,
  HALO_MIN_ARCS,
  HALO_OFFSET,
  HALO_SELECTED_OFFSET,
  HALO_QUEUED_TURN_MS,
  HALO_TURN_MS,
  haloArcs,
  haloFrame,
  haloOffset,
  haloRing,
  ringPerimeter,
} from "./halo";

const CARD = { width: 260, height: 140 };

describe("the ring round a card that is being worked on", () => {
  it("stands off the card on every side and rounds its corners to match", () => {
    const ring = haloRing(CARD);
    expect(ring.x).toBe(-HALO_OFFSET);
    expect(ring.y).toBe(-HALO_OFFSET);
    expect(ring.width).toBe(CARD.width + HALO_OFFSET * 2);
    expect(ring.height).toBe(CARD.height + HALO_OFFSET * 2);
    expect(ring.cornerRadius).toBe(HALO_CORNER_RADIUS + HALO_OFFSET);
  });

  it("stands further off a card that is wearing its selection outline", () => {
    // The outline is drawn five pixels out from the card and painted over it, so
    // a ring at the usual distance would be hidden behind the very outline that
    // says "this is the card being run".
    expect(haloOffset(false)).toBe(HALO_OFFSET);
    expect(haloOffset(true)).toBe(HALO_SELECTED_OFFSET);
    expect(haloOffset(true)).toBeGreaterThan(6);
    const plain = haloRing(CARD, haloOffset(false));
    const selected = haloRing(CARD, haloOffset(true));
    expect(selected.x).toBeLessThan(plain.x);
    expect(selected.width).toBeGreaterThan(plain.width);
  });

  it("cuts the arcs for the standoff the ring is actually standing at", () => {
    const plain = haloArcs(CARD, haloOffset(false));
    const selected = haloArcs(CARD, haloOffset(true));
    expect(selected.lap).toBeGreaterThan(plain.lap);
    expect((selected.dash + selected.gap) * selected.arcs).toBeCloseTo(
      selected.lap,
      6,
    );
  });

  it("never rounds a corner more than the ring can carry", () => {
    const ring = haloRing({ width: 4, height: 40 });
    expect(ring.cornerRadius).toBeLessThanOrEqual(ring.width / 2);
  });

  it("measures the ring as its straights plus its four quarter-corners", () => {
    expect(ringPerimeter(100, 50, 0)).toBeCloseTo(300);
    expect(ringPerimeter(100, 50, 10)).toBeCloseTo(
      2 * 80 + 2 * 30 + 2 * Math.PI * 10,
    );
    // A corner bigger than the side is drawn as big as the side allows, which
    // leaves this one with no horizontal straight at all.
    expect(ringPerimeter(20, 100, 40)).toBeCloseTo(2 * 80 + 2 * Math.PI * 10);
  });
});

describe("the arcs cut out of that ring", () => {
  it("fits a whole number of them round the ring, so no seam shows", () => {
    const { dash, gap, lap, arcs } = haloArcs(CARD);
    expect(arcs).toBeGreaterThanOrEqual(HALO_MIN_ARCS);
    expect(arcs).toBeLessThanOrEqual(HALO_MAX_ARCS);
    expect((dash + gap) * arcs).toBeCloseTo(lap, 6);
  });

  it("measures the lap as the distance round the ring it is cut for", () => {
    const ring = haloRing(CARD);
    expect(haloArcs(CARD).lap).toBeCloseTo(
      ringPerimeter(ring.width, ring.height, ring.cornerRadius),
      6,
    );
  });

  it("gives a small card fewer arcs and a wide one more, within reason", () => {
    expect(haloArcs({ width: 40, height: 40 }).arcs).toBe(HALO_MIN_ARCS);
    expect(haloArcs(CARD).arcs).toBeGreaterThan(HALO_MIN_ARCS);
    const wide = haloArcs({ width: 4000, height: 2000 }).arcs;
    expect(wide).toBeGreaterThan(HALO_MIN_ARCS);
    expect(wide).toBe(HALO_MAX_ARCS);
  });

  it("grows the lap with the card, since a bigger ring is further round", () => {
    expect(haloArcs({ width: 600, height: 400 }).lap).toBeGreaterThan(
      haloArcs(CARD).lap,
    );
  });
});

describe("the movement of the ring over time", () => {
  const pattern = haloArcs(CARD);
  const { lap } = pattern;

  it("travels forward, and never further than one lap from where it began", () => {
    const first = haloFrame(0, pattern, false);
    const later = haloFrame(HALO_TURN_MS / 4, pattern, false);
    expect(first.dashOffset).toBeCloseTo(0);
    expect(later.dashOffset).toBeLessThan(first.dashOffset);
    expect(later.dashOffset).toBeGreaterThan(-lap);
  });

  it("comes back to where it started after exactly one lap", () => {
    expect(haloFrame(HALO_TURN_MS, pattern, false).dashOffset).toBeCloseTo(0);
    expect(haloFrame(HALO_TURN_MS * 3, pattern, false).dashOffset).toBeCloseTo(
      0,
    );
  });

  it("keeps the same reading for two cards asked at the same moment", () => {
    // Both rings are read off the one clock, so a canvas full of running nodes
    // looks like one effect rather than a hundred that began at different times.
    expect(haloFrame(1234, pattern, false)).toEqual(
      haloFrame(1234, pattern, false),
    );
  });

  it("turns a waiting card more slowly than a working one", () => {
    const at = HALO_TURN_MS / 4;
    const working = haloFrame(at, pattern, false).dashOffset;
    const waiting = haloFrame(at, pattern, true).dashOffset;
    expect(Math.abs(waiting)).toBeLessThan(Math.abs(working));
    expect(waiting).toBeCloseTo(working * (HALO_TURN_MS / HALO_QUEUED_TURN_MS));
  });

  it("breathes: dim at the start of a breath, bright halfway through it", () => {
    const bottom = haloFrame(0, pattern, false);
    const top = haloFrame(HALO_BREATH_MS / 2, pattern, false);
    expect(bottom.glow).toBeCloseTo(HALO_GLOW.working.dim);
    expect(top.glow).toBeCloseTo(HALO_GLOW.working.bright);
    expect(bottom.arc).toBeCloseTo(HALO_ARC.working.dim);
    expect(top.arc).toBeCloseTo(HALO_ARC.working.bright);
    expect(haloFrame(HALO_BREATH_MS, pattern, false).glow).toBeCloseTo(
      HALO_GLOW.working.dim,
    );
  });

  it("keeps every brightness it reports inside the range it was given", () => {
    for (const waiting of [false, true]) {
      for (let at = 0; at < HALO_QUEUED_TURN_MS; at += 97) {
        const frame = haloFrame(at, pattern, waiting);
        const glow = waiting ? HALO_GLOW.waiting : HALO_GLOW.working;
        const arc = waiting ? HALO_ARC.waiting : HALO_ARC.working;
        expect(frame.glow).toBeGreaterThanOrEqual(glow.dim);
        expect(frame.glow).toBeLessThanOrEqual(glow.bright);
        expect(frame.arc).toBeGreaterThanOrEqual(arc.dim);
        expect(frame.arc).toBeLessThanOrEqual(arc.bright);
      }
    }
  });

  it("glows less for a card that is only waiting its turn", () => {
    const at = HALO_BREATH_MS / 2;
    expect(haloFrame(at, pattern, true).glow).toBeLessThan(
      haloFrame(at, pattern, false).glow,
    );
    expect(haloFrame(at, pattern, true).arc).toBeLessThan(
      haloFrame(at, pattern, false).arc,
    );
  });
});

describe("the wake each arc drags behind it", () => {
  const pattern = haloArcs(CARD);

  it("trails back from its arc without reaching the one behind it", () => {
    for (const tail of pattern.tails) {
      // A wake begins behind its arc's start but never as far back as the arc
      // behind it ends: every arc keeps its own stretch of ring.
      expect(tail.lead).toBeGreaterThan(0);
      expect(tail.lead).toBeLessThan(pattern.gap);
      // Its front runs under the arc's light, hidden by the round cap of the
      // head, rather than past the arc's leading edge.
      expect(tail.dash - tail.lead).toBeGreaterThan(0);
      expect(tail.dash - tail.lead).toBeLessThan(pattern.dash);
      expect(tail.dash + tail.gap).toBeCloseTo(pattern.dash + pattern.gap, 6);
    }
  });

  it("fades and widens the further back the layers reach", () => {
    for (let index = 1; index < pattern.tails.length; index += 1) {
      expect(pattern.tails[index].lead).toBeLessThan(
        pattern.tails[index - 1].lead,
      );
      expect(pattern.tails[index].alpha).toBeGreaterThan(
        pattern.tails[index - 1].alpha,
      );
      expect(pattern.tails[index].width).toBeLessThan(
        pattern.tails[index - 1].width,
      );
    }
  });

  it("keeps its place a fixed distance behind the arc, in step with the light", () => {
    for (const at of [0, HALO_TURN_MS / 3, HALO_BREATH_MS / 2]) {
      const frame = haloFrame(at, pattern, false);
      pattern.tails.forEach((tail, index) => {
        expect(frame.tails[index].dashOffset - frame.dashOffset).toBeCloseTo(
          tail.lead,
        );
        expect(frame.tails[index].opacity).toBeGreaterThan(0);
        expect(frame.tails[index].opacity).toBeLessThanOrEqual(frame.glow);
      });
    }
  });

  it("breathes with the light: brighter halfway through a breath than at its start", () => {
    const bottom = haloFrame(0, pattern, false);
    const top = haloFrame(HALO_BREATH_MS / 2, pattern, false);
    pattern.tails.forEach((_, index) => {
      expect(top.tails[index].opacity).toBeGreaterThan(
        bottom.tails[index].opacity,
      );
    });
  });
});
