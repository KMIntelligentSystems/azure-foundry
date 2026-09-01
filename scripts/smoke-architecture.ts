import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatch } from "../src/hosted-agent/toolbox.js";
import { getRole } from "../src/hosted-agent/imports.js";
import { listSkills, readSkill } from "../src/hosted-agent/skills.js";
import { validatePlan } from "../src/hosted-agent/validate_plan.js";

let failed = false;
const check = (name: string, condition: boolean, detail = "") => {
  console.log(`${condition ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failed = true;
};

const statistician = getRole("statistician");
check("statistician role loads from hosted-agent/agents", Boolean(statistician));
check("statistician can list skills", statistician?.toolNames.includes("list_skills") === true);
check("statistician can read skills", statistician?.toolNames.includes("read_skill") === true);
check("statistician can execute Python", statistician?.toolNames.includes("execute_python") === true);
check("panel staging is not a separate statistician tool", statistician?.toolNames.includes("read_indicator_panel") === false);

const skills = listSkills();
check("skill catalogue loads", skills.length > 0, `${skills.length} skills`);
check("leading-indicator skill is indexed", skills.some((skill) => skill.name === "leading-indicator-panel"));
const panelSkill = readSkill("leading-indicator-panel")?.content ?? "";
check("leading-indicator skill fixes staged schema", panelSkill.includes('payload["rows"]') && panelSkill.includes('row["seriesId"]'));
check("leading-indicator skill defines YoY log growth", panelSkill.includes('np.log(series["value"]) - np.log(series["value"].shift(12))'));
check("ADL skill is indexed", skills.some((skill) => skill.name === "adl-monthly-nowcast"));
const adlSkill = readSkill("adl-monthly-nowcast")?.content ?? "";
check("ADL skill is readable", adlSkill.includes("28 features total"));
check("ADL skill requires long-to-wide pivot", adlSkill.includes('panel.pivot(index="date", columns="series_id", values="value")'));
check("ADL skill validates all required series before modeling", adlSkill.includes('required series absent from staged panel'));
check("ADL skill constructs target from wide frame", adlSkill.includes('wide["m3_total_shipments_nsa"]'));

const verdict = validatePlan({
  rationale: "Resolve prompt before downstream planning",
  continuePlanning: true,
  steps: [{ role: "reader", task: "Read the named prompt artifact and return its complete contents.", deployment: "gpt-4.1-mini" }],
});
check("validator preserves iterative continuation", verdict.ok && verdict.plan.continuePlanning);

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "azure-foundry-stage-"));
const python = await dispatch("execute_python", {
  code: "import json\nwith open('inputs/panel.json') as f: p=json.load(f)\nprint(json.dumps({'series':len(p['rows']),'hash':p['panelHash'][:12]}))",
  stage_indicator_panel: {
    subject: "M3 Manufacturing Shipments",
    series: ["m3_total_shipments_nsa", "fred_ipman"],
    path: "inputs/panel.json",
  },
}, ["execute_python"], ws, { userId: "admin" });
check("execute_python stages the raw panel", python.ok, python.ok ? "" : JSON.stringify(python.error));
if (python.ok) {
  const result = python.result as { stagedInput?: { observations: number; panelHash: string }; stdout?: string };
  check("tool result exposes staging metadata", Boolean(result.stagedInput?.panelHash) && (result.stagedInput?.observations ?? 0) > 0);
  check("Python read staged values", result.stdout?.includes('"series": 2') === true, result.stdout ?? "");
  const staged = JSON.parse(fs.readFileSync(path.join(ws, "inputs", "panel.json"), "utf8"));
  check("workspace file contains raw observations", staged.rows?.[0]?.observations?.[0]?.value !== undefined);
  check("raw observations are not echoed in tool result", JSON.stringify(result).includes('"date":"2002-01"') === false);
}
fs.rmSync(ws, { recursive: true, force: true });

process.exit(failed ? 1 : 0);
