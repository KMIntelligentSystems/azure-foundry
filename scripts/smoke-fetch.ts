import { dispatch } from "../src/hosted-agent/toolbox.js";
import os from "node:os";

const ws = os.tmpdir();
const allow = ["fetch_url"];

const r1 = await dispatch("fetch_url", { url: "https://daemonstore.blob.core.windows.net/prompts/aug-2026-ADL.md?sp=r&st=2026-08-25T07:23:10Z&se=2027-10-31T14:38:10Z&spr=https&sv=2026-02-06&sr=b&sig=gqZ0DD%2BG0UxtSV%2B1qE8CpduMWLeWnpt7uBtDa7kehGo%3D" }, allow, ws);
console.log("blob fetch:", r1.ok, (r1.result as any)?.bytes, (r1.result as any)?.contentType, JSON.stringify((r1.result as any)?.content.slice(0, 60)));

const r2 = await dispatch("fetch_url", { url: "http://169.254.169.254/metadata/instance" }, allow, ws);
console.log("imds refused:", !r2.ok, r2.error?.code);

const r3 = await dispatch("fetch_url", { url: "ftp://example.com/x" }, allow, ws);
console.log("ftp refused:", !r3.ok, r3.error?.code);

const r4 = await dispatch("fetch_url", { url: "https://example.com/" }, ["read_file"], ws);
console.log("catalog gate:", !r4.ok, r4.error?.code);

process.env.FETCH_URL_ALLOWLIST = "example.com";
const r5 = await dispatch("fetch_url", { url: "https://daemonstore.blob.core.windows.net/prompts/aug-2026-ADL.md" }, allow, ws);
console.log("allowlist refuses off-list host:", !r5.ok, r5.error?.code);
