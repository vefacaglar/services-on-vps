import { useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { usePreferences } from "../../app/Preferences";
import type { Key } from "../../lib/i18n";
import {
  dbPath,
  sortTables,
  tablePath,
  type Database as Db,
  type SortKey,
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

const columns: { key: SortKey; label: Key; optional?: boolean }[] = [
  { key: "name", label: "pgTables" },
  { key: "estimatedRows", label: "pgRowsEst" },
  { key: "totalSize", label: "pgTotalSize" },
  { key: "deadRows", label: "pgDeadRows", optional: true },
];

export default function Database() {
  const { t } = usePreferences();
  const f = useFormat();
  const {
    ok,
    values: [db],
  } = useNames("db");
  const detail = usePg<Db>(dbPath(db), ok);
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({
    key: "totalSize",
    descending: true,
  });
  const [filter, setFilter] = useState("");
  if (!ok) return <Navigate replace to="/postgres" />;
  const data = detail.data;
  const tables = data
    ? sortTables(data.tables, sort.key, sort.descending, filter)
    : [];
  return (
    <>
      <PgHeading
        db={db}
        title={db}
        eyebrow={
          data
            ? `${t("pgDatabase")} · ${f.bytes(data.size)} · ${f.number(data.tables.length)} ${t("pgTables").toLowerCase()}`
            : t("pgDatabase")
        }
      >
        <RefreshButton
          busy={detail.isFetching}
          onClick={() => void detail.refetch()}
        />
      </PgHeading>
      <PgError error={detail.error} />
      {detail.isPending && <p className={meili.meta}>{t("loading")}</p>}
      {data && (
        <div className={meili.page}>
          <section className={meili.card}>
            <div className={meili.heading}>
              <h2>{t("pgTables")}</h2>
              <input
                className={styles.filter}
                type="search"
                value={filter}
                placeholder={t("pgFilterTables")}
                aria-label={t("pgFilterTables")}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            {tables.length ? (
              <div className={meili.scroll}>
                <table>
                  <thead>
                    <tr>
                      {columns.map((c) => (
                        <th
                          key={c.key}
                          scope="col"
                          className={c.optional ? meili.optional : undefined}
                          aria-sort={
                            sort.key === c.key
                              ? sort.descending
                                ? "descending"
                                : "ascending"
                              : undefined
                          }
                        >
                          <button
                            className={styles.sort}
                            onClick={() =>
                              setSort({
                                key: c.key,
                                descending:
                                  sort.key === c.key
                                    ? !sort.descending
                                    : c.key !== "name",
                              })
                            }
                          >
                            {t(c.label)}
                            {sort.key === c.key &&
                              (sort.descending ? " ↓" : " ↑")}
                          </button>
                        </th>
                      ))}
                      <th scope="col" className={meili.optional}>
                        {t("pgIndexSize")}
                      </th>
                      <th scope="col" className={meili.optional}>
                        {t("pgScans")}
                      </th>
                      <th scope="col" className={meili.optional}>
                        {t("pgLastVacuum")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {tables.map((table) => (
                      <tr key={`${table.schema}.${table.name}`}>
                        <th scope="row">
                          <Link
                            className={meili.name}
                            to={tablePath(db, table.schema, table.name)}
                          >
                            <span className={styles.schema}>
                              {table.schema}.
                            </span>
                            {table.name}
                          </Link>
                          {(table.kind !== "table" || !table.readable) && (
                            <span className={meili.kind}>
                              {" "}
                              {table.kind !== "table" && table.kind}
                              {!table.readable && ` · ${t("pgNoAccess")}`}
                            </span>
                          )}
                        </th>
                        <td>
                          {table.estimatedRows < 0
                            ? "—"
                            : f.number(table.estimatedRows)}
                        </td>
                        <td className={meili.strong}>
                          {f.bytes(table.totalSize)}
                        </td>
                        <td className={`${meili.secondary} ${meili.optional}`}>
                          {f.number(table.deadRows)}
                        </td>
                        <td className={`${meili.secondary} ${meili.optional}`}>
                          {f.bytes(table.indexSize)}
                        </td>
                        <td className={`${meili.secondary} ${meili.optional}`}>
                          {f.number(table.seqScans)} /{" "}
                          {f.number(table.idxScans)}
                        </td>
                        <td className={`${meili.secondary} ${meili.optional}`}>
                          {f.date(table.lastVacuum)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className={meili.meta}>{t("pgNoTables")}</p>
            )}
          </section>

          <section className={meili.card}>
            <div className={meili.heading}>
              <h2>{t("pgTopQueries")}</h2>
              <Link to={dbPath(db, "/query")}>{t("pgSqlEditor")} →</Link>
            </div>
            {data.statements?.length ? (
              <div className={meili.scroll}>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">{t("query")}</th>
                      <th scope="col">{t("pgCalls")}</th>
                      <th scope="col">{t("pgTotalTime")}</th>
                      <th scope="col" className={meili.optional}>
                        {t("pgMeanTime")}
                      </th>
                      <th scope="col" className={meili.optional}>
                        {t("rows")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.statements.map((s, i) => (
                      <tr key={i}>
                        <th scope="row" className={meili.wrapCell}>
                          <code className={styles.statement}>{s.query}</code>
                        </th>
                        <td>{f.number(s.calls)}</td>
                        <td className={meili.strong}>{f.ms(s.totalMs)} ms</td>
                        <td className={meili.optional}>{f.ms(s.meanMs)} ms</td>
                        <td className={`${meili.secondary} ${meili.optional}`}>
                          {f.number(s.rows)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className={meili.note} role="note">
                {data.statementsError || t("pgNoStatements")}
              </p>
            )}
          </section>

          <div className={styles.columns}>
            <section className={meili.card}>
              <div className={meili.heading}>
                <h2>{t("pgViews")}</h2>
                <span>{f.number(data.views.length)}</span>
              </div>
              {data.views.length ? (
                <ul className={styles.list}>
                  {data.views.map((v) => (
                    <li key={`${v.schema}.${v.name}`}>
                      <Link to={tablePath(db, v.schema, v.name)}>
                        <span className={styles.schema}>{v.schema}.</span>
                        {v.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={meili.meta}>{t("pgNoViews")}</p>
              )}
            </section>
            <section className={meili.card}>
              <div className={meili.heading}>
                <h2>{t("pgSchemas")}</h2>
                <span>{f.number(data.schemas.length)}</span>
              </div>
              <ul className={styles.list}>
                {data.schemas.map((s) => (
                  <li key={s.name}>
                    <span>{s.name}</span>
                    <span className={meili.secondary}>
                      {f.number(s.tables)} · {s.owner}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
            <section className={meili.card}>
              <div className={meili.heading}>
                <h2>{t("pgExtensions")}</h2>
                <span>{f.number(data.extensions.length)}</span>
              </div>
              <ul className={styles.list}>
                {data.extensions.map((e) => (
                  <li key={e.name}>
                    <code>{e.name}</code>
                    <span className={meili.secondary}>
                      {e.version} · {e.schema}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </div>
      )}
    </>
  );
}
