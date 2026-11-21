/**
 * One take's clip prompts, rewritten before that take is filmed.
 *
 * A video's words are read afresh for every take: the same words come back as
 * much the same film, so a press asking for several takes rewrites each take
 * from the board's own words rather than handing every take the one answer.
 * What the reader is told belongs to the take being rewritten — a place whose
 * words could not be rewritten is not filmed in this take, and the reason it
 * gave is said whole.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { errorText } from "../../../api/client";
import type { StoryDocument } from "../../../shared/domain/types";
import { useAppStore } from "../../editor/stores/appStore";
import type { VideoAskWave } from "../jobs/plan";
import { rewriteVideoWaves, videoFailureDetail } from "../jobs/rewriteVideos";

/** How many of a take's places have been rewritten, of how many need it. */
export interface VideoRewriteState {
  done: number;
  total: number;
  /** Which take of the press is being rewritten, counted from one. */
  round: number;
  rounds: number;
}

export function useVideoPromptRewrite(): {
  state: VideoRewriteState | null;
  prepare: (
    story: StoryDocument,
    waves: VideoAskWave[],
    options: { round: number; rounds: number },
  ) => Promise<VideoAskWave[]>;
  cancel: () => void;
} {
  const { t } = useTranslation();
  const [state, setState] = useState<VideoRewriteState | null>(null);
  const asking = useRef<AbortController | null>(null);
  const stopped = useRef(false);

  useEffect(
    () => () => {
      asking.current?.abort();
    },
    [],
  );

  const cancel = useCallback(() => {
    if (asking.current === null) return;
    stopped.current = true;
    asking.current.abort();
  }, []);

  const prepare = useCallback(
    async (
      story: StoryDocument,
      waves: VideoAskWave[],
      options: { round: number; rounds: number },
    ): Promise<VideoAskWave[]> => {
      if (asking.current !== null) return [];
      const controller = new AbortController();
      asking.current = controller;
      stopped.current = false;
      const { round, rounds } = options;
      setState({ done: 0, total: 0, round, rounds });
      try {
        const prepared = await rewriteVideoWaves(story, waves, {
          signal: controller.signal,
          onProgress: (done, total) => setState({ done, total, round, rounds }),
        });
        if (prepared.failed.length > 0) {
          useAppStore.getState().pushToast(
            "error",
            t("story:panels.videoRewriteFailed", {
              count: prepared.failed.length,
              total: prepared.rewritten + prepared.failed.length,
              round,
              rounds,
            }),
            undefined,
            videoFailureDetail(prepared.failed),
          );
        } else if (prepared.rewritten === 0 && prepared.untouched > 0) {
          useAppStore
            .getState()
            .pushToast(
              "info",
              t("story:panels.videoRewriteNothing", { round, rounds }),
            );
        }
        return prepared.waves;
      } catch (problem) {
        if (stopped.current) {
          useAppStore
            .getState()
            .pushToast("info", t("story:panels.videoRewriteStopped"));
          return [];
        }
        if (controller.signal.aborted) return [];
        const said = errorText(problem);
        useAppStore.getState().pushToast(
          "error",
          t("story:panels.videoRewriteBroken", {
            reason: said.message,
            round,
            rounds,
          }),
          undefined,
          said.detail,
        );
        return [];
      } finally {
        asking.current = null;
        stopped.current = false;
        setState(null);
      }
    },
    [t],
  );

  return { state, prepare, cancel };
}
