import { useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePageTitle, usePreferences } from "../../app/Preferences";
import { ErrorMessage, PageHeading } from "../../app/Shell";
import { api } from "../../lib/api";
import type { Key } from "../../lib/i18n";
import {
  displayName,
  formatBytes,
  memorySegments,
  type SystemReport,
} from "./memory";
import styles from "./System.module.css";

const REFRESH_SECONDS = 5;
const filters = ["all", "container", "service"] as const;
type Filter = (typeof filters)[number];
const filterLabels: Record<Filter, Key> = {
  all: "all",
  container: "kindContainers",
  service: "kindServices",
};

export default function System() {
  usePageTitle("system");
  const { t, locale } = usePreferences();
  const [filter, setFilter] = useState<Filter>("all");
  const report = useQuery({
    queryKey: ["system"],
    queryFn: ({ signal }) =>
      api<SystemReport>("/api/system", undefined, signal),
    refetchInterval: REFRESH_SECONDS * 1000,
    retry: false,
  });
  const bytes = (value: number) => formatBytes(value, locale);
  const percent = (value: number) =>
    new Intl.NumberFormat(locale, {
      style: "percent",
      maximumFractionDigits: value < 0.1 ? 1 : 0,
    }).format(value);
  const data = report.data;
  const memory = data?.memory;
  const segments = data ? memorySegments(data, t) : [];
  const groups =
    data?.groups.filter((g) => filter === "all" || g.kind === filter) || [];
  const stats: [Key, string, string?][] = memory
    ? [
        ["total", bytes(memory.total)],
        [
          "memUsed",
          bytes(memory.used),
          memory.total ? percent(memory.used / memory.total) : undefined,
        ],
        ["memAvailable", bytes(memory.available)],
        ["memCache", bytes(memory.cached + memory.buffers)],
        [
          "memSwap",
          memory.swapTotal
            ? `${bytes(memory.swapUsed)} / ${bytes(memory.swapTotal)}`
            : "—",
        ],
      ]
    : [];
  return (
    <>
      <PageHeading title={t("system")} eyebrow={t("systemIntro")}>
        <span className={styles.meta} aria-live="polite">
          {report.isFetching
            ? t("refreshing")
            : t("refreshedEvery", { seconds: REFRESH_SECONDS })}
        </span>
        <button
          className="ghost"
          onClick={() => void report.refetch()}
          disabled={report.isFetching}
        >
          {t("refresh")} ↻
        </button>
      </PageHeading>
      <ErrorMessage error={report.error} />
      {report.isPending && <p className={styles.meta}>{t("loading")}</p>}
      {data && memory && (
        <>
          <dl className={styles.stats}>
            {stats.map(([key, value, note]) => (
              <div key={key}>
                <dt>{t(key)}</dt>
                <dd>
                  {value}
                  {note && <span>{note}</span>}
                </dd>
              </div>
            ))}
          </dl>
          {!data.cgroupAvailable && (
            <p className={styles.notice} role="note">
              {t("cgroupUnavailable")}
            </p>
          )}
          {memory.total > 0 && (
            <section className={styles.map}>
              <div className={styles.heading}>
                <h2>{t("memoryMap")}</h2>
                <span>
                  {t("sampledAt", {
                    time: new Date(data.sampledAt).toLocaleTimeString(locale),
                  })}
                </span>
              </div>
              <div
                className={styles.bar}
                role="img"
                aria-label={t("memoryMapLabel", {
                  total: bytes(memory.total),
                  parts: segments
                    .map((s) => `${s.label} ${bytes(s.bytes)}`)
                    .join(", "),
                })}
              >
                {segments.map((s) =>
                  s.bytes > 0 ? (
                    <span
                      key={s.key}
                      className={styles[s.tone]}
                      style={
                        {
                          "--share": `${(s.bytes / memory.total) * 100}%`,
                        } as CSSProperties
                      }
                      title={`${s.label}: ${bytes(s.bytes)}`}
                    />
                  ) : null,
                )}
              </div>
              <ul className={styles.legend}>
                {segments.map((s) => (
                  <li key={s.key}>
                    <i className={styles[s.tone]} aria-hidden="true" />
                    <span className={styles.label}>{s.label}</span>
                    <span>{bytes(s.bytes)}</span>
                    <span className={styles.share}>
                      {percent(s.bytes / memory.total)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {data.cgroupAvailable && (
            <section className={styles.apps}>
              <div className={styles.heading}>
                <h2>{t("app")}</h2>
                <div
                  className={styles.filters}
                  role="group"
                  aria-label={t("appKind")}
                >
                  {filters.map((f) => (
                    <button
                      key={f}
                      aria-pressed={filter === f}
                      onClick={() => setFilter(f)}
                    >
                      {t(filterLabels[f])}
                    </button>
                  ))}
                </div>
              </div>
              {groups.length ? (
                <div className={styles.scroll}>
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">{t("app")}</th>
                        <th scope="col">{t("memory")}</th>
                        <th scope="col">{t("ramShare")}</th>
                        <th scope="col">{t("memLimit")}</th>
                        <th scope="col">{t("cpu")}</th>
                        <th scope="col">{t("memCache")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groups.map((g) => (
                        <tr key={g.id}>
                          <th scope="row">
                            <span className={styles.name}>
                              {displayName(g, t)}
                            </span>
                            <span className={styles.kind}>
                              {[
                                g.project,
                                t(`kind${g.kind}` as Key),
                                g.kind === "container" && g.id.slice(0, 12),
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                          </th>
                          <td>{bytes(g.memory)}</td>
                          <td>
                            <span className={styles.meter}>
                              <span
                                style={
                                  {
                                    "--share": `${Math.min(100, (g.memory / memory.total) * 100)}%`,
                                  } as CSSProperties
                                }
                              />
                            </span>
                            {memory.total
                              ? percent(g.memory / memory.total)
                              : "—"}
                          </td>
                          <td className={styles.muted}>
                            {g.limit == null ? t("none") : bytes(g.limit)}
                          </td>
                          <td>
                            {g.cpu == null
                              ? "—"
                              : new Intl.NumberFormat(locale, {
                                  style: "percent",
                                  maximumFractionDigits: 1,
                                }).format(g.cpu / 100)}
                          </td>
                          <td className={styles.muted}>{bytes(g.cache)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="empty">
                  <p>{t("noApps")}</p>
                </div>
              )}
              <p className={styles.help}>
                {t("memoryHelp")} {t("cpuHelp")}
              </p>
            </section>
          )}
        </>
      )}
    </>
  );
}
