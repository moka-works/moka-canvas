import { useEffect } from "react";
import { useProjectStore } from "../../editor/stores/projectStore";
import { activeTimeline } from "../interactions/clipActions";
import { useClipStore } from "../stores/clipStore";
import { cutEndMs, xAt } from "../timeline/geometry";
import { audioEngine } from "./audioGraph";
import { previewFrames } from "./frames";

/**
 * The clock the cut is played by, and where the playing head is followed.
 *
 * Playback is a wall clock and nothing else: the playhead is moved by what
 * `performance.now()` has done since play was pressed, and sound follows it
 * rather than driving it. A room whose audio will not start is a silent
 * preview, and a decoder that cannot keep up is a frame dropped — neither is
 * a reason for the clock to stop.
 *
 * The hook is the only thing that turns the store's `playing` flag into
 * motion: it runs the animation-frame loop, stops at the cut's end (or comes
 * back round when the repeat is on), pages the view along behind the head,
 * and hands the audio engine the same moments. It is mounted for as long as
 * the room is, and taken down with it.
 */

/** How much of the pane stays ahead of the playhead before the view is paged. */
const FOLLOW_MARGIN_PX = 80;
/** Where a paged playhead lands: a sixth of the way in, with the cut ahead. */
const FOLLOW_AT = 0.15;

export function useTransport(): void {
  useEffect(() => {
    const audio = audioEngine();
    const frames = previewFrames();
    let raf: number | null = null;
    let startWall = 0;
    let startMs = 0;

    /** Pages the view when the head crosses the right edge, or is left behind it. */
    const follow = (atMs: number): void => {
      const state = useClipStore.getState();
      if (state.viewportPx <= 0) return;
      const x = xAt(atMs, state.view);
      const crossed = x > state.viewportPx - FOLLOW_MARGIN_PX || x < 0;
      if (!crossed) return;
      const scrollLeftPx = Math.max(
        0,
        (atMs / 1_000) * state.view.pxPerSec - state.viewportPx * FOLLOW_AT,
      );
      if (Math.abs(scrollLeftPx - state.view.scrollLeftPx) < 1) return;
      state.setView({ scrollLeftPx });
    };

    const frame = (): void => {
      raf = null;
      const state = useClipStore.getState();
      if (!state.playing) return;
      const timeline = activeTimeline();
      const end = timeline ? cutEndMs(timeline) : 0;
      const now = performance.now();
      let atMs = startMs + (now - startWall);
      if (end <= 0 || atMs >= end) {
        if (state.loop && end > 0) {
          // The end is the head again: the clock is restarted there and the
          // sounding and the runs are taken up from the top. The audio engine
          // rebuilds through the same entry a document change uses.
          startMs = 0;
          startWall = now;
          atMs = 0;
          state.setPlayheadFromClock(0);
          frames.stopPlayback();
          audio.play(0);
        } else {
          // The tail is the last frame the clock stands on; the store's pause
          // is what the loop hears to take itself down.
          state.setPlayheadFromClock(end);
          state.pause();
          return;
        }
      } else {
        state.setPlayheadFromClock(atMs);
      }
      audio.tick(atMs);
      // The clock that just moved is what the runs are aimed by: the clips the
      // coming window will show are given their head start here, a frame ahead
      // of the moment the picture is asked for them.
      if (timeline) frames.prepareAhead(timeline, atMs);
      follow(atMs);
      raf = requestAnimationFrame(frame);
    };

    const start = (): void => {
      const state = useClipStore.getState();
      startWall = performance.now();
      startMs = state.playheadMs;
      audio.setTimeline(activeTimeline());
      audio.play(startMs);
      raf = requestAnimationFrame(frame);
    };

    const stop = (): void => {
      if (raf !== null) {
        cancelAnimationFrame(raf);
        raf = null;
      }
      audio.pause();
      frames.stopPlayback();
    };

    // The store is the one place playback state lives; everything here is a
    // reading of a change in it.
    const offClip = useClipStore.subscribe((state, previous) => {
      if (state.playing !== previous.playing) {
        if (state.playing) start();
        else stop();
        return;
      }
      if (!state.playing && state.playheadMs !== previous.playheadMs) {
        // A hand at the playhead while the clock is stopped: the audible set
        // is carried to the new moment, so a later play starts in the right
        // places rather than where the last one ended.
        audio.seek(state.playheadMs);
      }
      if (state.masterVolume !== previous.masterVolume) {
        audio.setMasterVolume(state.masterVolume);
      }
    });

    // A document change is the same entry a playing edit uses: the engine is
    // handed the new cut and rebuilds if anything is sounding.
    const offProject = useProjectStore.subscribe((state, previous) => {
      if (state.moka === previous.moka) return;
      audio.setTimeline(activeTimeline());
    });

    // The cut the room has taken up has its sound asked for before anything
    // waits on it: a voice reads a small copy of a film's sound, and making
    // that copy is a read of the whole picture file.
    const warmCut = (): void => {
      const timeline = activeTimeline();
      if (timeline) audio.warm(timeline);
    };
    warmCut();
    const offTimeline = useClipStore.subscribe((state, previous) => {
      if (state.activeTimelineId !== previous.activeTimelineId) warmCut();
    });

    return () => {
      offClip();
      offProject();
      offTimeline();
      stop();
    };
  }, []);
}
