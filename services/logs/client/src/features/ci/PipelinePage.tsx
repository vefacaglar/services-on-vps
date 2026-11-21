import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { usePreferences } from "../../app/Preferences";
import base from "../meilisearch/Meilisearch.module.css";
import {
  ciApi,
  elapsedSeconds,
  formatSeconds,
  isActive,
  isoOf,
  logKind,
  parseId,
  pickStep,
  shortCommit,
  type CiPipeline,
  type CiStep,
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

const POLL = 3000;

export default function PipelinePage() {
  const params = useParams();
  const id = parseId(params.id);
  const number = parseId(params.number);
  if (id == null) return <Navigate replace to="/ci" />;
  if (number == null) return <Navigate replace to={`/ci/repos/${id}`} />;
  return <Pipeline key={`${id}/${number}`} id={id} number={number} />;
}

function Pipeline({ id, number }: { id: number; number: number }) {
  const { t } = usePreferences();
  const f = useFormat();
  const cache = useQueryClient();
  const detail = useQuery({
    queryKey: ["ci", "pipeline", id, number],
    queryFn: ({ signal }) => ciApi.pipeline(id, number, signal),
    refetchInterval: (query) =>
      isActive(query.state.data?.pipeline.status) ? POLL : false,
    refetchIntervalInBackground: false,
  });
  const cancel = useMutation({
    mutationFn: () => ciApi.cancel(id, number),
    onSuccess: () => {
      void detail.refetch();
      void cache.invalidateQueries({ queryKey: ["ci", "repo", id] });
    },
  });
  const pipeline = detail.data?.pipeline;
  const repo = detail.data?.repo;
  const live = isActive(pipeline?.status);
  const now = useNow(live);
  useWake(live, detail.refetch);
  // Follows the running step until the user picks one.
  const [chosen, setChosen] = useState<number | null>(null);
  const steps = (pipeline?.workflows || []).flatMap((w) => w.steps || []);
  const step =
    steps.find((s) => s.id === chosen) || pickStep(pipeline?.workflows);
  return (
    <>
      <CiHeading
        title={`${t("ciPipeline")} #${number}`}
        eyebrow={repo?.fullName || t("ciPipeline")}
      >
        <Link to={`/ci/repos/${id}`} className={base.back}>
          ← {t("ciBackToRepo")}
        </Link>
        <RefreshButton
          busy={detail.isFetching}
          onClick={() => void detail.refetch()}
        />
        {live && (
          <button
            className="ghost"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate()}
          >
            {t(cancel.isPending ? "ciCanceling" : "ciCancelPipeline")}
          </button>
        )}
      </CiHeading>
      <CiError error={detail.error} />
      <CiError error={cancel.error} />
      {detail.isPending && <p className={base.meta}>{t("loading")}</p>}
      {pipeline && (
        <div className={base.page}>
          <section className={base.card}>
            <dl className={base.stats}>
              <div>
                <dt>{t("status")}</dt>
                <dd className={base.small}>
                  <CiStatusBadge status={pipeline.status} />
                </dd>
              </div>
              <div>
                <dt>{t("ciBranch")}</dt>
                <dd className={base.small}>{pipeline.branch || "—"}</dd>
              </div>
              <div>
                <dt>{t("ciEnvironment")}</dt>
                <dd className={base.small}>{pipeline.environment || "—"}</dd>
              </div>
              <div>
                <dt>{t("ciCommit")}</dt>
                <dd className={base.small}>
                  {pipeline.forgeUrl ? (
                    <a
                      href={pipeline.forgeUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={t("ciViewOnForge")}
                    >
                      <code>{shortCommit(pipeline.commit) || "—"}</code> ↗
                    </a>
                  ) : (
                    <code>{shortCommit(pipeline.commit) || "—"}</code>
                  )}
                </dd>
              </div>
              <div>
                <dt>{t("ciStarted")}</dt>
                <dd className={base.small}>
                  {f.date(isoOf(pipeline.started || pipeline.created))}
                </dd>
              </div>
              <div>
                <dt>{t("duration")}</dt>
                <dd className={base.small}>
                  {formatSeconds(
                    elapsedSeconds(
                      { ...pipeline, state: pipeline.status },
                      now,
                    ),
                  )}
                </dd>
              </div>
            </dl>
            {pipeline.message.trim() && (
              <pre className={styles.commitMessage}>
                {pipeline.message.trim()}
              </pre>
            )}
            <p className={base.help}>
              {[
                pipeline.event,
                pipeline.author,
                pipeline.finished > 0 &&
                  `${t("ciFinished")} ${f.date(isoOf(pipeline.finished))}`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            <Variables pipeline={pipeline} />
            {pipeline.errors?.length > 0 && (
              <ul className={styles.errors} aria-label={t("ciPipelineErrors")}>
                {pipeline.errors.map((error, index) => (
                  <li
                    key={index}
                    className={error.isWarning ? styles.warn : styles.bad}
                  >
                    {error.isWarning && `${t("ciWarning")}: `}
                    {error.message}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className={styles.split}>
            <section className={`${base.card} ${styles.steps}`}>
              <div className={base.heading}>
                <h2>{t("ciWorkflows")}</h2>
                {live && <span>{t("ciLive")}</span>}
              </div>
              {steps.length === 0 && (
                <p className={base.meta}>{t("ciNoSteps")}</p>
              )}
              {(pipeline.workflows || []).map((workflow) => (
                <div key={workflow.id} className={styles.workflow}>
                  <h3>
                    <span>{workflow.name}</span>
                    <CiStatusBadge status={workflow.state} />
                  </h3>
                  {workflow.error && (
                    <p className={styles.stepError}>{workflow.error}</p>
                  )}
                  <ul>
                    {(workflow.steps || []).map((item) => (
                      <li key={item.id}>
                        <button
                          type="button"
                          aria-pressed={step?.id === item.id}
                          onClick={() => setChosen(item.id)}
                        >
                          <span className={styles.stepName}>{item.name}</span>
                          <CiStatusBadge status={item.state} />
                          <span className={styles.stepMeta}>
                            {formatSeconds(elapsedSeconds(item, now))}
                            {item.exitCode !== 0 &&
                              ` · ${t("ciExitCode", { code: item.exitCode })}`}
                          </span>
                          {item.error && (
                            <span className={styles.stepError}>
                              {item.error}
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
            {step ? (
              <StepLog
                key={step.id}
                id={id}
                number={number}
                step={step}
                pipelineStatus={pipeline.status}
              />
            ) : (
              <section className={`${base.card} ${styles.log}`}>
                <p className={base.meta}>{t("ciSelectStep")}</p>
              </section>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function Variables({ pipeline }: { pipeline: CiPipeline }) {
  const { t } = usePreferences();
  const entries = Object.entries(pipeline.variables || {});
  if (!entries.length) return null;
  return (
    <ul className={base.chips} aria-label={t("ciVariables")}>
      {entries.map(([name, value]) => (
        <li key={name}>
          {name}=<code>{value}</code>
        </li>
      ))}
    </ul>
  );
}

function StepLog({
  id,
  number,
  step,
  pipelineStatus,
}: {
  id: number;
  number: number;
  step: CiStep;
  pipelineStatus: string;
}) {
  const { t } = usePreferences();
  const live = isActive(pipelineStatus);
  // The states are part of the key so a step or pipeline that just finished
  // gets one last read after polling stops.
  const log = useQuery({
    queryKey: ["ci", "log", id, number, step.id, step.state, pipelineStatus],
    queryFn: ({ signal }) => ciApi.log(id, number, step.id, signal),
    placeholderData: keepPreviousData,
    refetchInterval: live ? POLL : false,
    refetchIntervalInBackground: false,
  });
  const box = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  const count = log.data?.lines.length || 0;
  useLayoutEffect(() => {
    const element = box.current;
    if (element && follow.current) element.scrollTop = element.scrollHeight;
  }, [count]);
  useWake(live, log.refetch);
  return (
    <section className={`${base.card} ${styles.log}`}>
      <div className={base.heading}>
        <h2>
          {t("ciLog")} · {step.name}
        </h2>
        <CiStatusBadge status={step.state} />
      </div>
      {step.error && <p className={styles.stepError}>{step.error}</p>}
      <CiError error={log.error} />
      {log.isPending && <p className={base.meta}>{t("loading")}</p>}
      {log.data?.truncated && (
        <p className={base.note} role="note">
          {t("ciLogTruncated")}
        </p>
      )}
      {log.data &&
        (count ? (
          <pre
            ref={box}
            className={styles.lines}
            tabIndex={0}
            aria-label={`${t("ciLog")} · ${step.name}`}
            onScroll={(e) => {
              const el = e.currentTarget;
              follow.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
          >
            {log.data.lines.map((line, index) => {
              const kind = logKind(line.type);
              return (
                <span key={index} className={`${styles.line} ${styles[kind]}`}>
                  <span className={styles.lineNumber} aria-hidden="true">
                    {line.line + 1}
                  </span>
                  <span>
                    {kind === "exit"
                      ? t("ciExitCode", { code: line.text.trim() })
                      : line.text.replace(/\r?\n$/, "")}
                  </span>
                  {"\n"}
                </span>
              );
            })}
          </pre>
        ) : (
          <p className={base.meta}>
            {t(isActive(step.state) ? "ciNoLog" : "ciNoLogFinished")}
          </p>
        ))}
    </section>
  );
}
