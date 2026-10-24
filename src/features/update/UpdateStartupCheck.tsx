import { useEffect } from "react";
import { i18n } from "../../shared/i18n";
import { useAppStore } from "../editor/stores/appStore";
import { useModelStore } from "../settings/modelStore";
import {
  lastUpdateCheck,
  markUpdateChecked,
  updateCheckDue,
  UPDATE_STARTUP_DELAY_MS,
} from "./updateCheck";
import { useUpdateStore } from "./updateStore";

/**
 * Asks for updates once a day, after the launcher has settled.
 *
 * The check is silent: nothing is downloaded and no error is shown on the
 * editor, because nobody asked for it. A version that is found says so in a
 * toast, and choosing the toast opens the row that can install it.
 */
export function UpdateStartupCheck() {
  const phase = useAppStore((state) => state.phase);
  const mode = useAppStore((state) => state.config?.capabilities.mode);

  useEffect(() => {
    if (phase !== "launcher" || mode !== "tauri") return;
    if (!updateCheckDue(Date.now(), lastUpdateCheck())) return;
    let live = true;
    const timer = globalThis.setTimeout(() => {
      void (async () => {
        const update = await useUpdateStore.getState().check();
        if (!live) return;
        markUpdateChecked(Date.now());
        if (update === null) return;
        useAppStore.getState().pushToast(
          "info",
          i18n.t("settings:update.availableToast", {
            version: update.version,
          }),
          {
            label: i18n.t("settings:update.open"),
            go: () => {
              const settings = useModelStore.getState();
              settings.openSettings();
              settings.setTopTab("system");
            },
          },
        );
      })();
    }, UPDATE_STARTUP_DELAY_MS);
    return () => {
      live = false;
      globalThis.clearTimeout(timer);
    };
  }, [phase, mode]);

  return null;
}
