import { useEffect, useState, type ReactNode } from "react";
import { usePreferences } from "../../app/Preferences";
import { ErrorMessage, PageHeading } from "../../app/Shell";
import { ApiError } from "../../lib/api";
import base from "../meilisearch/Meilisearch.module.css";
import { statusKey, statusTone } from "./ci";
import styles from "./Ci.module.css";

export { RefreshButton, useFormat } from "../meilisearch/shared";

export function CiHeading({
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
    <PageHeading title={title || t("ci")} eyebrow={eyebrow || t("ciIntro")}>
      {children}
    </PageHeading>
  );
}

/** Not-configured gets its own explanation; other failures use ErrorMessage. */
export function CiError({ error }: { error: unknown }) {
  const { t } = usePreferences();
  if (!error) return null;
  if (error instanceof ApiError && error.code === "not_configured")
    return (
      <div className="empty" role="status">
        <h2>{t("ciNotConfigured")}</h2>
        <p>{t("ciNotConfiguredHelp")}</p>
      </div>
    );
  return <ErrorMessage error={error} />;
}

export function CiStatusBadge({ status }: { status: string }) {
  const { t } = usePreferences();
  const key = statusKey(status);
  return (
    <span className={`${base.status} ${styles[statusTone(status)]}`}>
      {key ? t(key) : status}
    </span>
  );
}

/** Current unix seconds, ticking once a second while something is running. */
export function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now() / 1000);
    const timer = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

// Polling queries set refetchIntervalInBackground: false, so React Query
// skips interval ticks while the tab is hidden (document.hidden); useWake
// catches up as soon as it is visible again.

/** Refetches at once when a hidden tab comes back while `on`. */
export function useWake(on: boolean, refetch: () => unknown) {
  useEffect(() => {
    if (!on) return;
    const wake = () => {
      if (!document.hidden) void refetch();
    };
    document.addEventListener("visibilitychange", wake);
    return () => document.removeEventListener("visibilitychange", wake);
  }, [on, refetch]);
}
