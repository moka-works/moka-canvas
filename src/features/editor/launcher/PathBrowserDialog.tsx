import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  filesystemApi,
  type FilesystemEntry,
  type FilesystemListing,
} from "../../../api";

interface Props {
  /** What the dialog is called, which is what it is being asked for. */
  title: string;
  /**
   * The kinds of file worth showing beside the folders. Left out, the dialog is
   * a folder picker and lists nothing else.
   */
  extensions?: string[];
  /** The path the field already held, which is where the listing opens. */
  start?: string;
  /** What the button taking the choice says. */
  chooseLabel: string;
  /**
   * The name a file is offered under. Given, the dialog saves rather than
   * opens: the choice is the folder being looked at and that name, and a name
   * already taken asks again before anything is replaced.
   */
  saveAs?: string;
  onClose: () => void;
  onChoose: (path: string) => void;
}

/** What a row leads with, in the same vocabulary the project tree uses. */
const GLYPHS = { directory: "▤", file: "▪" } as const;

/**
 * A typed name with the dialog's own extension behind it, when it has none of
 * its own — the way an operating system's save dialog completes one.
 */
function completedName(name: string, extensions: string[] | undefined): string {
  if (name === "" || extensions === undefined || extensions.length === 0) {
    return name;
  }
  const last = name.split("/").pop() ?? name;
  return last.includes(".") ? name : `${name}.${extensions[0]}`;
}

/**
 * A file dialog drawn by the application itself.
 *
 * A desktop asks the operating system which folder is meant and gets a real
 * dialog back. A browser cannot ask, and the alternative was a text field
 * waiting for an absolute path — which is a field only somebody who already
 * knows the path can fill in. This is what stands in for the question there:
 * the folders of the machine the server runs on, walked one listing at a time.
 *
 * What it shows is names and where they lead, and nothing about what any of
 * them holds; the listing it reads is the server's own, and the server answers
 * it in the web runtime alone. A path can still be typed into the bar, since a
 * reader who does know where they mean should not have to click there.
 *
 * The choice is the file that was picked, or the folder being looked at when no
 * file was — which is what lets one dialog serve both a folder to put a new
 * project in and a project to open, since the second is either of them. Asked
 * to save (`saveAs`), it asks one more thing — the file's name — and the choice
 * is that name in the folder being looked at.
 */
export function PathBrowserDialog({
  title,
  extensions,
  start,
  chooseLabel,
  saveAs,
  onClose,
  onChoose,
}: Props) {
  const { t } = useTranslation();
  const kinds = (extensions ?? []).join(",");
  const saving = saveAs !== undefined;
  const [listing, setListing] = useState<FilesystemListing | null>(null);
  const [typed, setTypedState] = useState("");
  const [chosen, setChosen] = useState<FilesystemEntry | null>(null);
  // The name a save will be under, typed or taken from a file that was
  // clicked; the field only exists in the mode that has one.
  const [name, setName] = useState(() => saveAs ?? "");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Where the listing opens is where the field stood when the dialog was asked
  // for, read once: a path typed into the dialog's own bar must not send the
  // listing somewhere else on every keystroke.
  const [opening] = useState(() => start?.trim() ?? "");
  // The bar as it stands, beside the state it is shown from. What a listing
  // arriving late may overwrite is decided against this rather than against the
  // value one render happened to have, which is the only way to tell a bar a
  // reader has since typed into from one they have left alone.
  const bar = useRef("");
  // Which listing was asked for last, so one that took its time arriving cannot
  // answer in place of the question asked after it.
  const asked = useRef(0);

  const setTyped = useCallback((value: string) => {
    bar.current = value;
    setTypedState(value);
  }, []);

  const load = useCallback(
    async (where: string) => {
      const mine = ++asked.current;
      const barAtAsk = bar.current;
      setBusy(true);
      setError(null);
      try {
        const listed = await filesystemApi.list(
          where,
          kinds === "" ? undefined : kinds.split(","),
        );
        // Superseded by a folder asked for after this one, so whatever it says
        // is an answer to a question nobody is waiting on any more.
        if (mine !== asked.current) return;
        setListing(listed);
        setChosen(null);
        // The bar reads the directory resolved, which is not always the one
        // typed — but only while a reader has left it alone. Overwriting a path
        // being typed with the one asked for before it is a field that fights
        // back.
        if (bar.current === barAtAsk) setTyped(listed.path);
      } catch (cause) {
        if (mine !== asked.current) return;
        // Said rather than swallowed, and the last listing that worked is kept
        // on screen: a folder that would not open is a reason to go up, not a
        // reason to be looking at nothing.
        setError(
          cause instanceof Error
            ? cause.message
            : t("app:browser.couldNotList"),
        );
      } finally {
        // Left to whichever listing was asked for last, since clearing it here
        // would say a newer question had been answered when it has not.
        if (mine === asked.current) setBusy(false);
      }
    },
    [kinds, setTyped, t],
  );

  useEffect(() => {
    void load(opening);
  }, [load, opening]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const entries = listing?.entries ?? [];
  const kindWords = kinds.split(",").join(t("app:browser.joinOr"));
  const wanted = saving ? completedName(name.trim(), extensions) : "";
  // The file that was picked, or the folder being looked at when no file was: a
  // project is opened from either, and a folder to put one in is only ever the
  // second. A save means the third thing: that name, in the folder looked at.
  const choice = saving
    ? listing === null || wanted === ""
      ? ""
      : `${listing.path}/${wanted}`
    : (chosen?.path ?? listing?.path ?? "");
  const up = listing?.parent ?? null;
  const taken = chosen !== null;
  // A name the folder already holds: the button says it will be replaced, so
  // nobody replaces one without having been told.
  const collides =
    saving && wanted !== "" && entries.some((entry) => entry.name === wanted);

  /** What one row does: a folder is walked into, a file is picked — or, in the
   * mode that saves, a file's name is taken. */
  const take = (entry: FilesystemEntry) => {
    if (entry.kind === "directory") {
      void load(entry.path);
    } else if (saving) {
      setName(entry.name);
    } else {
      setChosen(entry);
    }
  };

  /** Taking the choice: what the button says is what it does. */
  const press = () => {
    if (busy || choice === "") return;
    onChoose(choice);
  };

  return (
    <div
      className="dialog-backdrop path-browser-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
      role="presentation"
    >
      <div
        aria-label={title}
        aria-modal="true"
        className="dialog path-browser"
        data-testid="path-browser"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="preview-dialog-head">
          <h2>{title}</h2>
          <button
            aria-label={t("app:browser.close")}
            onClick={onClose}
            type="button"
          >
            ✕
          </button>
        </header>

        <form
          className="path-browser-bar"
          onSubmit={(event) => {
            event.preventDefault();
            void load(typed);
          }}
        >
          <button
            aria-label={t("app:browser.up")}
            disabled={busy || up === null}
            onClick={() => up !== null && void load(up)}
            title={up === null ? t("app:browser.top") : up}
            type="button"
          >
            ↑
          </button>
          <input
            aria-label={t("app:browser.folderToList")}
            data-testid="path-browser-typed"
            onChange={(event) => setTyped(event.target.value)}
            placeholder="/Users/you/Movies"
            value={typed}
          />
          <button disabled={busy} type="submit">
            {t("app:browser.list")}
          </button>
        </form>

        {error && (
          <p
            className="dialog-error"
            data-testid="path-browser-error"
            role="alert"
          >
            {error}
          </p>
        )}

        {busy && listing === null ? (
          <p className="settings-hint" data-testid="path-browser-busy">
            {t("app:browser.reading")}
          </p>
        ) : (
          <ul
            aria-label={t("app:browser.holds")}
            className="path-browser-list"
            data-testid="path-browser-list"
          >
            {entries.map((entry) => (
              <li key={entry.path}>
                <button
                  aria-current={
                    chosen?.path === entry.path ? "true" : undefined
                  }
                  className={
                    chosen?.path === entry.path
                      ? "path-browser-row is-chosen"
                      : "path-browser-row"
                  }
                  data-testid={`path-browser-row-${entry.name}`}
                  onClick={() => take(entry)}
                  onDoubleClick={() => {
                    // A file double-clicked is a file taken, the way the
                    // operating system's own dialog answers the same gesture —
                    // or, when the dialog is saving, the name the file will be
                    // written under.
                    if (entry.kind !== "file") return;
                    if (saving) setName(entry.name);
                    else onChoose(entry.path);
                  }}
                  title={entry.path}
                  type="button"
                >
                  <span aria-hidden="true" className="path-browser-glyph">
                    {GLYPHS[entry.kind]}
                  </span>
                  <span className="path-browser-name">{entry.name}</span>
                </button>
              </li>
            ))}
            {entries.length === 0 && (
              <li className="path-browser-none" data-testid="path-browser-none">
                {kinds === ""
                  ? t("app:browser.empty")
                  : t("app:browser.emptyOfKind", { kinds: kindWords })}
              </li>
            )}
          </ul>
        )}

        {listing?.truncated && (
          <p className="settings-hint" data-testid="path-browser-truncated">
            {t("app:browser.truncated", { count: entries.length })}
          </p>
        )}

        {saving && (
          <form
            className="path-browser-name"
            onSubmit={(event) => {
              event.preventDefault();
              press();
            }}
          >
            <label>
              {t("app:browser.fileName")}
              <input
                aria-label={t("app:browser.fileName")}
                data-testid="path-browser-name"
                onChange={(event) =>
                  setName(event.target.value.replace(/[/\\]/g, ""))
                }
                value={name}
              />
            </label>
          </form>
        )}

        {collides && (
          <p
            className="settings-hint"
            data-testid="path-browser-overwrite"
            role="alert"
          >
            {t("app:browser.overwrite", { name: wanted })}
          </p>
        )}

        <footer className="path-browser-foot">
          {/* Named before it is taken: what the button says is a verb, and what
              it will act on is a path a reader should be able to check. */}
          <span
            className="path-browser-choice"
            data-testid="path-browser-choice"
            title={choice}
          >
            {saving
              ? wanted === ""
                ? t("app:browser.fileName")
                : wanted
              : taken
                ? chosen?.name
                : t("app:browser.thisFolder")}
            <em>{choice}</em>
          </span>
          <div className="dialog-actions">
            <button disabled={busy} onClick={onClose} type="button">
              {t("app:cancel")}
            </button>
            <button
              className="primary"
              data-testid="path-browser-choose"
              disabled={busy || choice === ""}
              onClick={press}
              type="button"
            >
              {collides ? t("app:browser.overwriteConfirm") : chooseLabel}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
