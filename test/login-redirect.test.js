import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const OAUTH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "oauth.js");

// Runs a whole browser login against a fake authorization server in a child
// process (the config directory is fixed at import, so HOME must be set first)
// and reports what the browser's callback request got back.
function runLogin(tokenOk) {
  const script = `
    import http from "node:http";
    const { loginFlow } = await import(${JSON.stringify(OAUTH)});
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, "http://x");
      const json = (code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
      if (u.pathname === "/.well-known/oauth-authorization-server") return json(200, {
        authorization_endpoint: origin + "/authorize", token_endpoint: origin + "/token", registration_endpoint: origin + "/register" });
      if (u.pathname === "/register") return json(201, { client_id: "cli_test" });
      if (u.pathname === "/token") return ${tokenOk}
        ? json(200, { access_token: "sk_live_test", token_type: "Bearer", expires_in: 3600, scope: "sites:read" })
        : json(400, { error: "invalid_grant" });
      res.writeHead(404).end();
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const origin = "http://127.0.0.1:" + srv.address().port;
    let browser = null;
    const done = loginFlow({ origin, noOpen: true, progress: (line) => {
      const m = line.match(/http:\\/\\/127\\.0\\.0\\.1:\\d+\\/authorize\\S*/);
      if (m && !browser) {
        const a = new URL(m[0]);
        const cb = new URL(a.searchParams.get("redirect_uri"));
        cb.searchParams.set("code", "c1"); cb.searchParams.set("state", a.searchParams.get("state"));
        browser = fetch(cb, { redirect: "manual" }).then(async (r) => ({ status: r.status, location: r.headers.get("location"), body: await r.text() }));
      }
    } }).then(() => "ok", (e) => "error: " + e.message);
    const outcome = await done;
    const got = await browser;
    srv.close();
    console.log(JSON.stringify({ outcome, origin, ...got }));
  `;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "converly-login-"));
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: home, USERPROFILE: home, CONVERLY_API_KEY: "" },
    encoding: "utf8",
    timeout: 20000,
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop());
}

test("a successful browser login sends the browser to the app's logged-in page", () => {
  const r = runLogin(true);
  assert.equal(r.outcome, "ok");
  assert.equal(r.status, 302);
  assert.equal(r.location, `${r.origin}/cli/logged-in`);
});

test("a failed token exchange shows the error page, never the logged-in page", () => {
  const r = runLogin(false);
  assert.match(r.outcome, /^error: Token request failed/);
  assert.equal(r.status, 200);
  assert.match(r.body, /Login didn&#39;t complete|Login didn't complete/);
  assert.match(r.body, /invalid_grant/);
});
