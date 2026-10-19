#!/usr/bin/env node
// Dottie Week-1 auth go/no-go probe (Stage A). Node >= 20, no dependencies.
// Talks to the official `codex app-server --listen stdio://` only. Never reads, prints or copies credential files or tokens.
// Usage:
//   node dottie-week1-probe.mjs status
//   node dottie-week1-probe.mjs signin [--device] [--no-open] [--cancel-after SECONDS]
//   node dottie-week1-probe.mjs task "Reply with the word OK." [--thread THREAD_ID]
//   node dottie-week1-probe.mjs resume THREAD_ID
//   node dottie-week1-probe.mjs logout
// Env: CODEX_BIN (path to codex/codex.exe, default "codex"), CODEX_HOME (required: a dedicated test dir), PROBE_OUT (evidence dir, default ./evidence)
// Pass extra `-c key=value` config overrides via PROBE_CODEX_ARGS, e.g. PROBE_CODEX_ARGS='-c cli_auth_credentials_store="keyring"'
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
if (!["status", "signin", "task", "resume", "logout"].includes(cmd)) { console.error("usage: status|signin|task|resume|logout"); process.exit(2); }
if (!process.env.CODEX_HOME) { console.error("Refusing: set CODEX_HOME to a dedicated test directory (ADR-0004)."); process.exit(2); }

const outDir = process.env.PROBE_OUT || "evidence";
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const logFile = join(outDir, `${stamp}-${cmd}.jsonl`);

// Redaction: never persist OAuth query params, device codes, emails, host names.
function redact(obj) {
  const s = JSON.stringify(obj, (k, v) => {
    if (typeof v !== "string") return v;
    if (k === "authUrl" || k === "verificationUrl") { try { const u = new URL(v); return `${u.origin}${u.pathname}?<redacted>`; } catch { return "<redacted>"; } }
    if (["userCode", "email", "serverName", "installationId", "access_token", "refresh_token", "id_token", "accessToken", "refreshToken", "idToken"].includes(k)) return "<redacted>";
    return v.replace(/[A-Za-z0-9-_]{20,}\.[A-Za-z0-9-_]{20,}\.[A-Za-z0-9-_]{10,}/g, "<redacted-jwt>");
  });
  return JSON.parse(s);
}
const log = (dir, msg) => appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), dir, msg: redact(msg) }) + "\n");

// Env scrub: an API key must never silently become the auth method (spec §5).
const env = { ...process.env };
for (const k of ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "ACCESS_TOKEN"]) delete env[k];
const extra = (process.env.PROBE_CODEX_ARGS || "").match(/(?:[^\s"]+|"[^"]*")+/g) || [];
const bin = process.env.CODEX_BIN || "codex";
const child = spawn(bin, [...extra, "app-server", "--listen", "stdio://"], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
child.stderr.on("data", (d) => appendFileSync(logFile.replace(/\.jsonl$/, ".stderr.txt"), d));
child.on("exit", (code) => { log("exit", { code }); });

let nextId = 1; const pending = new Map(); const waiters = [];
function send(method, params) {
  const id = nextId++; const msg = params === undefined ? { method, id } : { method, id, params };
  log(">>", msg); child.stdin.write(JSON.stringify(msg) + "\n");
  return new Promise((res, rej) => pending.set(id, { res, rej, method }));
}
function notify(method, params) { const m = { method, params }; log(">>", m); child.stdin.write(JSON.stringify(m) + "\n"); }
function waitFor(pred, ms) {
  return new Promise((res, rej) => { const w = { pred, res }; waiters.push(w);
    setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); rej(new Error(`timeout after ${ms} ms`)); } }, ms); });
}
createInterface({ input: child.stdout }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { log("<<raw", { line: line.slice(0, 500) }); return; }
  log("<<", m);
  if (m.id !== undefined && m.method) { // server -> client request: fail closed (ADR-0009)
    const deny = m.method.endsWith("requestApproval") && !m.method.startsWith("item/permissions") ? { decision: "decline" }
      : m.method === "mcpServer/elicitation/request" ? { action: "decline" } : null;
    const reply = deny ? { id: m.id, result: deny } : { id: m.id, error: { code: -32601, message: "Dottie probe: not supported" } };
    log(">>", reply); child.stdin.write(JSON.stringify(reply) + "\n");
    console.log(`[probe] server request ${m.method} -> denied`); return;
  }
  if (m.id !== undefined && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(Object.assign(new Error(m.error.message), { rpc: m.error })) : p.res(m.result); return; }
  if (m.method === "item/agentMessage/delta") process.stdout.write(m.params?.delta ?? "");
  for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); }
});

function summarizeAccount(r) {
  const a = r?.account;
  if (!a) return `signedOut (requiresOpenaiAuth=${r?.requiresOpenaiAuth})`;
  return a.type === "chatgpt" ? `signedIn type=chatgpt planType=${a.planType} email=${a.email ? "<present>" : "<null>"}` : `account type=${a.type} (NOT chatgpt)`;
}
function openBrowser(url) {
  if (!url.startsWith("https://auth.openai.com/")) throw new Error("authUrl failed prefix check; not opening");
  if (process.platform === "win32") spawn("rundll32", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  else console.log("[probe] not Windows; open manually");
}

async function main() {
  const init = await send("initialize", { clientInfo: { name: "dottie_week1_probe", title: "Dottie Week-1 Probe", version: "0.0.1" } });
  notify("initialized", {});
  console.log(`[probe] initialize ok: platform=${init.platformFamily}/${init.platformOs} codexHome=${init.codexHome}`);
  const acct = await send("account/read", { refreshToken: false });
  console.log(`[probe] account/read: ${summarizeAccount(acct)}`);
  let verdict = "INFO";

  if (cmd === "status") {
    const r2 = await send("account/read", { refreshToken: true }).catch((e) => ({ error: e.message }));
    console.log(`[probe] account/read(refreshToken=true): ${r2.error ? "error " + r2.error : summarizeAccount(r2)}`);
    verdict = acct?.account?.type === "chatgpt" ? "PASS" : "FAIL";
  } else if (cmd === "signin") {
    const updP = waitFor((m) => m.method === "account/updated", 10 * 60 * 1000 + 5000).catch(() => null);
    const r = await send("account/login/start", { type: flag("--device") ? "chatgptDeviceCode" : "chatgpt" });
    if (r.authUrl) { console.log(`[probe] loginId=${r.loginId}\n[probe] authUrl (do not share): ${r.authUrl}`); if (!flag("--no-open")) openBrowser(r.authUrl); }
    if (r.verificationUrl) console.log(`[probe] device code: open ${r.verificationUrl} and enter ${r.userCode}`);
    const cancelAfter = Number(opt("--cancel-after") || 0);
    if (cancelAfter) setTimeout(() => send("account/login/cancel", { loginId: r.loginId }).then((x) => console.log(`[probe] cancel -> ${x.status}`)), cancelAfter * 1000);
    const done = await waitFor((m) => m.method === "account/login/completed" && (!m.params.loginId || m.params.loginId === r.loginId), 10 * 60 * 1000);
    console.log(`[probe] account/login/completed success=${done.params.success} error=${done.params.error ?? ""}`);
    const upd = await Promise.race([updP, new Promise((r) => setTimeout(() => r(null), 5000))]);
    console.log(upd ? `[probe] account/updated authMode=${upd.params.authMode} planType=${upd.params.planType}` : "[probe] (no account/updated within 5 s of completion)");
    const after = await send("account/read", {});
    console.log(`[probe] account/read after login: ${summarizeAccount(after)}`);
    verdict = done.params.success && after?.account?.type === "chatgpt" ? "PASS" : "FAIL";
  } else if (cmd === "task" || cmd === "resume") {
    if (acct?.account?.type !== "chatgpt" && !flag("--ungated")) { console.log("[probe] AUTH_REQUIRED: refusing to start a turn (ADR-0010 gate). Run signin first."); verdict = "FAIL"; }
    else {
      let threadId = cmd === "resume" ? argv[1] : opt("--thread");
      if (threadId) { const t = await send("thread/resume", { threadId }); console.log(`[probe] thread/resume ok id=${t.thread.id} turns=${t.thread.turns?.length ?? "?"}`); }
      else { const t = await send("thread/start", { cwd: process.cwd(), approvalPolicy: "on-request", sandbox: "read-only" }); threadId = t.thread.id; console.log(`[probe] thread/start id=${threadId} sandbox=${t.sandbox?.type} approval=${t.approvalPolicy}`); }
      const text = cmd === "resume" ? (argv[2] || "What was my previous message? Answer in one short sentence.") : (argv[1] || "Reply with the word OK.");
      const tr = await send("turn/start", { threadId, input: [{ type: "text", text }] });
      console.log(`[probe] turn/start id=${tr.turn.id}`);
      const done = await waitFor((m) => m.method === "turn/completed" && m.params.threadId === threadId, 5 * 60 * 1000);
      const st = done.params.turn.status;
      console.log(`\n[probe] turn/completed status=${st} error=${done.params.turn.error ? JSON.stringify(done.params.turn.error.codexErrorInfo) : "none"}`);
      console.log(`[probe] THREAD_ID=${threadId}`);
      verdict = st === "completed" ? "PASS" : "FAIL";
    }
  } else if (cmd === "logout") {
    const upd = waitFor((m) => m.method === "account/updated", 5000); // register before sending (race)
    await send("account/logout");
    await upd.then((m) => console.log(`[probe] account/updated authMode=${m.params.authMode}`)).catch(() => console.log("[probe] (no account/updated)"));
    const after = await send("account/read", {});
    console.log(`[probe] account/read after logout: ${summarizeAccount(after)}`);
    verdict = after?.account == null ? "PASS" : "FAIL";
  }
  console.log(`[probe] RESULT ${cmd}: ${verdict}   transcript: ${logFile}`);
  child.stdin.end(); setTimeout(() => { child.kill(); process.exit(verdict === "FAIL" ? 1 : 0); }, 1500);
}
main().catch((e) => { console.error(`[probe] ERROR ${e.message}`); log("error", { message: e.message, rpc: e.rpc }); child.kill(); process.exit(1); });
