/**
 * refresh-sync smoke: the toolbox's sync_indicator_history tool → stub artifact
 * service. Proves:
 *   1. dispatch forwards {dryRun} and the admin role header, returns the report.
 *   2. A role whose catalog lacks the tool is rejected at the airlock gate.
 *   3. Non-OK HTTP from the service surfaces as sync_failed.
 *   4. getRole("operator") registers the new role (planner can route to it).
 */
import http from "node:http";
import { dispatch } from "../src/hosted-agent/toolbox.js";
import { getRole } from "../src/hosted-agent/imports.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let passed = 0, failed = 0;
const check = (name: string, cond: boolean, detail = "") =>
  cond ? (passed++, console.log(`${name}: PASS`)) : (failed++, console.log(`${name}: FAIL ${detail}`));

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "wstest-"));

// Stub artifact service — only /refresh-sync matters here.
const hits: { body: any; role: string | undefined; dryRun: any }[] = [];
let failOnce = false;
const svc = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (req.url === "/refresh-sync" && req.method === "POST") {
      if (failOnce) {
        failOnce = false;
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "upstream" }));
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      hits.push({ body, role: req.headers["x-user-role"] as string | undefined, dryRun: body.dryRun });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, dryRun: body.dryRun === true, series: [{ seriesId: "test", status: "sent" }] }));
      return;
    }
    res.writeHead(404).end();
  });
});
await new Promise<void>((r) => svc.listen(0, r as () => void));
const port = (svc.address() as { port: number }).port;
process.env["ARTIFACT_SERVICE_URL"] = `http://127.0.0.1:${port}`;

// 1. full dispatch through a role that lists the tool
const rep = await dispatch("sync_indicator_history", { dryRun: true }, ["sync_indicator_history"], ws, { userId: "u1" });
check("dispatch ok", rep.ok === true, JSON.stringify(rep));
check("admin role header", hits[hits.length - 1]?.role === "admin");
check("dryRun forwarded", hits[hits.length - 1]?.dryRun === true);

// 2. airlock gate — role without the tool
const denied = await dispatch("sync_indicator_history", {}, ["read_file"], ws);
check("catalog gate", !denied.ok && denied.error?.code === "unknown_tool", JSON.stringify(denied));

// 3. non-OK HTTP surfaces as sync_failed
failOnce = true;
const bad = await dispatch("sync_indicator_history", { dryRun: false }, ["sync_indicator_history"], ws);
check("sync_failed on non-OK", !bad.ok && bad.error?.code === "sync_failed", JSON.stringify(bad.error));

// 4. role registration
const role = getRole("operator");
check("operator role registered", Boolean(role) && role?.toolNames.includes("sync_indicator_history"));

// Windows Node 24: undici keep-alive handles crash process.exit unless given
// a drain tick. Wait so the uv assertion (exit 127) can't race the exit.
console.log(`\n${passed} passed, ${failed} failed`);
await new Promise((r) => setTimeout(r, 500));
svc.close();
fs.rmSync(ws, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
