import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { usePreferences } from "../../app/Preferences";
import { api } from "../../lib/api";
import {
  durationMs,
  formatDuration,
  taskQuery,
  taskStatuses,
  taskSummary,
  taskTypes,
  UID,
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

const PAGE = 25;

export default function Tasks() {
  const { t, locale } = usePreferences();
  const f = useFormat();
  const [params, setParams] = useSearchParams();
  const status = taskStatuses.find((s) => s === params.get("status")) || "";
  const type = /^[a-zA-Z]{1,64}$/.test(params.get("type") || "")
    ? params.get("type")!
    : "";
  const index = UID.test(params.get("index") || "") ? params.get("index")! : "";
  const fromRaw = params.get("from");
  const from = fromRaw && /^\d{1,10}$/.test(fromRaw) ? +fromRaw : null;
  const overview = useOverview();
  const tasks = useQuery({
    queryKey: ["meili", "tasks", status, type, index, from],
    queryFn: ({ signal }) =>
      api<TaskPage>(
        taskQuery({
          statuses: [status],
          types: [type],
          indexUids: [index],
          limit: PAGE,
          from,
        }),
        undefined,
        signal,
      ),
    retry: false,
    placeholderData: keepPreviousData,
    refetchInterval: from == null ? 10000 : false,
  });
  function change(update: Record<string, string>) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(update))
      if (value) next.set(key, value);
      else next.delete(key);
    if (!("from" in update)) next.delete("from");
    setParams(next, { replace: !("from" in update) });
  }
  const indexes = overview.data?.indexes.map((i) => i.uid) || [];
  return (
    <>
      <MeiliHeading>
        <RefreshButton
          busy={tasks.isFetching}
          onClick={() => void tasks.refetch()}
        />
      </MeiliHeading>
      <div className={styles.page}>
        <div className={styles.toolbar}>
          <select
            aria-label={t("status")}
            value={status}
            onChange={(e) => change({ status: e.target.value })}
          >
            <option value="">{t("allStatuses")}</option>
            {taskStatuses.map((s) => (
              <option key={s} value={s}>
                {t(`status${s}`)}
              </option>
            ))}
          </select>
          <select
            aria-label={t("taskType")}
            value={type}
            onChange={(e) => change({ type: e.target.value })}
          >
            <option value="">{t("allTypes")}</option>
            {[...new Set([...taskTypes, ...(type ? [type] : [])])].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select
            aria-label={t("meiliIndex")}
            value={index}
            onChange={(e) => change({ index: e.target.value })}
          >
            <option value="">{t("allIndexes")}</option>
            {[...new Set([...indexes, ...(index ? [index] : [])])].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <MeiliError error={tasks.error} />
        {tasks.isPending && <p className={styles.meta}>{t("loading")}</p>}
        {tasks.data && (
          <section className={styles.card}>
            <div className={styles.heading}>
              <h2>{t("tasks")}</h2>
              <span>{f.number(tasks.data.total)}</span>
            </div>
            {tasks.data.results.length ? (
              <div className={styles.scroll}>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">{t("taskType")}</th>
                      <th scope="col">{t("status")}</th>
                      <th scope="col" className={styles.optional}>
                        {t("meiliIndex")}
                      </th>
                      <th scope="col" className={styles.optional}>
                        {t("enqueuedAt")}
                      </th>
                      <th scope="col" className={styles.optional}>
                        {t("duration")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {tasks.data.results.map((task) => (
                      <tr key={task.uid}>
                        <th scope="row">
                          <span className={styles.name}>{task.type}</span>
                          <span className={styles.kind}>
                            #{task.uid}
                            {task.indexUid && ` · ${task.indexUid}`}
                            <span className={styles.phoneOnly}>
                              {" "}
                              · {f.date(task.enqueuedAt)}
                            </span>
                          </span>
                          {task.error ? (
                            <span className={styles.taskError}>
                              {task.error.message}
                            </span>
                          ) : (
                            taskSummary(task) && (
                              <span className={styles.kind}>
                                {taskSummary(task)}
                              </span>
                            )
                          )}
                        </th>
                        <td>
                          <StatusBadge status={task.status} />
                        </td>
                        <td
                          className={`${styles.secondary} ${styles.optional}`}
                        >
                          {task.indexUid || "—"}
                        </td>
                        <td
                          className={`${styles.secondary} ${styles.optional}`}
                        >
                          {f.date(task.enqueuedAt)}
                        </td>
                        <td
                          className={`${styles.secondary} ${styles.optional}`}
                        >
                          {formatDuration(durationMs(task.duration), locale)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className={styles.meta}>{t("noTasks")}</p>
            )}
            <div className={styles.pager}>
              <button
                className="ghost"
                disabled={from == null}
                onClick={() => change({ from: "" })}
              >
                {t("newestTasks")}
              </button>
              <button
                className="ghost"
                disabled={tasks.data.next == null}
                onClick={() => change({ from: String(tasks.data!.next) })}
              >
                {t("olderTasks")} →
              </button>
            </div>
          </section>
        )}
      </div>
    </>
  );
}
