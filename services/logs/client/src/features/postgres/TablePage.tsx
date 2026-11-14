import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { usePreferences } from "../../app/Preferences";
import { JSONView, TableView } from "../../components/LogViews";
import { api } from "../../lib/api";
import {
  apiPath,
  dbPath,
  starterQuery,
  tablePath,
  type QueryResult,
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
          {tab === "rows" && <Rows path={path} />}
          {tab === "columns" && <Columns detail={data} />}
          {tab === "indexes" && <Indexes detail={data} />}
          {tab === "constraints" && <Constraints detail={data} />}
        </div>
      )}
    </>
  );
}

function Rows({ path }: { path: string }) {
  const { t } = usePreferences();
  const f = useFormat();
  const [offset, setOffset] = useState(0);
  const [view, setView] = useState<"table" | "json">("table");
  const [wrap, setWrap] = useState(false);
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
  return (
    <section className={meili.results}>
      <PgError error={result.error} />
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
          <TableView
            rows={data.rows}
            columns={data.columns.map((c) => c.name)}
            wrap={wrap}
          />
        ) : (
          <JSONView rows={data.rows} wrap={wrap} />
        ))}
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
