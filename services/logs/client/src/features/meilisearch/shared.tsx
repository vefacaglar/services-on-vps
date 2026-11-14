import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { usePreferences } from "../../app/Preferences";
import { ErrorMessage, PageHeading } from "../../app/Shell";
import { api, ApiError } from "../../lib/api";
import type { Key } from "../../lib/i18n";
import { formatBytes } from "../system/memory";
import type { Overview, TaskStatus } from "./meili";
import styles from "./Meilisearch.module.css";

export function useOverview() {
  return useQuery({
    queryKey: ["meili", "overview"],
    queryFn: ({ signal }) =>
      api<Overview>("/api/meili/overview", undefined, signal),
    retry: false,
    refetchInterval: 15000,
  });
}

export function useFormat() {
  const { locale, zone } = usePreferences();
  return {
    bytes: (value: number | undefined) =>
      value == null ? "—" : formatBytes(value, locale),
    number: (value: number | undefined) =>
      value == null ? "—" : new Intl.NumberFormat(locale).format(value),
    date: (value: string | null | undefined) => {
      if (!value) return "—";
      const date = new Date(value);
      return Number.isFinite(+date)
        ? new Intl.DateTimeFormat(locale, {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone: zone === "utc" ? "UTC" : undefined,
          }).format(date)
        : value;
    },
  };
}

export function MeiliHeading({
  title,
  eyebrow,
  children,
}: {
  title?: string;
  eyebrow?: string;
  children?: ReactNode;
}) {
  const { t } = usePreferences();
  return (
    <>
      <PageHeading
        title={title || t("meilisearch")}
        eyebrow={eyebrow || t("meiliIntro")}
      >
        {children}
      </PageHeading>
      <nav className={styles.subnav} aria-label={t("meilisearch")}>
        <NavLink end to="/meilisearch">
          {t("meiliOverview")}
        </NavLink>
        <NavLink to="/meilisearch/tasks">{t("tasks")}</NavLink>
        <NavLink to="/meilisearch/keys">{t("apiKeys")}</NavLink>
      </nav>
    </>
  );
}

/** Not-configured gets its own explanation; other failures use ErrorMessage. */
export function MeiliError({ error }: { error: unknown }) {
  const { t } = usePreferences();
  if (!error) return null;
  if (error instanceof ApiError && error.code === "not_configured")
    return (
      <div className="empty" role="status">
        <h2>{t("meiliNotConfigured")}</h2>
        <p>{t("meiliNotConfiguredHelp")}</p>
      </div>
    );
  return <ErrorMessage error={error} />;
}

export function StatusBadge({ status }: { status: TaskStatus }) {
  const { t } = usePreferences();
  return (
    <span className={`${styles.status} ${styles[status] || ""}`}>
      {t(`status${status}` as Key)}
    </span>
  );
}

export function RefreshButton({
  busy,
  onClick,
}: {
  busy: boolean;
  onClick: () => void;
}) {
  const { t } = usePreferences();
  return (
    <button className="ghost" onClick={onClick} disabled={busy}>
      {t(busy ? "refreshing" : "refresh")} ↻
    </button>
  );
}
