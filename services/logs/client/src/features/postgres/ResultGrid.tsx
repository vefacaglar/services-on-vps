import { useMemo, useRef, useState, type PointerEvent } from "react";
import { usePreferences } from "../../app/Preferences";
import { display } from "../../lib/api";
import { cellCopy, rowCopy, sortRows, type QueryResult } from "./pg";
import styles from "./Workspace.module.css";

type Sort = { column: string; descending: boolean } | null;
type Cell = { row: number; column: string } | null;

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Result grid: row numbers, sticky header, resizable and sortable columns,
 * distinct NULLs, copy cell/row. Sorting is client-side over loaded rows. */
export function ResultGrid({ result }: { result: QueryResult }) {
  const { t } = usePreferences();
  const columns = useMemo(
    () => result.columns.map((c) => c.name),
    [result.columns],
  );
  const types = useMemo(
    () => Object.fromEntries(result.columns.map((c) => [c.name, c.type])),
    [result.columns],
  );
  const [sort, setSort] = useState<Sort>(null);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<Cell>(null);
  const [copied, setCopied] = useState("");
  const drag = useRef<{ column: string; x: number; width: number } | null>(
    null,
  );
  const rows = useMemo(
    () =>
      sort ? sortRows(result.rows, sort.column, sort.descending) : result.rows,
    [result.rows, sort],
  );
  function toggleSort(column: string) {
    setSort((current) =>
      current?.column !== column
        ? { column, descending: false }
        : current.descending
          ? null
          : { column, descending: true },
    );
  }
  function startResize(event: PointerEvent<HTMLSpanElement>, column: string) {
    event.preventDefault();
    event.stopPropagation();
    const th = event.currentTarget.parentElement as HTMLElement;
    drag.current = { column, x: event.clientX, width: th.offsetWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function resize(event: PointerEvent<HTMLSpanElement>) {
    const d = drag.current;
    if (!d) return;
    const width = Math.max(60, Math.min(900, d.width + event.clientX - d.x));
    setWidths((w) => ({ ...w, [d.column]: width }));
  }
  async function copySelected(what: "cell" | "row") {
    if (!selected) return;
    const row = rows[selected.row];
    const ok = await copy(
      what === "cell" ? cellCopy(row[selected.column]) : rowCopy(row, columns),
    );
    setCopied(ok ? t(what === "cell" ? "pgCopiedCell" : "pgCopiedRow") : "");
  }
  return (
    <div className={styles.grid}>
      <div className={styles.gridTools}>
        <button
          className="text-button"
          disabled={!selected}
          onClick={() => void copySelected("cell")}
        >
          {t("pgCopyCell")}
        </button>
        <button
          className="text-button"
          disabled={!selected}
          onClick={() => void copySelected("row")}
        >
          {t("pgCopyRow")}
        </button>
        <span role="status" className={styles.copied}>
          {copied}
        </span>
        {sort && (
          <button className="text-button" onClick={() => setSort(null)}>
            {t("pgClearSort")}
          </button>
        )}
      </div>
      <div className={styles.gridScroll}>
        <table className={styles.gridTable}>
          <thead>
            <tr>
              <th className={styles.rowNumber} scope="col">
                #
              </th>
              {columns.map((name) => (
                <th
                  key={name}
                  scope="col"
                  style={widths[name] ? { width: widths[name] } : undefined}
                  aria-sort={
                    sort?.column === name
                      ? sort.descending
                        ? "descending"
                        : "ascending"
                      : undefined
                  }
                >
                  <button
                    className={styles.sortButton}
                    title={types[name]}
                    onClick={() => toggleSort(name)}
                  >
                    {name}
                    <span className={styles.sortMark}>
                      {sort?.column === name
                        ? sort.descending
                          ? " ↓"
                          : " ↑"
                        : ""}
                    </span>
                  </button>
                  <span
                    className={styles.resizer}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={t("pgResizeColumn")}
                    onPointerDown={(e) => startResize(e, name)}
                    onPointerMove={resize}
                    onPointerUp={() => (drag.current = null)}
                    onDoubleClick={() =>
                      setWidths((w) => {
                        const next = { ...w };
                        delete next[name];
                        return next;
                      })
                    }
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                <th scope="row" className={styles.rowNumber}>
                  {index + 1}
                </th>
                {columns.map((name) => {
                  const value = row[name];
                  const active =
                    selected?.row === index && selected.column === name;
                  return (
                    <td
                      key={name}
                      tabIndex={0}
                      className={active ? styles.activeCell : undefined}
                      onClick={() => setSelected({ row: index, column: name })}
                      onFocus={() => setSelected({ row: index, column: name })}
                      onKeyDown={(e) => {
                        if ((e.metaKey || e.ctrlKey) && e.key === "c") {
                          e.preventDefault();
                          void copySelected(e.shiftKey ? "row" : "cell");
                        }
                      }}
                    >
                      {value === null || value === undefined ? (
                        <span className={styles.null}>NULL</span>
                      ) : (
                        display(value)
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
