import { useState, type CSSProperties, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePageTitle, usePreferences } from "../../app/Preferences";
import { ErrorMessage, PageHeading } from "../../app/Shell";
import { api } from "../../lib/api";
import type { Key } from "../../lib/i18n";
import {
  diskSegments,
  diskUsedShare,
  displayName,
  formatBytes,
  memorySegments,
  type Segment,
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
type Stat = { key: Key; value: string; note?: string };

function Usage({
  title,
  aside,
  stats,
  segments,
  total,
  label,
  help,
  bytes,
  percent,
}: {
  title: string;
  aside?: ReactNode;
  stats: Stat[];
  segments: Segment[];
  total: number;
  label: (parts: string) => string;
  help?: string;
  bytes: (value: number) => string;
  percent: (value: number) => string;
}) {
  const { t } = usePreferences();
  return (
    <section className={styles.card}>
      <div className={styles.heading}>
        <h2>{title}</h2>
        {aside && <span>{aside}</span>}
      </div>
      <dl className={styles.stats}>
        {stats.map(({ key, value, note }) => (
          <div key={key}>
            <dt>{t(key)}</dt>
            <dd>
              {value}
              {note && <span>{note}</span>}
            </dd>
          </div>
        ))}
      </dl>
      {total > 0 && (
        <>
          <div
            className={styles.bar}
            role="img"
            aria-label={label(
              segments.map((s) => `${s.label} ${bytes(s.bytes)}`).join(", "),
            )}
          >
            {segments.map((s) =>
              s.bytes > 0 ? (
                <span
                  key={s.key}
                  className={styles[s.tone]}
                  style={
                    {
                      "--share": `${(s.bytes / total) * 100}%`,
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
                <span className={styles.label} title={s.label}>
                  {s.label}
                </span>
                <span className={styles.number}>{bytes(s.bytes)}</span>
                <span className={styles.share}>{percent(s.bytes / total)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {help && <p className={styles.help}>{help}</p>}
    </section>
  );
}

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
  const disk = data?.disk;
  const groups =
    data?.groups.filter((g) => filter === "all" || g.kind === filter) || [];
  const memoryStats: Stat[] = memory
    ? [
        { key: "total", value: bytes(memory.total) },
        {
          key: "memUsed",
          value: bytes(memory.used),
          note: memory.total ? percent(memory.used / memory.total) : undefined,
        },
        { key: "memAvailable", value: bytes(memory.available) },
        { key: "memCache", value: bytes(memory.cached + memory.buffers) },
        {
          key: "memSwap",
          value: memory.swapTotal
            ? `${bytes(memory.swapUsed)} / ${bytes(memory.swapTotal)}`
            : "—",
        },
      ]
    : [];
  const diskStats: Stat[] = disk
    ? [
        { key: "total", value: bytes(disk.total) },
        {
          key: "memUsed",
          value: bytes(disk.used),
          note: percent(diskUsedShare(disk)),
        },
        { key: "memAvailable", value: bytes(disk.available) },
        {
          key: "logData",
          value: disk.logData == null ? "—" : bytes(disk.logData),
        },
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
        <div className={styles.page}>
          {!data.cgroupAvailable && (
            <p className={styles.notice} role="note">
              {t("cgroupUnavailable")}
            </p>
          )}
          <Usage
            title={t("memory")}
            aside={t("sampledAt", {
              time: new Date(data.sampledAt).toLocaleTimeString(locale),
            })}
            stats={memoryStats}
            segments={memorySegments(data, t)}
            total={memory.total}
            label={(parts) =>
              t("memoryMapLabel", { total: bytes(memory.total), parts })
            }
            bytes={bytes}
            percent={percent}
          />
          {disk && (
            <Usage
              title={t("disk")}
              aside={<code>{disk.path}</code>}
              stats={diskStats}
              segments={diskSegments(disk, t)}
              total={disk.total}
              label={(parts) =>
                t("diskMapLabel", { total: bytes(disk.total), parts })
              }
              help={t("diskHelp")}
              bytes={bytes}
              percent={percent}
            />
          )}
          {data.cgroupAvailable && (
            <section className={styles.card}>
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
                        <th scope="col">{t("cpu")}</th>
                        <th scope="col" className={styles.optional}>
                          {t("memLimit")}
                        </th>
                        <th scope="col" className={styles.optional}>
                          {t("memCache")}
                        </th>
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
                          <td className={styles.strong}>{bytes(g.memory)}</td>
                          <td>
                            <span className={styles.meter} aria-hidden="true">
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
                          <td>
                            {g.cpu == null
                              ? "—"
                              : new Intl.NumberFormat(locale, {
                                  style: "percent",
                                  maximumFractionDigits: 1,
                                }).format(g.cpu / 100)}
                          </td>
                          <td
                            className={`${styles.secondary} ${styles.optional}`}
                          >
                            {g.limit == null ? t("none") : bytes(g.limit)}
                          </td>
                          <td
                            className={`${styles.secondary} ${styles.optional}`}
                          >
                            {bytes(g.cache)}
                          </td>
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
        </div>
      )}
    </>
  );
}
