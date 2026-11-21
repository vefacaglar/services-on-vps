import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../lib/api";
import { signInDestination } from "../../lib/query";
import { usePageTitle, usePreferences } from "../../app/Preferences";
import { Header, ErrorMessage } from "../../app/Shell";
import styles from "./Login.module.css";
export default function Login() {
  const { t } = usePreferences();
  usePageTitle("signIn");
  const [visible, setVisible] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const cache = useQueryClient();
  // Asked before any credentials are sent, so the server never has to reveal
  // that a password was right in order to request the code.
  const factor = useQuery({
    queryKey: ["login-factor"],
    queryFn: ({ signal }) =>
      api<{ totp: boolean }>("/api/login", undefined, signal),
    staleTime: Infinity,
    retry: 1,
  });
  // If the check itself failed, offer the field anyway rather than lock the user out.
  const codeRequired = factor.data?.totp === true;
  const codeVisible = codeRequired || factor.isError;
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError(undefined);
    try {
      const result = await api<{ username: string }>("/api/login", {
        username: data.get("username"),
        password: data.get("password"),
        code: codeVisible
          ? String(data.get("code") ?? "").replace(/\D/g, "")
          : undefined,
      });
      cache.setQueryData(["session"], result);
      const next = params.get("next");
      navigate(signInDestination(next, location.hash), { replace: true });
    } catch (e) {
      setError(
        codeVisible && e instanceof ApiError && e.key === "invalidCredentials"
          ? new ApiError("invalidCredentialsOrCode", e.status)
          : e,
      );
      const code = form.elements.namedItem("code");
      if (code instanceof HTMLInputElement) code.value = "";
      const password = form.elements.namedItem("password") as HTMLInputElement;
      password.value = "";
      password.focus();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={styles.page}>
      <Header />
      <main className={styles.main}>
        <p className="eyebrow">{t("privateAccess")}</p>
        <h1>
          {t("console")}
          <span className="accent">.</span>
        </h1>
        <p className={styles.intro}>{t("signInIntro")}</p>
        <form onSubmit={submit}>
          <label htmlFor="username">{t("username")}</label>
          <input
            id="username"
            name="username"
            autoComplete="username"
            maxLength={64}
            required
            autoFocus
            autoCapitalize="none"
            spellCheck={false}
          />
          <div className={styles.passwordLabel}>
            <label htmlFor="password">{t("password")}</label>
            <button
              type="button"
              className="text-button"
              aria-pressed={visible}
              onClick={() => setVisible(!visible)}
            >
              {t(visible ? "hide" : "show")}
            </button>
          </div>
          <input
            id="password"
            name="password"
            type={visible ? "text" : "password"}
            autoComplete="current-password"
            required
            maxLength={72}
          />
          {codeVisible && (
            <>
              <label htmlFor="code">{t("signInCode")}</label>
              <input
                id="code"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9 ]*"
                maxLength={7}
                required={codeRequired}
                aria-describedby="code-help"
                spellCheck={false}
              />
              <p id="code-help" className={styles.help}>
                {t("signInCodeHelp")}
              </p>
            </>
          )}
          <ErrorMessage error={error} />
          <button type="submit" className="primary" disabled={busy}>
            {t(busy ? "signingIn" : "signIn")} <span aria-hidden="true">↗</span>
          </button>
        </form>
        <p className={styles.note}>{t("privateNote")}</p>
      </main>
      <footer className={styles.footer}>
        <span>vefacaglar.com</span>
        <span>{t("console")}</span>
      </footer>
    </div>
  );
}
