import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { usePreferences } from "../../app/Preferences";
import { Dialog } from "../../components/Dialog";
import { JSONView, TableView } from "../../components/LogViews";
import { api, display } from "../../lib/api";
import {
  apiPath,
  dbPath,
  describeKey,
  editText,
  insertValues,
  isTruncated,
  rowKey,
  starterQuery,
  tablePath,
  type QueryResult,
  type Row,
  type RowChange,
  type RowWriteResult,
  type TableDetail,
} from "./pg";
import {
  PgError,
  PgHeading,
  RefreshButton,
  useFormat,
  useNames,
  usePg,
} from "./shared";
import { useWriteMode, WriteToggle } from "./Write";
import meili from "../meilisearch/Meilisearch.module.css";
import styles from "./Postgres.module.css";

const tabs = ["rows", "columns", "indexes", "constraints"] as const;
type Tab = (typeof tabs)[number];
const tabLabels = {
  rows: "tabRows",
  columns: "tabColumns",
  indexes: "tabIndexes",
  constraints: "tabConstraints",
} as const;
const PAGE = 50;

export default function TablePage() {
  const { t } = usePreferences();
  const f = useFormat();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const {
    ok,
    values: [db, schema, table],
  } = useNames("db", "schema", "table");
  const path = tablePath(db, schema, table);
  const detail = usePg<TableDetail>(path, ok);
  if (!ok) return <Navigate replace to="/postgres" />;
  const tab: Tab = tabs.find((x) => x === params.get("tab")) || "rows";
  const data = detail.data;
  return (
    <>
      <PgHeading
        db={db}
        title={table}
        eyebrow={
          data
            ? `${db} · ${schema} · ${f.bytes(data.info.totalSize)} · ${t("pgOwner")} ${data.info.owner}`
            : `${db} · ${schema}`
        }
      >
        <button
          className="ghost"
          onClick={() =>
            navigate(dbPath(db, "/query"), {
              state: { sql: starterQuery(schema, table) },
            })
          }
        >
          {t("pgQueryTable")}
        </button>
        <RefreshButton
          busy={detail.isFetching}
          onClick={() => void detail.refetch()}
        />
      </PgHeading>
      <p className={meili.meta}>
        <Link to={dbPath(db)} className={meili.back}>
          ← {db}
        </Link>
      </p>
      <PgError error={detail.error} />
      {detail.isPending && <p className={meili.meta}>{t("loading")}</p>}
      {data && (
        <div className={meili.page}>
          {data.info.comment && (
            <p className={meili.note} role="note">
              {data.info.comment}
            </p>
          )}
          <div role="tablist" aria-label={table} className={meili.tabs}>
            {tabs.map((item) => (
              <button
                key={item}
                role="tab"
                aria-selected={tab === item}
                onClick={() => {
                  const next = new URLSearchParams(params);
                  next.set("tab", item);
                  setParams(next, { replace: true });
                }}
              >
                {t(tabLabels[item])}
                {item === "columns" && ` ${data.columns.length}`}
                {item === "indexes" && ` ${data.indexes.length}`}
              </button>
            ))}
          </div>
          {tab === "rows" && <Rows path={path} detail={data} />}
          {tab === "columns" && <Columns detail={data} />}
          {tab === "indexes" && <Indexes detail={data} />}
          {tab === "constraints" && <Constraints detail={data} />}
        </div>
      )}
    </>
  );
}

function Rows({ path, detail }: { path: string; detail: TableDetail }) {
  const { t } = usePreferences();
  const f = useFormat();
  const writeMode = useWriteMode();
  const [offset, setOffset] = useState(0);
  const [view, setView] = useState<"table" | "json">("table");
  const [wrap, setWrap] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saved, setSaved] = useState(false);
  const result = useQuery({
    queryKey: ["pg", path, "rows", offset],
    queryFn: ({ signal }) =>
      api<QueryResult>(
        `${apiPath(path)}/rows?limit=${PAGE}&offset=${offset}`,
        undefined,
        signal,
      ),
    retry: false,
    placeholderData: keepPreviousData,
  });
  const data = result.data;
  const isTable = detail.kind === "r" || detail.kind === "p";
  const pk = data?.orderBy || [];
  const editable = writeMode && isTable && pk.length > 0;
  const types = Object.fromEntries(detail.columns.map((c) => [c.name, c.type]));
  function open(state: EditorState) {
    setSaved(false);
    setEditor(state);
  }
  return (
    <section className={meili.results}>
      <PgError error={result.error} />
      {isTable && <WriteToggle />}
      {writeMode && isTable && data && !pk.length && (
        <p className={meili.note} role="note">
          {t("pgNoPrimaryKey")}
        </p>
      )}
      {editable && (
        <div className={styles.editBar}>
          <p className={meili.meta}>{t("pgEditHint")}</p>
          <button
            className="ghost"
            onClick={() =>
              open({
                step: "edit",
                change: {
                  op: "insert",
                  fields: Object.fromEntries(
                    detail.columns.map((c) => [
                      c.name,
                      { text: "", isNull: false },
                    ]),
                  ),
                },
              })
            }
          >
            + {t("pgAddRow")}
          </button>
        </div>
      )}
      {saved && (
        <p className={meili.meta} role="status">
          {t("pgRowSaved")}
        </p>
      )}
      <div className={meili.resultHeader}>
        <div role="tablist" aria-label={t("rows")} className={meili.tabs}>
          {(["table", "json"] as const).map((item) => (
            <button
              key={item}
              role="tab"
              aria-selected={view === item}
              onClick={() => setView(item)}
            >
              {t(item)}
            </button>
          ))}
        </div>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={wrap}
            onChange={(e) => setWrap(e.target.checked)}
          />
          {t("wrapLines")}
        </label>
      </div>
      <p className={meili.meta} role="status">
        {result.isFetching
          ? t("loading")
          : data && data.rows.length
            ? `${f.number(offset + 1)}–${f.number(offset + data.rows.length)} · ${
                data.orderBy?.length
                  ? t("pgOrderedBy", { columns: data.orderBy.join(", ") })
                  : t("pgUnordered")
              }`
            : ""}
      </p>
      {data && data.rows.length === 0 && (
        <div className="empty">
          <p>{t("pgNoRows")}</p>
        </div>
      )}
      {data &&
        data.rows.length > 0 &&
        (view === "table" ? (
          editable ? (
            <EditableTable
              rows={data.rows}
              columns={data.columns.map((c) => c.name)}
              pk={pk}
              types={types}
              wrap={wrap}
              onEdit={open}
            />
          ) : (
            <TableView
              rows={data.rows}
              columns={data.columns.map((c) => c.name)}
              wrap={wrap}
            />
          )
        ) : (
          <JSONView rows={data.rows} wrap={wrap} />
        ))}
      {editor && editable && (
        <RowEditor
          path={path}
          state={editor}
          types={types}
          onChange={setEditor}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            setSaved(true);
          }}
        />
      )}
      {data && (
        <div className={meili.pager}>
          <button
            className="ghost"
            disabled={offset === 0 || result.isFetching}
            onClick={() => setOffset(Math.max(0, offset - PAGE))}
          >
            ← {t("previous")}
          </button>
          <button
            className="ghost"
            disabled={data.rows.length < PAGE || result.isFetching}
            onClick={() => setOffset(offset + PAGE)}
          >
            {t("next")} →
          </button>
        </div>
      )}
    </section>
  );
}

function Columns({ detail }: { detail: TableDetail }) {
  const { t } = usePreferences();
  return (
    <section className={meili.card}>
      <div className={meili.scroll}>
        <table>
          <thead>
            <tr>
              <th scope="col">{t("field")}</th>
              <th scope="col">{t("pgType")}</th>
              <th scope="col">{t("pgNullable")}</th>
              <th scope="col" className={meili.optional}>
                {t("pgDefault")}
              </th>
            </tr>
          </thead>
          <tbody>
            {detail.columns.map((c) => (
              <tr key={c.name}>
                <th scope="row">
                  <code className={meili.name}>{c.name}</code>
                  {c.comment && <span className={meili.kind}>{c.comment}</span>}
                </th>
                <td>
                  <code>{c.type}</code>
                </td>
                <td className={meili.secondary}>
                  {t(c.nullable ? "pgYes" : "pgNo")}
                </td>
                <td className={`${meili.wrapCell} ${meili.optional}`}>
                  {c.default ? <code>{c.default}</code> : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Indexes({ detail }: { detail: TableDetail }) {
  const { t } = usePreferences();
  const f = useFormat();
  return (
    <section className={meili.card}>
      {detail.indexes.length ? (
        <ul className={styles.definitions}>
          {detail.indexes.map((i) => (
            <li key={i.name}>
              <div className={styles.definitionHead}>
                <code className={meili.name}>{i.name}</code>
                {i.primary && (
                  <span className={styles.tag}>{t("pgPrimary")}</span>
                )}
                {i.unique && !i.primary && (
                  <span className={styles.tag}>{t("pgUnique")}</span>
                )}
                {i.unused && (
                  <span className={`${styles.tag} ${styles.warn}`}>
                    {t("pgUnused")}
                  </span>
                )}
                <span className={meili.secondary}>
                  {f.bytes(i.size)} ·{" "}
                  {t("pgScanCount", { count: f.number(i.scans) })}
                </span>
              </div>
              <pre className={meili.code}>{i.definition}</pre>
            </li>
          ))}
        </ul>
      ) : (
        <p className={meili.meta}>{t("pgNoIndexes")}</p>
      )}
    </section>
  );
}

function Constraints({ detail }: { detail: TableDetail }) {
  const { t } = usePreferences();
  return (
    <>
      <section className={meili.card}>
        {detail.constraints.length ? (
          <ul className={styles.definitions}>
            {detail.constraints.map((c) => (
              <li key={c.name}>
                <div className={styles.definitionHead}>
                  <code className={meili.name}>{c.name}</code>
                  <span className={styles.tag}>{c.type}</span>
                </div>
                <pre className={meili.code}>{c.definition}</pre>
              </li>
            ))}
          </ul>
        ) : (
          <p className={meili.meta}>{t("pgNoConstraints")}</p>
        )}
      </section>
      <section className={meili.card}>
        <div className={meili.heading}>
          <h2>{t("pgTriggers")}</h2>
          <span>{detail.triggers.length}</span>
        </div>
        {detail.triggers.length ? (
          <ul className={styles.definitions}>
            {detail.triggers.map((tr) => (
              <li key={tr.name}>
                <div className={styles.definitionHead}>
                  <code className={meili.name}>{tr.name}</code>
                  <span className={styles.tag}>
                    {t(tr.enabled ? "pgEnabled" : "pgDisabled")}
                  </span>
                </div>
                <pre className={meili.code}>{tr.definition}</pre>
              </li>
            ))}
          </ul>
        ) : (
          <p className={meili.meta}>{t("pgNoTriggers")}</p>
        )}
      </section>
    </>
  );
}

type Field = { text: string; isNull: boolean };
type EditorState = {
  step: "edit" | "confirm";
  change:
    | {
        op: "update";
        key: Record<string, unknown>;
        column: string;
        current: unknown;
        field: Field;
      }
    | { op: "insert"; fields: Record<string, Field> }
    | { op: "delete"; key: Record<string, unknown>; row: Row };
};

function EditableTable({
  rows,
  columns,
  pk,
  types,
  wrap,
  onEdit,
}: {
  rows: Row[];
  columns: string[];
  pk: string[];
  types: Record<string, string>;
  wrap: boolean;
  onEdit: (state: EditorState) => void;
}) {
  const { t } = usePreferences();
  return (
    <div className={meili.scroll}>
      <table className={`${styles.editTable} ${wrap ? styles.wrap : ""}`}>
        <thead>
          <tr>
            <th scope="col">{t("pgActions")}</th>
            {columns.map((name) => (
              <th scope="col" key={name}>
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const key = rowKey(row, pk);
            return (
              <tr key={key ? JSON.stringify(key) : index}>
                <td>
                  <button
                    className={`text-button ${styles.deleteRow}`}
                    disabled={!key}
                    onClick={() =>
                      key &&
                      onEdit({
                        step: "confirm",
                        change: { op: "delete", key, row },
                      })
                    }
                  >
                    {t("pgDeleteRow")}
                  </button>
                </td>
                {columns.map((name) => {
                  const value = row[name];
                  const blocked = !key || isTruncated(value);
                  return (
                    <td key={name}>
                      <button
                        className={styles.cellButton}
                        disabled={blocked}
                        title={
                          isTruncated(value) ? t("pgCellTruncated") : undefined
                        }
                        onClick={() =>
                          key &&
                          onEdit({
                            step: "edit",
                            change: {
                              op: "update",
                              key,
                              column: name,
                              current: value,
                              field: {
                                text: editText(value, types[name] || ""),
                                isNull: value === null,
                              },
                            },
                          })
                        }
                      >
                        {value === null ? (
                          <span className={styles.nullValue}>
                            {t("pgNullValue")}
                          </span>
                        ) : (
                          display(value)
                        )}
                      </button>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FieldInput({
  name,
  type,
  field,
  onChange,
}: {
  name: string;
  type: string;
  field: Field;
  onChange: (field: Field) => void;
}) {
  const { t } = usePreferences();
  return (
    <div className={styles.field}>
      <div className={styles.fieldHead}>
        <code className={meili.name}>{name}</code>
        <span className={meili.secondary}>{type}</span>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={field.isNull}
            onChange={(e) => onChange({ ...field, isNull: e.target.checked })}
          />
          {t("pgSetNull")}
        </label>
      </div>
      <textarea
        aria-label={name}
        rows={Math.min(8, Math.max(1, field.text.split("\n").length))}
        value={field.text}
        disabled={field.isNull}
        spellCheck={false}
        onChange={(e) => onChange({ ...field, text: e.target.value })}
      />
    </div>
  );
}

function shown(field: Field) {
  return field.isNull ? "NULL" : field.text;
}

function RowEditor({
  path,
  state,
  types,
  onChange,
  onClose,
  onSaved,
}: {
  path: string;
  state: EditorState;
  types: Record<string, string>;
  onChange: (state: EditorState) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = usePreferences();
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (change: RowChange) =>
      api<RowWriteResult>(`${apiPath(path)}/write`, {
        ...change,
        confirm: true,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["pg"] });
      onSaved();
    },
  });
  const { change, step } = state;
  const request = (): RowChange =>
    change.op === "update"
      ? {
          op: "update",
          key: change.key,
          values: {
            [change.column]: change.field.isNull ? null : change.field.text,
          },
        }
      : change.op === "insert"
        ? { op: "insert", values: insertValues(change.fields) }
        : { op: "delete", key: change.key };
  const title =
    change.op === "update"
      ? t("pgConfirmUpdate")
      : change.op === "insert"
        ? t("pgConfirmInsert")
        : t("pgConfirmDelete");
  const close = () => {
    if (!save.isPending) onClose();
  };
  return (
    <Dialog title={title} onClose={close}>
      {"key" in change && (
        <code className={styles.rowIdentity}>
          {t("pgRowIdentity", { key: describeKey(change.key) })}
        </code>
      )}
      {step === "edit" && change.op === "update" && (
        <FieldInput
          name={change.column}
          type={types[change.column] || ""}
          field={change.field}
          onChange={(field) =>
            onChange({ ...state, change: { ...change, field } })
          }
        />
      )}
      {step === "edit" && change.op === "insert" && (
        <>
          <p>{t("pgUseDefault")}</p>
          {Object.entries(change.fields).map(([name, field]) => (
            <FieldInput
              key={name}
              name={name}
              type={types[name] || ""}
              field={field}
              onChange={(next) =>
                onChange({
                  ...state,
                  change: {
                    ...change,
                    fields: { ...change.fields, [name]: next },
                  },
                })
              }
            />
          ))}
        </>
      )}
      {step === "confirm" && change.op === "update" && (
        <dl className={styles.diff}>
          <dt>{change.column}</dt>
          <dd>
            <span className={meili.secondary}>{t("pgCurrentValue")}</span>
            <pre>{change.current === null ? "NULL" : display(change.current)}</pre>
          </dd>
          <dd>
            <span className={meili.secondary}>{t("pgNewValue")}</span>
            <pre>{shown(change.field)}</pre>
          </dd>
        </dl>
      )}
      {step === "confirm" && change.op === "insert" && (
        <dl className={styles.diff}>
          {Object.entries(insertValues(change.fields)).map(([name, value]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>
                <pre>{value === null ? "NULL" : value}</pre>
              </dd>
            </div>
          ))}
        </dl>
      )}
      {step === "confirm" && change.op === "delete" && (
        <pre className={meili.code}>{JSON.stringify(change.row, null, 2)}</pre>
      )}
      <PgError error={save.error} />
      <div className={styles.dialogActions}>
        {step === "confirm" && change.op !== "delete" ? (
          <button
            className="ghost"
            disabled={save.isPending}
            onClick={() => {
              save.reset();
              onChange({ ...state, step: "edit" });
            }}
          >
            ← {t("pgBack2")}
          </button>
        ) : (
          <button className="ghost" disabled={save.isPending} onClick={close}>
            {t("pgCancel")}
          </button>
        )}
        {step === "edit" ? (
          <button
            className="primary"
            onClick={() => onChange({ ...state, step: "confirm" })}
          >
            {t("pgReview")} →
          </button>
        ) : (
          <button
            className={styles.danger}
            disabled={save.isPending}
            onClick={() => save.mutate(request())}
          >
            {change.op === "delete" ? t("pgDeleteRow") : t("pgCommit")}
          </button>
        )}
      </div>
    </Dialog>
  );
}
