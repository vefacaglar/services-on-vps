import { describe, expect, it } from "vitest";
import { en, tr } from "../../lib/i18n";
import {
  branchOptions,
  ciStatuses,
  elapsedSeconds,
  environmentSuggestions,
  firstLine,
  formatSeconds,
  isActive,
  isoOf,
  logKind,
  parseId,
  pickStep,
  shortCommit,
  statusKey,
  statusTone,
  validateBuild,
  variableNameProblem,
  type CiStatus,
  type CiStep,
  type CiWorkflow,
} from "./ci";

const step = (id: number, state: CiStatus): CiStep => ({
  id,
  name: `step-${id}`,
  state,
  type: "commands",
  started: 0,
  finished: 0,
  exitCode: 0,
  error: "",
});
const workflow = (id: number, steps: CiStep[]): CiWorkflow => ({
  id,
  name: `workflow-${id}`,
  state: "running",
  started: 0,
  finished: 0,
  error: "",
  steps,
});
const build = (over: Partial<Parameters<typeof validateBuild>[0]> = {}) =>
  validateBuild({ branch: "main", environment: "", variables: [], ...over });
const problemOf = (check: ReturnType<typeof validateBuild>) =>
  check.ok ? null : check.problem.key;

describe("ci status helpers", () => {
  it("treats only pending, running, created and blocked as active", () => {
    expect(ciStatuses.filter(isActive)).toEqual([
      "pending",
      "running",
      "blocked",
      "created",
    ]);
    expect(isActive(undefined)).toBe(false);
    expect(isActive("something-new")).toBe(false);
  });
  it("maps every status to a tone and a label in both languages", () => {
    expect(statusTone("success")).toBe("ok");
    for (const status of ["failure", "error", "killed"])
      expect(statusTone(status)).toBe("bad");
    expect(statusTone("running")).toBe("run");
    for (const status of ["pending", "created", "blocked"])
      expect(statusTone(status)).toBe("wait");
    for (const status of ["skipped", "canceled", "declined"])
      expect(statusTone(status)).toBe("off");
    for (const status of ciStatuses) {
      const key = statusKey(status);
      expect(key).not.toBeNull();
      expect(en[key!]).toBeTruthy();
      expect(tr[key!]).toBeTruthy();
    }
  });
  it("keeps unknown statuses neutral and unlabelled", () => {
    expect(statusTone("paused")).toBe("off");
    expect(statusKey("paused")).toBeNull();
    expect(statusKey("toString")).toBeNull();
  });
});

describe("ci time helpers", () => {
  it("measures finished items and counts active ones up to now", () => {
    expect(
      elapsedSeconds({ started: 100, finished: 165, state: "success" }, 999),
    ).toBe(65);
    expect(
      elapsedSeconds({ started: 100, finished: 0, state: "running" }, 130),
    ).toBe(30);
  });
  it("has no duration before the start or for an unfinished inactive item", () => {
    expect(
      elapsedSeconds({ started: 0, finished: 0, state: "pending" }, 130),
    ).toBeNull();
    expect(
      elapsedSeconds({ started: 100, finished: 0, state: "killed" }, 130),
    ).toBeNull();
  });
  it("never goes negative when clocks disagree", () => {
    expect(
      elapsedSeconds({ started: 100, finished: 0, state: "running" }, 90),
    ).toBe(0);
    expect(
      elapsedSeconds({ started: 100, finished: 95, state: "success" }, 0),
    ).toBe(0);
  });
  it("formats seconds, minutes and hours", () => {
    expect(formatSeconds(null)).toBe("—");
    expect(formatSeconds(0)).toBe("0 s");
    expect(formatSeconds(59)).toBe("59 s");
    expect(formatSeconds(60)).toBe("1 min 0 s");
    expect(formatSeconds(125)).toBe("2 min 5 s");
    expect(formatSeconds(3600)).toBe("1 h 0 min");
    expect(formatSeconds(3725)).toBe("1 h 2 min");
  });
  it("turns unix seconds into ISO and 0 into not set", () => {
    expect(isoOf(0)).toBeNull();
    expect(isoOf(1795000000)).toBe(new Date(1795000000000).toISOString());
  });
});

describe("ci display helpers", () => {
  it("shortens commits and keeps the first message line", () => {
    expect(shortCommit("0123456789abcdef")).toBe("0123456");
    expect(shortCommit("")).toBe("");
    expect(firstLine("\nFix deploy\r\n\r\nLong body")).toBe("Fix deploy");
    expect(firstLine("")).toBe("");
  });
  it("names log line types and falls back to stdout", () => {
    expect([0, 1, 2, 3, 4].map(logKind)).toEqual([
      "stdout",
      "stderr",
      "exit",
      "meta",
      "progress",
    ]);
    expect(logKind(9)).toBe("stdout");
    expect(logKind(-1)).toBe("stdout");
  });
  it("accepts only positive integer route ids", () => {
    expect(parseId("12")).toBe(12);
    for (const value of [undefined, "", "0", "01", "-1", "1.5", "abc", "1e3"])
      expect(parseId(value)).toBeNull();
  });
});

describe("ci build form helpers", () => {
  it("suggests production and staging, then environments already used", () => {
    expect(environmentSuggestions([])).toEqual(["production", "staging"]);
    expect(
      environmentSuggestions([
        { environment: "preview" },
        { environment: "" },
        { environment: "staging" },
        { environment: " preview " },
        { environment: "qa" },
      ]),
    ).toEqual(["production", "staging", "preview", "qa"]);
  });
  it("lists the default branch first without duplicates", () => {
    expect(branchOptions(["dev", "main", "feature/x"], "main")).toEqual([
      "main",
      "dev",
      "feature/x",
    ]);
    expect(branchOptions([], "main")).toEqual(["main"]);
    expect(branchOptions(["dev"], "")).toEqual(["dev"]);
  });
  it("selects the running step, else the first failed, else the first", () => {
    expect(pickStep(undefined)).toBeNull();
    expect(pickStep([workflow(1, [])])).toBeNull();
    expect(
      pickStep([
        workflow(1, [step(1, "success"), step(2, "failure")]),
        workflow(2, [step(3, "running"), step(4, "pending")]),
      ])?.id,
    ).toBe(3);
    expect(
      pickStep([
        workflow(1, [step(1, "success"), step(2, "killed")]),
        workflow(2, [step(3, "error")]),
      ])?.id,
    ).toBe(2);
    expect(
      pickStep([workflow(1, [step(1, "success"), step(2, "skipped")])])?.id,
    ).toBe(1);
  });
});

describe("ci build validation", () => {
  it("trims the request and drops empty variable rows", () => {
    expect(
      build({
        branch: " main ",
        environment: " production ",
        variables: [
          { name: "", value: "" },
          { name: " TAG ", value: " v1 " },
          { name: "_EMPTY", value: "" },
        ],
      }),
    ).toEqual({
      ok: true,
      body: {
        branch: "main",
        environment: "production",
        variables: { TAG: " v1 ", _EMPTY: "" },
      },
    });
  });
  it("requires a branch of at most 255 characters", () => {
    expect(problemOf(build({ branch: "  " }))).toBe("ciBranchRequired");
    expect(problemOf(build({ branch: "b".repeat(256) }))).toBe(
      "ciBranchTooLong",
    );
    expect(build({ branch: "b".repeat(255) }).ok).toBe(true);
  });
  it("accepts an empty environment and rejects malformed ones", () => {
    expect(build({ environment: "" }).ok).toBe(true);
    for (const environment of ["prod-1", "eu.west_2", "a".repeat(64)])
      expect(build({ environment }).ok).toBe(true);
    for (const environment of ["-prod", ".x", "has space", "a".repeat(65), "é"])
      expect(problemOf(build({ environment }))).toBe("ciInvalidEnvironment");
  });
  it("checks variable names like the server", () => {
    expect(variableNameProblem("TAG_1")).toBeNull();
    expect(variableNameProblem("_x")).toBeNull();
    expect(variableNameProblem("ci_lower")).toBeNull();
    expect(variableNameProblem("DEPLOY_ENV_2")).toBeNull();
    for (const name of ["1TAG", "MY-VAR", "A B", "", "A".repeat(65)])
      expect(variableNameProblem(name)).toBe("ciInvalidVariableName");
    for (const name of ["CI_COMMIT", "WOODPECKER_TOKEN", "DEPLOY_ENV"])
      expect(variableNameProblem(name)).toBe("ciReservedVariable");
  });
  it("reports the offending variable", () => {
    expect(build({ variables: [{ name: "", value: "orphan" }] })).toEqual({
      ok: false,
      problem: { key: "ciVariableNameRequired", values: undefined },
    });
    expect(build({ variables: [{ name: "CI_X", value: "1" }] })).toEqual({
      ok: false,
      problem: { key: "ciReservedVariable", values: { name: "CI_X" } },
    });
    expect(
      build({
        variables: [
          { name: "TAG", value: "1" },
          { name: "TAG", value: "2" },
        ],
      }),
    ).toEqual({
      ok: false,
      problem: { key: "ciDuplicateVariable", values: { name: "TAG" } },
    });
  });
  it("limits variable values and count", () => {
    expect(
      build({ variables: [{ name: "A", value: "x".repeat(4096) }] }).ok,
    ).toBe(true);
    expect(
      problemOf(build({ variables: [{ name: "A", value: "x".repeat(4097) }] })),
    ).toBe("ciInvalidVariableValue");
    expect(
      problemOf(build({ variables: [{ name: "A", value: "a\0b" }] })),
    ).toBe("ciInvalidVariableValue");
    const rows = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ name: `V${i}`, value: "" }));
    expect(build({ variables: rows(20) }).ok).toBe(true);
    expect(problemOf(build({ variables: rows(21) }))).toBe(
      "ciTooManyVariables",
    );
  });
});
