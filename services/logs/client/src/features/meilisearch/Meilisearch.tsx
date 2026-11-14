import { useQuery } from "@tanstack/react-query";
import { Link, Navigate, Route, Routes } from "react-router-dom";
import { usePageTitle, usePreferences } from "../../app/Preferences";
import { api } from "../../lib/api";
import IndexPage from "./IndexPage";
import Tasks from "./Tasks";
import {
  durationMs,
  formatDuration,
  swapsOf,
  taskQuery,
  type ApiKey,
  type TaskPage,
} from "./meili";
import {
  MeiliError,
  MeiliHeading,
  RefreshButton,
  StatusBadge,
  useFormat,
  useOverview,
} from "./shared";
import styles from "./Meilisearch.module.css";

export default function Meilisearch() {
  usePageTitle("meilisearch");
  return (
    <Routes>
      <Route index element={<OverviewPage />} />
      <Route path="tasks" element={<Tasks />} />
      <Route path="keys" element={<Keys />} />
      <Route path="indexes/:uid" element={<IndexPage />} />
      <Route path="*" element={<Navigate replace to="/meilisearch" />} />
    </Routes>
  );
}

function ConnectHelp() {
  const { t } = usePreferences();
  return (
    <section className={styles.card}>
      <div className={styles.heading}>
        <h2>{t("meiliConnect")}</h2>
      </div>
      <p>{t("meiliConnectAddress")}</p>
      <pre className={styles.code}>http://meilisearch:7700</pre>
      <p className={styles.help}>{t("meiliConnectKeys")}</p>
      <p className={styles.help}>{t("meiliConnectPublic")}</p>
    </section>
  );
}

function OverviewPage() {
  const { t, locale } = usePreferences();
  const f = useFormat();
  const overview = useOverview();
  const configured = !!overview.data;
  const recent = useQuery({
    queryKey: ["meili", "recent-tasks"],
    queryFn: ({ signal }) =>
      api<TaskPage>(
        taskQuery({
          statuses: ["failed", "processing", "enqueued"],
          limit: 8,
        }),
        undefined,
        signal,
      ),
    enabled: configured,
    retry: false,
    refetchInterval: 15000,
  });
  const swaps = useQuery({
    queryKey: ["meili", "swaps"],
    queryFn: ({ signal }) =>
      api<TaskPage>(
        taskQuery({ types: ["indexSwap"], limit: 20 }),
        undefined,
        signal,
      ),
    enabled: configured,
    retry: false,
  });
  const data = overview.data;
  const swapRows = swaps.data ? swapsOf(swaps.data.results) : [];
  const features = Object.entries(data?.features || {}).filter(
    ([, value]) => typeof value === "boolean",
  );
  return (
    <>
      <MeiliHeading>
        <RefreshButton
          busy={overview.isFetching}
          onClick={() => {
            void overview.refetch();
            void recent.refetch();
            void swaps.refetch();
          }}
        />
      </MeiliHeading>
      <MeiliError error={overview.error} />
      {overview.isPending && <p className={styles.meta}>{t("loading")}</p>}
      {data && (
        <div className={styles.page}>
          <section className={styles.card}>
            <dl className={styles.stats}>
              <div>
                <dt>{t("meiliVersion")}</dt>
                <dd>{data.version || "—"}</dd>
              </div>
              <div>
                <dt>{t("meiliHealth")}</dt>
                <dd>
                  <span
                    className={
                      data.health === "available" ? styles.ok : styles.bad
                    }
                  >
                    {data.health || "—"}
                  </span>
                </dd>
              </div>
              <div>
                <dt>{t("meiliDbSize")}</dt>
                <dd>
                  {f.bytes(data.databaseSize)}
                  <span className={styles.sub}>
                    {t("memUsed").toLowerCase()}{" "}
                    {f.bytes(data.usedDatabaseSize)}
                  </span>
                </dd>
              </div>
              <div>
                <dt>{t("meiliIndexes")}</dt>
                <dd>{f.number(data.totalIndexes)}</dd>
              </div>
              <div>
                <dt>{t("meiliLastUpdate")}</dt>
                <dd className={styles.small}>{f.date(data.lastUpdate)}</dd>
              </div>
            </dl>
          </section>

          {data.indexes.length ? (
            <section className={styles.card}>
              <div className={styles.heading}>
                <h2>{t("meiliIndexes")}</h2>
              </div>
              <div className={styles.scroll}>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">{t("meiliIndex")}</th>
                      <th scope="col" className={styles.optional}>
                        {t("primaryKey")}
                      </th>
                      <th scope="col">{t("documents")}</th>
                      <th scope="col">{t("size")}</th>
                      <th scope="col">{t("status")}</th>
                      <th scope="col" className={styles.optional}>
                        {t("updated")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.indexes.map((index) => (
                      <tr key={index.uid}>
                        <th scope="row">
                          <Link
                            className={styles.name}
                            to={`/meilisearch/indexes/${encodeURIComponent(index.uid)}`}
                          >
                            {index.uid}
                          </Link>
                        </th>
                        <td
                          className={`${styles.secondary} ${styles.optional}`}
                        >
                          <code>{index.primaryKey || "—"}</code>
                        </td>
                        <td className={styles.strong}>
                          {f.number(index.numberOfDocuments)}
                        </td>
                        <td>{f.bytes(index.indexSize)}</td>
                        <td>
                          {index.isIndexing ? (
                            <span className={styles.processing}>
                              {t("indexing")}
                            </span>
                          ) : (
                            <span className={styles.muted}>
                              {t("indexReady")}
                            </span>
                          )}
                        </td>
                        <td
                          className={`${styles.secondary} ${styles.optional}`}
                        >
                          {f.date(index.updatedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : (
            <>
              <div className="empty">
                <h2>{t("meiliEmpty")}</h2>
              </div>
              <ConnectHelp />
            </>
          )}

          <section className={styles.card}>
            <div className={styles.heading}>
              <h2>{t("recentTasks")}</h2>
              <Link to="/meilisearch/tasks">{t("tasks")} →</Link>
            </div>
            <MeiliError error={recent.error} />
            {recent.data &&
              (recent.data.results.length ? (
                <ul className={styles.taskList}>
                  {recent.data.results.map((task) => (
                    <li key={task.uid}>
                      <StatusBadge status={task.status} />
                      <span className={styles.name}>
                        {task.type}
                        {task.indexUid && (
                          <span className={styles.kind}>
                            {" "}
                            · {task.indexUid}
                          </span>
                        )}
                      </span>
                      <span className={styles.secondary}>
                        #{task.uid} · {f.date(task.enqueuedAt)}
                        {task.duration &&
                          ` · ${formatDuration(durationMs(task.duration), locale)}`}
                      </span>
                      {task.error && (
                        <p className={styles.taskError}>{task.error.message}</p>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.meta}>{t("noRecentTasks")}</p>
              ))}
          </section>

          <section className={styles.card}>
            <div className={styles.heading}>
              <h2>{t("aliases")}</h2>
            </div>
            <p className={styles.note} role="note">
              {t("aliasesNote")}
            </p>
            <MeiliError error={swaps.error} />
            {swaps.data &&
              (swapRows.length ? (
                <ul className={styles.taskList}>
                  {swapRows.map((swap) => (
                    <li key={`${swap.task}-${swap.from}-${swap.to}`}>
                      <StatusBadge status={swap.status} />
                      <span className={styles.name}>
                        <code>{swap.from}</code> {swap.rename ? "→" : "⇄"}{" "}
                        <code>{swap.to}</code>
                        <span className={styles.kind}>
                          {" "}
                          · {t(swap.rename ? "renamed" : "swapped")}
                        </span>
                      </span>
                      <span className={styles.secondary}>
                        #{swap.task} · {f.date(swap.at)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.meta}>{t("noSwaps")}</p>
              ))}
          </section>

          {data.indexes.length > 0 && <ConnectHelp />}

          {features.length > 0 && (
            <section className={styles.card}>
              <div className={styles.heading}>
                <h2>{t("experimentalFeatures")}</h2>
              </div>
              <ul className={styles.chips}>
                {features.map(([name, on]) => (
                  <li key={name} className={on ? styles.chipOn : undefined}>
                    <code>{name}</code> {t(on ? "enabled" : "disabled")}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </>
  );
}

function Keys() {
  const { t } = usePreferences();
  const f = useFormat();
  const keys = useQuery({
    queryKey: ["meili", "keys"],
    queryFn: ({ signal }) =>
      api<{ results: ApiKey[]; total: number }>(
        "/api/meili/keys",
        undefined,
        signal,
      ),
    retry: false,
  });
  return (
    <>
      <MeiliHeading>
        <RefreshButton
          busy={keys.isFetching}
          onClick={() => void keys.refetch()}
        />
      </MeiliHeading>
      <MeiliError error={keys.error} />
      {keys.isPending && <p className={styles.meta}>{t("loading")}</p>}
      {keys.data && (
        <div className={styles.page}>
          <section className={styles.card}>
            <div className={styles.heading}>
              <h2>{t("apiKeys")}</h2>
              <span>{f.number(keys.data.total)}</span>
            </div>
            <p className={styles.note} role="note">
              {t("keysRedacted")}
            </p>
            {keys.data.results.length ? (
              <div className={styles.scroll}>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">{t("keyName")}</th>
                      <th scope="col">{t("keyPrefix")}</th>
                      <th scope="col" className={styles.wrapCell}>
                        {t("keyActions")}
                      </th>
                      <th
                        scope="col"
                        className={`${styles.wrapCell} ${styles.optional}`}
                      >
                        {t("keyIndexes")}
                      </th>
                      <th scope="col" className={styles.optional}>
                        {t("expires")}
                      </th>
                      <th scope="col" className={styles.optional}>
                        {t("created")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {keys.data.results.map((key) => (
                      <tr key={key.uid}>
                        <th scope="row">
                          <span className={styles.name}>
                            {key.name || key.uid}
                          </span>
                          {key.description && (
                            <span className={styles.kind}>
                              {key.description}
                            </span>
                          )}
                        </th>
                        <td>
                          <code>{key.keyPrefix}…</code>
                        </td>
                        <td className={styles.wrapCell}>
                          {key.actions.join(", ")}
                        </td>
                        <td className={`${styles.wrapCell} ${styles.optional}`}>
                          {key.indexes.join(", ")}
                        </td>
                        <td
                          className={`${styles.secondary} ${styles.optional}`}
                        >
                          {key.expiresAt ? f.date(key.expiresAt) : t("never")}
                        </td>
                        <td
                          className={`${styles.secondary} ${styles.optional}`}
                        >
                          {f.date(key.createdAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className={styles.meta}>{t("noKeys")}</p>
            )}
          </section>
        </div>
      )}
    </>
  );
}
