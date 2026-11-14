import { lazy, Suspense } from "react";
import { Link, Navigate, Route, Routes } from "react-router-dom";
import { usePageTitle, usePreferences } from "../../app/Preferences";
import Database from "./Database";
import TablePage from "./TablePage";
import { dbPath, formatUptime } from "./pg";
import {
  PgError,
  PgHeading,
  RefreshButton,
  useFormat,
  useOverview,
} from "./shared";
import meili from "../meilisearch/Meilisearch.module.css";
import styles from "./Postgres.module.css";

// CodeMirror stays out of the overview chunk.
const QueryPage = lazy(() => import("./QueryPage"));

export default function Postgres() {
  usePageTitle("postgres");
  return (
    <Routes>
      <Route index element={<OverviewPage />} />
      <Route path="db/:db" element={<Database />} />
      <Route
        path="db/:db/query"
        element={
          <Suspense fallback={null}>
            <QueryPage />
          </Suspense>
        }
      />
      <Route path="db/:db/table/:schema/:table" element={<TablePage />} />
      <Route path="*" element={<Navigate replace to="/postgres" />} />
    </Routes>
  );
}

function OverviewPage() {
  const { t, language } = usePreferences();
  const f = useFormat();
  const overview = useOverview();
  const data = overview.data;
  const total = data?.connections.reduce((sum, c) => sum + c.count, 0) || 0;
  return (
    <>
      <PgHeading>
        <RefreshButton
          busy={overview.isFetching}
          onClick={() => void overview.refetch()}
        />
      </PgHeading>
      <PgError error={overview.error} />
      {overview.isPending && <p className={meili.meta}>{t("loading")}</p>}
      {data && (
        <div className={meili.page}>
          <section className={meili.card}>
            <dl className={meili.stats}>
              <div>
                <dt>{t("pgVersion")}</dt>
                <dd>
                  {data.server.version}
                  <span className={meili.sub}>{data.server.user}</span>
                </dd>
              </div>
              <div>
                <dt>{t("pgUptime")}</dt>
                <dd>
                  {formatUptime(data.server.uptimeSeconds, language)}
                  <span className={meili.sub}>
                    {t("pgStartedAt", { time: f.date(data.server.startedAt) })}
                  </span>
                </dd>
              </div>
              <div>
                <dt>{t("pgConnections")}</dt>
                <dd>
                  {f.number(total)} / {f.number(data.server.maxConnections)}
                  <span className={meili.sub}>
                    {data.connections
                      .map((c) => `${c.state} ${f.number(c.count)}`)
                      .join(" · ")}
                  </span>
                </dd>
              </div>
              <div>
                <dt>{t("pgCacheHit")}</dt>
                <dd>
                  {data.totals.cacheHitRatio != null &&
                  data.totals.cacheHitRatio < 0.9 ? (
                    <span className={meili.bad}>
                      {f.percent(data.totals.cacheHitRatio)}
                    </span>
                  ) : (
                    f.percent(data.totals.cacheHitRatio)
                  )}
                </dd>
              </div>
              <div>
                <dt>
                  {t("pgCommits")} / {t("pgRollbacks")}
                </dt>
                <dd className={meili.small}>
                  {f.number(data.totals.commits)} /{" "}
                  {f.number(data.totals.rollbacks)}
                </dd>
              </div>
              <div>
                <dt>
                  {t("pgDeadlocks")} · {t("pgWaitingLocks")}
                </dt>
                <dd className={meili.small}>
                  {f.number(data.totals.deadlocks)} ·{" "}
                  {f.number(data.server.waitingLocks)}
                </dd>
              </div>
            </dl>
            <p className={styles.version}>{data.server.fullVersion}</p>
          </section>

          <section className={meili.card}>
            <div className={meili.heading}>
              <h2>{t("pgDatabases")}</h2>
              <span>{f.number(data.databases.length)}</span>
            </div>
            <div className={meili.scroll}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t("pgDatabase")}</th>
                    <th scope="col">{t("size")}</th>
                    <th scope="col">{t("pgConnections")}</th>
                    <th scope="col" className={meili.optional}>
                      {t("pgCacheHit")}
                    </th>
                    <th scope="col" className={meili.optional}>
                      {t("pgCommits")}
                    </th>
                    <th scope="col" className={meili.optional}>
                      {t("pgDeadlocks")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.databases.map((db) => (
                    <tr key={db.name}>
                      <th scope="row">
                        <Link className={meili.name} to={dbPath(db.name)}>
                          {db.name}
                        </Link>
                      </th>
                      <td className={meili.strong}>{f.bytes(db.size)}</td>
                      <td>{f.number(db.connections)}</td>
                      <td className={meili.optional}>
                        {f.percent(db.cacheHitRatio)}
                      </td>
                      <td className={`${meili.secondary} ${meili.optional}`}>
                        {f.number(db.commits)}
                      </td>
                      <td className={`${meili.secondary} ${meili.optional}`}>
                        {f.number(db.deadlocks)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className={meili.card}>
            <div className={meili.heading}>
              <h2>{t("pgLongRunning")}</h2>
              <span>{f.number(data.longRunning.length)}</span>
            </div>
            {data.longRunning.length ? (
              <ul className={styles.queries}>
                {data.longRunning.map((q) => (
                  <li key={q.pid}>
                    <div className={styles.queryMeta}>
                      <span className={meili.strong}>{f.ms(q.seconds)} s</span>
                      <span>
                        {q.database || "—"} · {q.user || "—"}
                        {q.application ? ` · ${q.application}` : ""}
                      </span>
                      <span className={meili.secondary}>
                        pid {q.pid} · {q.state || "—"}
                        {q.waitEvent &&
                          ` · ${t("pgWaitOn", { event: `${q.waitEventType}/${q.waitEvent}` })}`}
                      </span>
                    </div>
                    <pre className={meili.code}>{q.query}</pre>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={meili.meta}>{t("pgNoLongRunning")}</p>
            )}
          </section>
        </div>
      )}
    </>
  );
}
