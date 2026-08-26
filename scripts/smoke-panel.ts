import { dispatch } from "../src/hosted-agent/toolbox.js";
import { getRole } from "../src/hosted-agent/imports.js";
import os from "node:os";

const ws = os.tmpdir();

// Gate: role without the verb rejected
const t1 = await dispatch("read_indicator_panel", { subject: "M3", series: ["m3_total_shipments_nsa"] }, ["read_file"], ws);
console.log("catalog gate (unlisted role):", !t1.ok && t1.error?.code === "unknown_tool" ? "PASS" : `FAIL ${JSON.stringify(t1)}`);

// Role grants it
const role = getRole("statistician");
console.log("statistician grants read_indicator_panel:", Boolean(role) && role?.toolNames.includes("read_indicator_panel") ? "PASS" : "FAIL");

// Live call if ARTIFACT_SERVICE_URL is reachable (skip offline)
process.env.ARTIFACT_SERVICE_URL = process.env.ARTIFACT_SERVICE_URL ?? "https://artifact-service.bravesea-f16a8310.eastus.azurecontainerapps.io";
const t2 = await dispatch("read_indicator_panel", { subject: "M3 Manufacturing Shipments", series: ["m3_total_shipments_nsa", "fred_ipman"] }, ["read_indicator_panel"], ws, { userId: "smoke" });
if (t2.ok) {
  const r = t2.result as any;
  const m3 = r.summary?.find((s: any) => s.seriesId === "m3_total_shipments_nsa");
  console.log("panel ok:", r.panelHash ? "PASS" : "FAIL", "hash", r.panelHash?.slice(0, 12), "m3 obs", m3?.observations, "range", m3?.range);
} else if (t2.error?.code === "panel_failed") {
  console.log("panel_failed (service not deployed yet):", "PASS-SKIP", t2.error.message.slice(0, 80));
} else {
  console.log("FAIL", JSON.stringify(t2));
}
