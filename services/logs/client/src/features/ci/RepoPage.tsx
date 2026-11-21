import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { usePreferences } from "../../app/Preferences";
import base from "../meilisearch/Meilisearch.module.css";
import {
  branchOptions,
  ciApi,
  elapsedSeconds,
  environmentSuggestions,
  firstLine,
  formatSeconds,
  isActive,
  isoOf,
  MAX_VARIABLES,
  parseId,
  shortCommit,
  validateBuild,
  type BuildProblem,
  type BuildRequest,
  type CiRepoDetail,
} from "./ci";
import {
  CiError,
  CiHeading,
  CiStatusBadge,
  RefreshButton,
  useFormat,
  useNow,
  useWake,
} from "./shared";
import styles from "./Ci.module.css";

export default function RepoPage() {
  const id = parseId(useParams().id);
  if (id == null) return <Navigate replace to="/ci" />;
  return <Repo id={id} />;
}

function Repo({ id }: { id: number }) {
  const { t } = usePreferences();
  const f = useFormat();
  const detail = useQuery({
    queryKey: ["ci", "repo", id],
    queryFn: ({ signal }) => ciApi.repo(id, signal),
    refetchInterval: (query) =>
      query.state.data?.pipelines.some((p) => isActive(p.status))
        ? 5000
        : false,
    refetchIntervalInBackground: false,
  });
  const data = detail.data;
  const busy = !!data?.pipelines.some((p) => isActive(p.status));
  const now = useNow(busy);
  useWake(busy, detail.refetch);
  return (
    <>
      <CiHeading
        title={data?.repo.fullName || t("ciRepository")}
        eyebrow={
          data
            ? [
                t("ciRepository"),
                data.repo.private && t("ciPrivate"),
                `${t("ciDefaultBranch")}: ${data.repo.defaultBranch || "—"}`,
              ]
                .filter(Boolean)
                .join(" · ")
            : t("ciRepository")
        }
      >
        <Link to="/ci" className={base.back}>
          ← {t("ciBack")}
        </Link>
        {data?.repo.forgeUrl && (
          <a
            className={base.back}
            href={data.repo.forgeUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("ciViewOnForge")} ↗
          </a>
        )}
        <RefreshButton
          busy={detail.isFetching}
          onClick={() => void detail.refetch()}
        />
      </CiHeading>
      <CiError error={detail.error} />
      {detail.isPending && <p className={base.meta}>{t("loading")}</p>}
      {data && (
        <div className={base.page}>
          <BuildForm id={id} data={data} />
          <section className={base.card}>
            <div className={base.heading}>
              <h2>{t("ciPipelines")}</h2>
              <span>{f.number(data.pipelines.length)}</span>
            </div>
            {data.pipelines.length ? (
              <div className={base.scroll}>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">{t("ciPipeline")}</th>
                      <th scope="col">{t("status")}</th>
                      <th scope="col" className={base.optional}>
                        {t("ciEvent")}
                      </th>
                      <th scope="col" className={base.optional}>
                        {t("ciBranch")}
                      </th>
                      <th scope="col" className={base.optional}>
                        {t("ciEnvironment")}
                      </th>
                      <th scope="col" className={base.optional}>
                        {t("ciCommit")}
                      </th>
                      <th
                        scope="col"
                        className={`${base.wrapCell} ${base.optional}`}
                      >
                        {t("message")}
                      </th>
                      <th scope="col" className={base.optional}>
                        {t("ciStarted")}
                      </th>
                      <th scope="col">{t("duration")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.pipelines.map((pipeline) => (
                      <tr key={pipeline.number}>
                        <th scope="row">
                          <Link
                            className={base.name}
                            to={`/ci/repos/${id}/pipelines/${pipeline.number}`}
                          >
                            #{pipeline.number}
                          </Link>
                          <span className={`${base.kind} ${base.phoneOnly}`}>
                            {[pipeline.branch, pipeline.environment]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                          <span className={`${base.kind} ${base.phoneOnly}`}>
                            {firstLine(pipeline.message)}
                          </span>
                        </th>
                        <td>
                          <CiStatusBadge status={pipeline.status} />
                        </td>
                        <td className={`${base.secondary} ${base.optional}`}>
                          {pipeline.event || "—"}
                        </td>
                        <td className={base.optional}>
                          {pipeline.branch || "—"}
                        </td>
                        <td className={base.optional}>
                          {pipeline.environment || "—"}
                        </td>
                        <td className={`${base.secondary} ${base.optional}`}>
                          <code>{shortCommit(pipeline.commit) || "—"}</code>
                        </td>
                        <td className={`${base.wrapCell} ${base.optional}`}>
                          <span className={styles.message}>
                            {firstLine(pipeline.message) || "—"}
                          </span>
                        </td>
                        <td className={`${base.secondary} ${base.optional}`}>
                          {f.date(isoOf(pipeline.started))}
                        </td>
                        <td className={base.secondary}>
                          {formatSeconds(
                            elapsedSeconds(
                              { ...pipeline, state: pipeline.status },
                              now,
                            ),
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className={base.meta}>{t("ciNoPipelines")}</p>
            )}
          </section>
        </div>
      )}
    </>
  );
}

type Row = { id: number; name: string; value: string };

function BuildForm({ id, data }: { id: number; data: CiRepoDetail }) {
  const { t } = usePreferences();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const listId = useId();
  const nextRow = useRef(1);
  const branches = branchOptions(data.branches, data.repo.defaultBranch);
  // Empty until the user picks one, so the default branch stays selected
  // even when the list refreshes.
  const [chosen, setChosen] = useState("");
  const branch = branches.includes(chosen) ? chosen : branches[0] || "";
  const [environment, setEnvironment] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [problem, setProblem] = useState<BuildProblem | null>(null);
  const trigger = useMutation({
    mutationFn: (body: BuildRequest) => ciApi.trigger(id, body),
    onSuccess: (pipeline) => {
      void cache.invalidateQueries({ queryKey: ["ci", "repo", id] });
      void cache.invalidateQueries({ queryKey: ["ci", "overview"] });
      navigate(`/ci/repos/${id}/pipelines/${pipeline.number}`);
    },
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    trigger.reset();
    const check = validateBuild({ branch, environment, variables: rows });
    if (!check.ok) {
      setProblem(check.problem);
      return;
    }
    setProblem(null);
    trigger.mutate(check.body);
  }
  const update = (rowId: number, change: Partial<Row>) =>
    setRows((current) =>
      current.map((row) => (row.id === rowId ? { ...row, ...change } : row)),
    );
  return (
    <section className={base.card}>
      <div className={base.heading}>
        <h2>{t("ciStartBuild")}</h2>
      </div>
      <form className={styles.form} onSubmit={submit} noValidate>
        <label>
          {t("ciBranch")}
          <select value={branch} onChange={(e) => setChosen(e.target.value)}>
            {branches.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("ciEnvironment")}
          <input
            list={listId}
            value={environment}
            maxLength={64}
            placeholder="production"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(e) => setEnvironment(e.target.value)}
          />
          <datalist id={listId}>
            {environmentSuggestions(data.pipelines).map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          <span className={styles.hint}>{t("ciEnvironmentHint")}</span>
        </label>
        <fieldset className={styles.variables}>
          <legend>{t("ciVariables")}</legend>
          {rows.map((row) => (
            <div key={row.id} className={styles.variable}>
              <input
                aria-label={t("ciVariableName")}
                placeholder={t("ciVariableNamePlaceholder")}
                value={row.name}
                maxLength={64}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                onChange={(e) => update(row.id, { name: e.target.value })}
              />
              <input
                aria-label={t("value")}
                placeholder={t("value")}
                value={row.value}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                onChange={(e) => update(row.id, { value: e.target.value })}
              />
              <button
                type="button"
                className="ghost"
                aria-label={t("ciRemoveVariable")}
                title={t("ciRemoveVariable")}
                onClick={() =>
                  setRows((current) => current.filter((r) => r.id !== row.id))
                }
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="text-button"
            disabled={rows.length >= MAX_VARIABLES}
            onClick={() =>
              setRows((current) => [
                ...current,
                { id: nextRow.current++, name: "", value: "" },
              ])
            }
          >
            + {t("ciAddVariable")}
          </button>
          <span className={styles.hint}>{t("ciVariablesHint")}</span>
        </fieldset>
        {problem && (
          <div className="error" role="alert">
            {t(problem.key, problem.values)}
          </div>
        )}
        <CiError error={trigger.error} />
        <div className={styles.formActions}>
          <button
            type="submit"
            className="primary"
            disabled={trigger.isPending || !branch}
          >
            {t(trigger.isPending ? "ciStarting" : "ciStartBuild")}
          </button>
        </div>
      </form>
    </section>
  );
}
