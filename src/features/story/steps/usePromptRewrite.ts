/**
 * A step's bulk drawings, with their prompts rewritten first.
 *
 * A press that asks for several pictures spends a provider's time, and the
 * rewrite spends a text model's first; the step says how far that is without
 * pretending the pictures have started. What the reader is told comes from the
 * rewrite itself: a place whose words were not rewritten is not drawn, and the
 * reason it gave is said whole rather than as a count.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { errorText } from "../../../api/client";
import type { StoryDocument } from "../../../shared/domain/types";
import { useAppStore } from "../../editor/stores/appStore";
import {
  rewriteImageWaves,
  type ImageWave,
  type RewriteFailure,
} from "../jobs/rewriteImages";

/** How many of a press's places have been rewritten, of how many need it. */
export interface PromptRewriteState {
  done: number;
  total: number;
}

/** The reason a place gave, in the words the toast keeps under its line. */
function failureDetail(failures: RewriteFailure[]): string {
  return failures
    .map((failure) =>
      failure.detail === undefined
        ? `${failure.label}: ${failure.message}`
        : `${failure.label}: ${failure.message}\n${failure.detail}`,
    )
    .join("\n");
}

export function usePromptRewrite(): {
  state: PromptRewriteState | null;
  prepare: (
    story: StoryDocument,
    kind: "elementArt" | "keyframeArt",
    waves: ImageWave[],
  ) => Promise<ImageWave[]>;
  cancel: () => void;
} {
  const { t } = useTranslation();
  const [state, setState] = useState<PromptRewriteState | null>(null);
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
      kind: "elementArt" | "keyframeArt",
      waves: ImageWave[],
    ): Promise<ImageWave[]> => {
      if (asking.current !== null) return [];
      const controller = new AbortController();
      asking.current = controller;
      stopped.current = false;
      setState({ done: 0, total: 0 });
      try {
        const prepared = await rewriteImageWaves(story, kind, waves, {
          signal: controller.signal,
          onProgress: (done, total) => setState({ done, total }),
        });
        if (prepared.failed.length > 0) {
          useAppStore.getState().pushToast(
            "error",
            t("story:panels.rewriteFailed", {
              count: prepared.failed.length,
              total: prepared.rewritten + prepared.failed.length,
            }),
            undefined,
            failureDetail(prepared.failed),
          );
        } else if (prepared.rewritten === 0 && prepared.untouched > 0) {
          useAppStore
            .getState()
            .pushToast("info", t("story:panels.rewriteNothing"));
        }
        return prepared.waves;
      } catch (problem) {
        if (stopped.current) {
          useAppStore
            .getState()
            .pushToast("info", t("story:panels.rewriteStopped"));
          return [];
        }
        if (controller.signal.aborted) return [];
        const said = errorText(problem);
        useAppStore
          .getState()
          .pushToast(
            "error",
            t("story:panels.rewriteBroken", { reason: said.message }),
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
