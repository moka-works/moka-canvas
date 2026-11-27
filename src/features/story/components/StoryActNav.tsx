import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { StoryAct } from "../../../shared/domain";

/**
 * How many acts a board holds before the rail beside it is worth its room: a
 * board of a few acts is read by scrolling, a long one by pointing.
 */
export const STORY_ACT_NAV_MIN = 3;

/** Where a jump puts an act's head, below the top of the step's window. */
const JUMP_GAP = 12;

/** How far down the window an act's head has to reach to be the act read. */
const READING_LINE = 32;

/**
 * The rail of act numbers beside a long board.
 *
 * The board is one act after another, and an episode of twenty acts is
 * several windows of scrolling to reach the fourth from the end; the rail
 * names every act once, marks the one being read, and puts the reader at an
 * act's head in one press.
 *
 * Nothing here is measured ahead of time: an act folded to its head is a
 * tenth of the height it had, and the acts under it move up with it — so
 * every reading of the page is taken from the page as it stands, on scrolling
 * and on the board changing height, rather than from places remembered.
 */
export function StoryActNav({
  acts,
  chapterId,
}: {
  acts: StoryAct[];
  chapterId: string;
}) {
  const { t } = useTranslation();
  const rail = useRef<HTMLElement | null>(null);
  const chips = useRef<Array<HTMLButtonElement | null>>([]);
  const [active, setActive] = useState(0);
  // Which acts stand where, so that another list — another episode, an act
  // added or taken away, two acts put the other way round — is measured anew.
  const order = acts.map((held) => held.id).join("|");

  useEffect(() => {
    const { scroller, list } = boardOf(rail.current);
    if (scroller === null || list === null) return;

    let frame = 0;
    const measure = () => {
      frame = 0;
      const { rows } = boardOf(rail.current);
      if (rows.length === 0) return;
      const line = scroller.getBoundingClientRect().top + READING_LINE;
      let at = 0;
      rows.forEach((row, index) => {
        if (row.getBoundingClientRect().top <= line) at = index;
      });
      // The end of the board is its last act even when the acts are too short
      // for their heads to cross the line.
      if (
        scroller.scrollTop + scroller.clientHeight >=
        scroller.scrollHeight - 2
      ) {
        at = rows.length - 1;
      }
      setActive(at);
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };

    measure();
    scroller.addEventListener("scroll", schedule, { passive: true });
    // Folding an act, unfolding it, or a drawing arriving under its table
    // changes the height of the board, and with it every act's place.
    const observer =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(schedule)
        : null;
    observer?.observe(list);
    window.addEventListener("resize", schedule);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", schedule);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
    };
    // The rail follows the board it is beside: another episode, or acts added
    // to or taken from this one, is another list of places.
  }, [chapterId, order]);

  const jump = (at: number) => {
    const { scroller, rows } = boardOf(rail.current);
    const row = rows[at];
    if (scroller === null || scroller === undefined || row === undefined) {
      return;
    }
    const top =
      scroller.scrollTop +
      row.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top -
      JUMP_GAP;
    if (typeof scroller.scrollTo === "function") {
      scroller.scrollTo({ top, behavior: "smooth" });
    } else {
      scroller.scrollTop = top;
    }
    setActive(at);
  };

  // The mark being read is kept inside the rail's own window, so a long board
  // does not leave it scrolled away above or below.
  useEffect(() => {
    const element = rail.current;
    const chip = chips.current[active];
    if (element === null || chip === undefined || chip === null) return;
    const top = chip.offsetTop;
    const bottom = top + chip.offsetHeight;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (bottom > element.scrollTop + element.clientHeight) {
      element.scrollTop = bottom - element.clientHeight;
    }
  }, [active]);

  if (acts.length < STORY_ACT_NAV_MIN) return null;

  return (
    <nav
      aria-label={t("story:storyboard.actNav")}
      className="story-act-nav"
      data-testid="story-act-nav"
      ref={rail}
    >
      {acts.map((held, at) => {
        const title =
          held.transition === undefined
            ? held.title
            : t("story:storyboard.transitionTitle");
        const label = t("story:storyboard.actNavTo", {
          index: at + 1,
          title,
        });
        return (
          <button
            aria-current={at === active ? "true" : undefined}
            aria-label={label}
            className={`story-act-nav-chip${at === active ? " is-on" : ""}`}
            data-testid={`story-act-nav-${at}`}
            key={held.id}
            onClick={() => jump(at)}
            ref={(element) => {
              chips.current[at] = element;
            }}
            title={label}
            type="button"
          >
            {at + 1}
          </button>
        );
      })}
    </nav>
  );
}
/** The step's scroller, the board inside it, and the board's act rows. */
function boardOf(rail: HTMLElement | null): {
  scroller: HTMLElement | null;
  list: HTMLElement | null;
  rows: HTMLElement[];
} {
  const scroller = rail?.closest<HTMLElement>(".story-step-body") ?? null;
  const list = scroller?.querySelector<HTMLElement>(".story-acts") ?? null;
  const rows =
    list === null
      ? []
      : Array.from(list.children).filter(
          (child): child is HTMLElement =>
            child instanceof HTMLElement &&
            child.classList.contains("story-act"),
        );
  return { scroller, list, rows };
}
