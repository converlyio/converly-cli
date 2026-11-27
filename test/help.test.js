import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { matchCommand } from "../src/main.js";
import { formatResult } from "../src/output.js";
import { articleUrl } from "../src/commands/help.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "converly.js");

/** Run the CLI against a local server that answers with `reply(req, body)`. */
async function runAgainst(args, reply) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      const [status, json] = reply(req, body);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const env = { ...process.env, CONVERLY_API_KEY: "sk_live_dummy", CONVERLY_OUTPUT: "json" };
  for (const k of ["CLAUDECODE", "CODEX_SANDBOX"]) delete env[k];
  const child = spawn(process.execPath, [BIN, ...args, "--api", `http://127.0.0.1:${port}`], { env });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const code = await new Promise((r) => child.on("close", r));
  srv.close();
  return { code, out, err, seen };
}

test("test-event is gone, and says what replaced it", async () => {
  assert.equal(matchCommand(["test-event"]), null);
  const { code, err, seen } = await runAgainst(["test-event", "--flow", "flow_1"], () => [200, {}]);
  assert.equal(code, 1);
  assert.equal(seen.length, 0);
  const e = JSON.parse(err).error;
  assert.equal(e.code, "command_removed");
  assert.match(e.message, /converly events list/);
});

test("docs search joins an unquoted question and passes the reply through", async () => {
  const reply = { articles: [{ title: "Cookie banners", url: "https://help.converly.io/a", description: "d" }], assistant_guidance: { code: "help_found", text: "Answer from these." } };
  const { code, out, seen } = await runAgainst(["docs", "search", "cookie", "banner"], () => [200, reply]);
  assert.equal(code, 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "GET");
  assert.match(seen[0].url, /^\/api\/v1\/help\/search\?q=cookie(\+|%20)banner$/);
  assert.deepEqual(JSON.parse(out), reply);
});

test("docs read takes a full url or a path on the help site", () => {
  assert.equal(articleUrl("https://help.converly.io/x/y"), "https://help.converly.io/x/y");
  assert.equal(articleUrl("/x/y"), "https://help.converly.io/x/y");
  assert.equal(articleUrl(""), null);
});

test("support refuses without --yes and sends nothing", async () => {
  const { code, err, seen } = await runAgainst(["support", "--kind", "question", "--message", "hi"], () => [200, {}]);
  assert.equal(code, 1);
  assert.equal(seen.length, 0);
  assert.match(JSON.parse(err).error.message, /Ask the user before contacting Converly support/);
});

test("support rejects an unknown --kind before sending", async () => {
  const { code, seen } = await runAgainst(["support", "--kind", "bug", "--message", "hi", "--yes"], () => [200, {}]);
  assert.equal(code, 1);
  assert.equal(seen.length, 0);
});

test("support sends the user's yes, the details and an idempotency key", async () => {
  const reply = { assistant_guidance: { code: "support_sent", text: "Sent." } };
  const { code, out, seen } = await runAgainst(
    ["support", "--kind", "connection_problem", "--platform", "Meta", "--message", "Login loops", "--site", "site_1", "--yes"],
    () => [200, reply]
  );
  assert.equal(code, 0);
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].url, "/api/v1/support-requests");
  assert.ok(seen[0].headers["idempotency-key"], "a retry must never send twice");
  assert.deepEqual(seen[0].body, {
    kind: "connection_problem",
    message: "Login loops",
    platform_or_tool: "Meta",
    site_id: "site_1",
    confirmed_with_user: true,
  });
  assert.deepEqual(JSON.parse(out), reply);
});

test("a refused support request says the server's words and isn't offered as a retry", async () => {
  const guidance = { code: "support_not_production", text: "This couldn't be sent." };
  const { code, err } = await runAgainst(["support", "--kind", "question", "--message", "hi", "--yes"], () => [503, { assistant_guidance: guidance }]);
  assert.equal(code, 1);
  const e = JSON.parse(err).error;
  assert.equal(e.code, "support_not_production");
  assert.equal(e.message, "This couldn't be sent.");
  assert.deepEqual(e.assistant_guidance, guidance);
  assert.equal(e.retryable, undefined);
  assert.equal(e.idempotency_key, undefined);
});

test("text mode prints the server's guidance on status, events get, docs and support", () => {
  const pipe = { isTTY: false };
  const status = formatResult(
    "status",
    { site_id: "s", items: [{ status: "done", what_and_why: "Done." }], ready: true, assistant_guidance: { code: "ready", text: "Tracking is live." } },
    { mode: "text", stream: pipe }
  );
  assert.match(status, /Tracking is live\.\n$/);
  const event = formatResult(
    "events get",
    { id: "evt_1", status: "completed", actions: [], assistant_guidance: { code: "delivered", text: "Closing note." } },
    { mode: "text", stream: pipe }
  );
  assert.match(event, /Closing note\.\n$/);
  const search = formatResult(
    "docs search",
    { articles: [{ title: "T", url: "https://help.converly.io/t", description: "D" }], assistant_guidance: { code: "help_found", text: "G." } },
    { mode: "text", stream: pipe }
  );
  assert.match(search, /^T\n {2}D\n {2}https:\/\/help\.converly\.io\/t\n\nG\.\n$/);
  assert.equal(formatResult("support", { assistant_guidance: { code: "support_sent", text: "Sent." } }, { mode: "text", stream: pipe }), "Sent.\n");
});
