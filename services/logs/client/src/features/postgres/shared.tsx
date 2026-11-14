import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import { usePreferences } from "../../app/Preferences";
import { ErrorMessage, PageHeading } from "../../app/Shell";
import { api, ApiError } from "../../lib/api";
import { formatBytes } from "../system/memory";
import { apiPath, dbPath, type Overview } from "./pg";
import { ModeBadge, SuperuserBanner } from "./Write";
import meili from "../meilisearch/Meilisearch.module.css";
import styles from "./Postgres.module.css";

export function useOverview() {
  return useQuery({
    queryKey: ["pg", "overview"],
    queryFn: ({ signal }) =>
      api<Overview>("/api/pg/overview", undefined, signal),
    retry: false,
    refetchInterval: 15000,
  });
}

export function usePg<T>(path: string, enabled = true) {
  return useQuery({
    queryKey: ["pg", path],
    queryFn: ({ signal }) => api<T>(apiPath(path), undefined, signal),
    retry: false,
    enabled,
  });
}

export function useFormat() {
  const { locale, zone } = usePreferences();
  const number = (value: number | string | null | undefined) =>
    value == null || value === ""
      ? "—"
      : typeof value === "string"
        ? value
        : new Intl.NumberFormat(locale).format(value);
  return {
    number,
    bytes: (value: number | null | undefined) =>
      value == null ? "—" : formatBytes(value, locale),
    percent: (value: number | null | undefined) =>
      value == null
        ? "—"
        : new Intl.NumberFormat(locale, {
            style: "percent",
            maximumFractionDigits: 1,
          }).format(value),
    ms: (value: number) =>
      new Intl.NumberFormat(locale, {
        maximumFractionDigits: value < 10 ? 2 : 0,
      }).format(value),
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

/** Page heading with the mode badge, superuser warning and database switcher. */
export function PgHeading({
  title,
  eyebrow,
  db,
  children,
}: {
  title?: string;
  eyebrow?: string;
  db?: string;
  children?: ReactNode;
}) {
  const { t } = usePreferences();
  const navigate = useNavigate();
  const overview = useOverview();
  const names = overview.data?.databases.map((d) => d.name) || [];
  return (
    <>
      <PageHeading
        title={title || t("postgres")}
        eyebrow={eyebrow || t("pgIntro")}
      >
        <ModeBadge />
        {children}
      </PageHeading>
      <nav className={meili.subnav} aria-label={t("postgres")}>
        <NavLink end to="/postgres">
          {t("pgDatabases")}
        </NavLink>
        {db && (
          <>
            <NavLink end to={dbPath(db)}>
              {t("pgTables")}
            </NavLink>
            <NavLink to={dbPath(db, "/query")}>{t("pgSqlEditor")}</NavLink>
            {names.length > 1 && (
              <select
                className={styles.dbSelect}
                aria-label={t("pgDatabase")}
                value={db}
                onChange={(e) => navigate(dbPath(e.target.value))}
              >
                {names.includes(db) ? null : <option value={db}>{db}</option>}
                {names.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            )}
          </>
        )}
      </nav>
      <SuperuserBanner />
    </>
  );
}

/** Missing configuration gets setup steps; other failures use ErrorMessage. */
export function PgError({ error }: { error: unknown }) {
  const { t } = usePreferences();
  if (!error) return null;
  if (
    error instanceof ApiError &&
    (error.code === "not_configured" || error.code === "invalid_config")
  )
    return (
      <div className="empty" role="status">
        <h2>{t(error.key)}</h2>
        <ol className={styles.steps}>
          <li>{t("pgSetup1")}</li>
          <li>{t("pgSetup2")}</li>
          <li>{t("pgSetup3")}</li>
        </ol>
      </div>
    );
  return <ErrorMessage error={error} />;
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

/** Route params are decoded by the router; reject anything the API would. */
export function useNames(...keys: string[]) {
  const params = useParams();
  const values = keys.map((key) => params[key] || "");
  const ok = values.every((v) => v && v.length <= 128 && !v.includes("\0"));
  return { ok, values };
}
