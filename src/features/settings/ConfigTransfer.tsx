import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  isApiError,
  modelsApi,
  type SettingsImportMode,
  type SettingsPreview,
  type SettingsSource,
} from "../../api";
import {
  CAPABILITY_LABELS,
  MODEL_CAPABILITIES,
  type Capability,
} from "../../shared/domain";
import { useAppStore } from "../editor/stores/appStore";
import { pickFile } from "../editor/launcher/pickPath";
import { askSavePath } from "../editor/launcher/savePath";
import { useModelStore } from "./modelStore";

/** Matches the server's export policy. */
const MIN_PASSPHRASE_CHARS = 12;
/** The server refuses anything larger; refusing here saves the upload. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Configuration backup: every model configuration, the capability defaults,
 * and the generation preferences, out to a file and back in.
 *
 * Credentials travel only when asked for and only sealed under a passphrase;
 * the export is written by the server where a save dialog said, the import is
 * validated into a preview before anything is written, and a changed file is
 * refused rather than applied under an old description.
 */
export function ConfigTransfer() {
  const { t } = useTranslation();
  const view = useModelStore((state) => state.view);
  const saving = useModelStore((state) => state.saving);
  const runtime = useAppStore(
    (state) => state.config?.capabilities.mode ?? "web",
  );
  const nativePickers = runtime === "tauri";
  const storedKeys =
    view?.models.filter((model) => model.apiKey.set).length ?? 0;
  const canCarryKeys = storedKeys > 0;

  const [exportOpen, setExportOpen] = useState(false);
  const [includeKeys, setIncludeKeys] = useState(true);
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const [source, setSource] = useState<SettingsSource | null>(null);
  const [preview, setPreview] = useState<SettingsPreview | null>(null);
  const [mode, setMode] = useState<SettingsImportMode>("merge");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importKeys, setImportKeys] = useState(true);
  const [importPassphrase, setImportPassphrase] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const wantsKeys = canCarryKeys && includeKeys;
  const busy = exportBusy || previewBusy || applyBusy || saving;

  const resetImport = () => {
    setSource(null);
    setPreview(null);
    setMode("merge");
    setPreviewBusy(false);
    setApplyBusy(false);
    setImportError(null);
    setImportKeys(true);
    setImportPassphrase("");
    if (fileInput.current) fileInput.current.value = "";
  };

  const loadPreview = async (
    nextSource: SettingsSource,
    nextMode: SettingsImportMode,
    fresh: boolean,
  ) => {
    setSource(nextSource);
    setPreview(null);
    setPreviewBusy(true);
    setImportError(null);
    try {
      const found = await modelsApi.previewSettingsImport({
        ...nextSource,
        mode: nextMode,
      });
      setPreview(found);
      if (fresh) {
        setImportKeys(found.secrets > 0);
        setImportPassphrase("");
      }
    } catch (error) {
      setImportError(messageOf(error));
    } finally {
      setPreviewBusy(false);
    }
  };

  const chooseMode = (next: SettingsImportMode) => {
    setMode(next);
    if (source !== null) void loadPreview(source, next, false);
  };

  const chooseFile = async () => {
    setImportError(null);
    if (!nativePickers) {
      fileInput.current?.click();
      return;
    }
    try {
      const picked = await pickFile(t("settings:transfer.fileTitle"), ["json"]);
      if (picked !== null) await loadPreview({ path: picked }, mode, true);
    } catch (error) {
      setImportError(messageOf(error));
    }
  };

  const readFile = async (file: File | null) => {
    if (file === null) return;
    if (file.size > MAX_FILE_BYTES) {
      setImportError(
        t("settings:transfer.fileTooLarge", {
          limit: MAX_FILE_BYTES / (1024 * 1024),
        }),
      );
      return;
    }
    try {
      const text = await file.text();
      await loadPreview({ text }, mode, true);
    } catch (error) {
      setImportError(messageOf(error));
    }
  };

  const runExport = async () => {
    setExportError(null);
    if (wantsKeys) {
      if ([...passphrase].length < MIN_PASSPHRASE_CHARS) {
        setExportError(
          t("settings:transfer.passphraseShort", {
            min: MIN_PASSPHRASE_CHARS,
          }),
        );
        return;
      }
      if (passphrase !== confirmation) {
        setExportError(t("settings:transfer.passphraseMismatch"));
        return;
      }
    }
    let destination: string | null = null;
    try {
      destination = await askSavePath({
        title: t("settings:transfer.saveTitle"),
        defaultName: "moka-settings.json",
        extensions: ["json"],
      });
    } catch (error) {
      setExportError(messageOf(error));
      return;
    }
    if (destination === null) return;

    setExportBusy(true);
    try {
      const report = await modelsApi.exportSettings({
        destination,
        includeKeys: wantsKeys,
        passphrase: wantsKeys ? passphrase : undefined,
      });
      useAppStore.getState().pushToast(
        "success",
        t("settings:transfer.exported", {
          count: report.models,
          destination: report.destination,
        }),
        undefined,
        report.keys > 0
          ? t("settings:transfer.exportedKeys", { count: report.keys })
          : undefined,
      );
      setExportOpen(false);
      setPassphrase("");
      setConfirmation("");
    } catch (error) {
      setExportError(messageOf(error));
    } finally {
      setExportBusy(false);
    }
  };

  const runImport = async () => {
    if (preview === null || source === null) return;
    setImportError(null);
    const carriesKeys = preview.secrets > 0 && importKeys;
    if (carriesKeys && importPassphrase === "") {
      setImportError(t("settings:transfer.passphraseRequired"));
      return;
    }
    if (mode === "replace") {
      const agreed = window.confirm(
        t("settings:transfer.replaceConfirm", {
          count: preview.localOnly.length,
        }),
      );
      if (!agreed) return;
    }

    setApplyBusy(true);
    try {
      const result = await useModelStore.getState().importSettings({
        ...source,
        mode,
        includeKeys: carriesKeys,
        passphrase: carriesKeys ? importPassphrase : undefined,
        expectedDigest: preview.digest,
        expectedRevision: preview.revision,
      });
      const { report } = result;
      const total = report.added + report.replaced;
      useAppStore.getState().pushToast(
        "success",
        mode === "replace"
          ? t("settings:transfer.importedReplace", {
              count: total,
              added: report.added,
              replaced: report.replaced,
              removed: report.removed,
            })
          : t("settings:transfer.importedMerge", {
              count: total,
              added: report.added,
              replaced: report.replaced,
            }),
        undefined,
        report.keysStored > 0
          ? t("settings:transfer.importedKeys", {
              count: report.keysStored,
            })
          : undefined,
      );
      if (report.keyFailure !== null) {
        useAppStore
          .getState()
          .pushToast(
            "error",
            t("settings:transfer.keysFailed"),
            undefined,
            report.keyFailure,
          );
      }
      resetImport();
    } catch (error) {
      setImportError(messageOf(error));
      if (isApiError(error, "SETTINGS_FILE_CHANGED") && source !== null) {
        await loadPreview(source, mode, false);
        setImportError(t("settings:transfer.changed"));
      }
    } finally {
      setApplyBusy(false);
    }
  };

  return (
    <section
      aria-label={t("settings:transfer.title")}
      className="settings-section"
      data-testid="config-transfer"
    >
      <h3 className="settings-heading">{t("settings:transfer.title")}</h3>
      <p className="settings-hint">{t("settings:transfer.hint")}</p>

      <div className="settings-row">
        <button
          data-testid="settings-export"
          disabled={busy}
          onClick={() => {
            setExportOpen((open) => !open);
            setExportError(null);
          }}
          type="button"
        >
          {t("settings:transfer.export")}
        </button>
        <button
          data-testid="settings-import"
          disabled={busy}
          onClick={() => void chooseFile()}
          type="button"
        >
          {t("settings:transfer.import")}
        </button>
        <input
          accept=".json,application/json"
          data-testid="settings-import-file"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0] ?? null;
            void readFile(file);
          }}
          ref={fileInput}
          type="file"
        />
      </div>
      {!canCarryKeys && (
        <p className="settings-hint">{t("settings:transfer.noKeys")}</p>
      )}

      {exportOpen && (
        <div className="settings-section" data-testid="settings-export-form">
          {canCarryKeys && (
            <label className="settings-check">
              <input
                checked={includeKeys}
                disabled={exportBusy}
                onChange={(event) => {
                  setIncludeKeys(event.target.checked);
                  setExportError(null);
                }}
                type="checkbox"
              />
              <span>{t("settings:transfer.includeKeys")}</span>
            </label>
          )}
          {wantsKeys && (
            <>
              <label className="dialog-field">
                <span>{t("settings:transfer.passphrase")}</span>
                <input
                  autoComplete="new-password"
                  data-testid="settings-export-passphrase"
                  disabled={exportBusy}
                  onChange={(event) => setPassphrase(event.target.value)}
                  type="password"
                  value={passphrase}
                />
              </label>
              <label className="dialog-field">
                <span>{t("settings:transfer.passphraseConfirm")}</span>
                <input
                  autoComplete="new-password"
                  data-testid="settings-export-confirm"
                  disabled={exportBusy}
                  onChange={(event) => setConfirmation(event.target.value)}
                  type="password"
                  value={confirmation}
                />
              </label>
              <p className="settings-hint">
                {t("settings:transfer.passphraseHint", {
                  min: MIN_PASSPHRASE_CHARS,
                })}
              </p>
            </>
          )}
          {exportError !== null && (
            <p className="dialog-error" role="alert">
              {exportError}
            </p>
          )}
          <div className="dialog-actions">
            <button
              disabled={exportBusy}
              onClick={() => {
                setExportOpen(false);
                setExportError(null);
              }}
              type="button"
            >
              {t("settings:transfer.cancel")}
            </button>
            <button
              className="primary"
              data-testid="settings-export-run"
              disabled={exportBusy}
              onClick={() => void runExport()}
              type="button"
            >
              {exportBusy
                ? t("settings:transfer.exporting")
                : t("settings:transfer.export")}
            </button>
          </div>
        </div>
      )}

      {previewBusy && (
        <p className="settings-hint" data-testid="settings-import-reading">
          {t("settings:transfer.reading")}
        </p>
      )}
      {importError !== null && (
        <p className="dialog-error" role="alert">
          {importError}
        </p>
      )}

      {preview !== null && !previewBusy && (
        <div className="settings-section" data-testid="settings-import-preview">
          <h4 className="settings-heading">
            {t("settings:transfer.previewTitle")}
          </h4>
          <p className="settings-hint">
            {t("settings:transfer.exportedAt", {
              date: preview.exportedAt.slice(0, 10),
              version: preview.appVersion,
            })}
          </p>
          <p className="settings-hint">
            {t("settings:transfer.modelsCount", { count: preview.models })}
            {categoryText(preview, t)}
          </p>
          <p className="settings-hint">
            {t("settings:transfer.added", { count: preview.added })}
            {" · "}
            {t("settings:transfer.conflicts", {
              count: preview.conflicts.length,
            })}
            {" · "}
            {t("settings:transfer.localOnly", {
              count: preview.localOnly.length,
            })}
          </p>
          {preview.conflicts.length > 0 && (
            <details className="settings-hint">
              <summary>
                {t("settings:transfer.conflictList", {
                  count: preview.conflicts.length,
                })}
              </summary>
              <ul>
                {preview.conflicts.map((model) => (
                  <li key={model.id}>
                    {model.displayName} · {model.id}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <fieldset className="settings-section">
            <legend>{t("settings:transfer.mode")}</legend>
            <label className="settings-check">
              <input
                checked={mode === "merge"}
                disabled={applyBusy}
                name="settings-import-mode"
                onChange={() => chooseMode("merge")}
                type="radio"
              />
              <span>{t("settings:transfer.merge")}</span>
            </label>
            <label className="settings-check">
              <input
                checked={mode === "replace"}
                disabled={applyBusy}
                name="settings-import-mode"
                onChange={() => chooseMode("replace")}
                type="radio"
              />
              <span>{t("settings:transfer.replace")}</span>
            </label>
          </fieldset>
          {mode === "replace" && (
            <p className="dialog-note">
              {t("settings:transfer.replaceWarning", {
                count: preview.localOnly.length,
              })}
            </p>
          )}

          {preview.secrets > 0 && (
            <div className="settings-section">
              <p className="settings-hint">
                {t("settings:transfer.secrets", { count: preview.secrets })}
              </p>
              <label className="settings-check">
                <input
                  checked={importKeys}
                  disabled={applyBusy}
                  onChange={(event) => setImportKeys(event.target.checked)}
                  type="checkbox"
                />
                <span>{t("settings:transfer.importKeys")}</span>
              </label>
              {importKeys ? (
                <label className="dialog-field">
                  <span>{t("settings:transfer.passphrase")}</span>
                  <input
                    autoComplete="off"
                    data-testid="settings-import-passphrase"
                    disabled={applyBusy}
                    onChange={(event) =>
                      setImportPassphrase(event.target.value)
                    }
                    type="password"
                    value={importPassphrase}
                  />
                </label>
              ) : (
                <p className="settings-hint">
                  {t("settings:transfer.skipKeys")}
                </p>
              )}
            </div>
          )}

          <div className="dialog-actions">
            <button
              data-testid="settings-import-cancel"
              disabled={applyBusy}
              onClick={resetImport}
              type="button"
            >
              {t("settings:transfer.cancel")}
            </button>
            <button
              className="primary"
              data-testid="settings-import-run"
              disabled={applyBusy}
              onClick={() => void runImport()}
              type="button"
            >
              {applyBusy
                ? t("settings:transfer.importing")
                : t("settings:transfer.import")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** The file's categories in the interface's own words, e.g. “Text 2, Image 1”. */
function categoryText(
  preview: SettingsPreview,
  t: (key: string, values?: Record<string, unknown>) => string,
): string {
  const entries = MODEL_CAPABILITIES.map(
    (capability: Capability) =>
      [capability, preview.byCategory[capability] ?? 0] as const,
  ).filter(([, count]) => count > 0);
  if (entries.length === 0) return "";
  const listed = entries
    .map(
      ([capability, count]) => `${t(CAPABILITY_LABELS[capability])} ${count}`,
    )
    .join(t("settings:join.list"));
  return ` · ${listed}`;
}
