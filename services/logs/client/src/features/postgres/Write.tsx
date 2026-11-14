import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { usePreferences } from "../../app/Preferences";
import { api } from "../../lib/api";
import type { PgStatus } from "./pg";
import styles from "./Postgres.module.css";

// Write mode lives in memory only: off on every page load, shared by the
// PostgreSQL pages while navigating, never persisted.
let writeMode = false;
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function setWriteMode(on: boolean) {
  writeMode = on;
  listeners.forEach((listener) => listener());
}

export function usePgStatus() {
  return useQuery({
    queryKey: ["pg", "status"],
    queryFn: ({ signal }) =>
      api<PgStatus>("/api/pg/status", undefined, signal),
    retry: false,
    staleTime: 60_000,
  });
}

/** Whether write mode is on and the server allows it. */
export function useWriteMode() {
  const on = useSyncExternalStore(subscribe, () => writeMode);
  const status = usePgStatus();
  return on && !!status.data?.configured && !!status.data.writeEnabled;
}

export function WriteToggle() {
  const { t } = usePreferences();
  const status = usePgStatus();
  const on = useWriteMode();
  const available = !!status.data?.configured && status.data.writeEnabled;
  const disabled = status.data?.configured && !status.data.writeEnabled;
  return (
    <div className={`${styles.writeToggle} ${on ? styles.writeOn : ""}`}>
      <label className="checkbox">
        <input
          type="checkbox"
          role="switch"
          aria-checked={on}
          checked={on}
          disabled={!available}
          onChange={(e) => setWriteMode(e.target.checked)}
        />
        <strong>{t("writeMode")}</strong>
      </label>
      <span>
        {disabled
          ? t("pgWriteDisabled")
          : t(on ? "pgWriteOn" : "pgWriteOff")}
      </span>
    </div>
  );
}

/** Heading badge: read-only, or the write-mode warning. */
export function ModeBadge() {
  const { t } = usePreferences();
  const on = useWriteMode();
  return on ? (
    <span className={styles.writeBadge}>{t("writeMode")}</span>
  ) : (
    <span className={styles.readOnly} title={t("pgReadOnly")}>
      {t("readOnly")}
    </span>
  );
}

export function SuperuserBanner() {
  const { t } = usePreferences();
  const status = usePgStatus();
  if (!status.data?.superuser) return null;
  return (
    <p className={styles.superuser} role="alert">
      {t("pgSuperuser")}
    </p>
  );
}
