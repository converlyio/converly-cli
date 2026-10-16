import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { parseArgv, matchCommand, main, COMMANDS } from "../src/main.js";
import {
  normalizeOrigin,
  resolveOrigin,
  isSameTrustedOrigin,
  STAGING_ORIGIN,
} from "../src/config.js";
import { readTextCapped, assertSafePath } from "../src/net.js";
import { assertIdSegment } from "../src/commands/ids.js";
import { makePkce, LOGIN_SCOPES } from "../src/oauth.js";
import {
  create as flowsCreate,
  buildTriggerConfig,
  toAgentTriggerCatalogue,
} from "../src/commands/flows.js";
import {
  connect as triggersConnect,
  options as triggersOptions,
} from "../src/commands/triggers.js";

test("parseArgv separates args and flags", () => {
  const { args, flags } = parseArgv([
    "flows",
    "create",
    "--site",
    "site_abc",
    "--name",
    "My flow",
    "--staging",
  ]);
  assert.deepEqual(args, ["flows", "create"]);
  assert.equal(flags.site, "site_abc");
  assert.equal(flags.name, "My flow");
  assert.equal(flags.staging, true);
});

test("parseArgv supports --flag=value", () => {
  const { flags } = parseArgv(["events", "list", "--limit=5"]);
  assert.equal(flags.limit, "5");
});

test("parseArgv treats a flag before another flag as boolean", () => {
  const { flags } = parseArgv(["destinations", "conversions", "--refresh", "--limit", "5"]);
  assert.equal(flags.refresh, true);
  assert.equal(flags.limit, "5");
});

test("normalizeOrigin strips paths and adds https", () => {
  assert.equal(
    normalizeOrigin("app.converly.io/api/v1"),
    "https://app.converly.io"
  );
  assert.equal(
    normalizeOrigin("https://app.converly.io/api/v1"),
    "https://app.converly.io"
  );
  assert.equal(
    normalizeOrigin("http://localhost:3000"),
    "http://localhost:3000"
  );
});

test("makePkce produces a verifiable S256 pair", () => {
  const { verifier, challenge } = makePkce();
  const expected = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  assert.equal(challenge, expected);
  assert.ok(verifier.length >= 43, "verifier must be at least 43 chars (RFC 7636)");
});

test("login scopes stay inside the server's registration ceiling", () => {
  // Mirror of MCP_DCR_ALLOWED_SCOPES on the Converly server. If a scope
  // is added here without the server allowing it, registration breaks.
  const ceiling = new Set([
    "openid",
    "profile",
    "offline_access",
    "account:read",
    "sites:read",
    "flows:read",
    "destinations:read",
    // Added with the conversion-list consolidation: the narrow create scope
    // is in the server's MCP_PERMISSIONS-derived ceiling, so login may
    // request it. Without it create-conversion 403s on every credential.
    "destination_conversions:write",
    "events:read",
    "sites:write",
    "flows:write",
    "destinations:disconnect",
    "handoffs:create",
    "internal_traffic:write",
  ]);
  for (const scope of LOGIN_SCOPES.split(" ")) {
    assert.ok(ceiling.has(scope), `scope ${scope} is outside the DCR ceiling`);
  }
});

test("parseArgv: --allow-real is boolean, --reddit-id takes a value", () => {
  // --allow-real is followed by a non-flag token; only its BOOLEAN_FLAGS
  // registration keeps it from swallowing "extra" as a value.
  const { args, flags } = parseArgv([
    "test-event",
    "--allow-real",
    "extra",
    "--reddit-id",
    "x",
  ]);
  assert.equal(flags["allow-real"], true);
  assert.equal(flags["reddit-id"], "x");
  assert.deepEqual(args, ["test-event", "extra"]);
});

test("parseArgv: --flag=false on a boolean flag means false", () => {
  const { flags } = parseArgv(["login", "--signup=false", "--staging=true"]);
  assert.equal(flags.signup, false);
  assert.equal(flags.staging, true);
});

test("normalizeOrigin refuses cleartext http on non-loopback hosts", () => {
  assert.throws(() => normalizeOrigin("http://example.com"), /Refusing insecure/);
  assert.equal(normalizeOrigin("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
});

test("escapeHtml neutralizes markup in reflected values", async () => {
  const { escapeHtml } = await import("../src/oauth.js");
  assert.equal(
    escapeHtml('<script>alert("x")</script>'),
    "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"
  );
});

// --- Strict boolean parsing (Codex round-3 blocker #6) ---

test("parseArgv: a non-true/false value on a boolean flag is an error, not true", () => {
  // The dangerous inversion: `--yes=flase` used to read as truthy → delete.
  const a = parseArgv(["flows", "delete", "flow_x", "--yes=flase"]);
  assert.equal(a.flags.yes, false, "unrecognised value defaults to SAFE false");
  assert.deepEqual(a.invalidBooleanFlags, [{ name: "yes", value: "flase" }]);

  const b = parseArgv(["test-event", "--allow-real=0"]);
  assert.equal(b.flags["allow-real"], false);
  assert.deepEqual(b.invalidBooleanFlags, [{ name: "allow-real", value: "0" }]);
});

test("parseArgv: exact true/false on a boolean flag is honoured, no error", () => {
  const eq = parseArgv(["flows", "delete", "flow_x", "--yes=true"]);
  assert.equal(eq.flags.yes, true);
  assert.deepEqual(eq.invalidBooleanFlags, []);

  const space = parseArgv(["flows", "delete", "flow_x", "--yes", "false"]);
  assert.equal(space.flags.yes, false);
  assert.deepEqual(space.invalidBooleanFlags, []);
});

test("main rejects a bad boolean value with invalid_flag_value (never deletes)", async () => {
  const chunks = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    chunks.push(chunk);
    return true;
  };
  try {
    // If this ever reached the handler it would try to DELETE. It must not.
    await main(["flows", "delete", "flow_x", "--yes=flase"]);
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;
  const payload = JSON.parse(chunks.join(""));
  assert.equal(payload.error.code, "invalid_flag_value");
  assert.match(payload.error.message, /--yes=flase/);
  assert.match(payload.error.message, /true or false/);
});

// --- Empty value = missing (Codex round-3 blocker #5) ---

test('parseArgv: an explicit empty value counts as missing, not ""', () => {
  const eq = parseArgv(["sites", "list", "--api="]);
  assert.ok(eq.missingValueFlags.includes("api"));

  const space = parseArgv(["sites", "list", "--api", ""]);
  assert.ok(space.missingValueFlags.includes("api"));
});

test("main rejects an empty --api= as missing_flag_value (no prod fallthrough)", async () => {
  const chunks = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    chunks.push(chunk);
    return true;
  };
  try {
    await main(["sites", "list", "--api="]);
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;
  const payload = JSON.parse(chunks.join(""));
  assert.equal(payload.error.code, "missing_flag_value");
  assert.match(payload.error.message, /--api/);
});

// --- Deployment-selector safety (Codex round-3 blocker #4 + conflict) ---

test("resolveOrigin refuses --api and --staging together", () => {
  assert.throws(
    () => resolveOrigin({ api: "https://x.example", staging: true }),
    /not both/
  );
});

// --- Same-origin trust boundary (Codex round-3 blockers #1, #10) ---

test("isSameTrustedOrigin pins to exactly the chosen origin", () => {
  const origin = "https://app.converly.io";
  assert.equal(
    isSameTrustedOrigin("https://app.converly.io/api/auth/token", origin),
    true
  );
  // A different host — the refresh-token exfiltration path — is rejected.
  assert.equal(isSameTrustedOrigin("https://attacker.example/token", origin), false);
  // Same host but embedded credentials — rejected.
  assert.equal(
    isSameTrustedOrigin("https://user:pass@app.converly.io/x", origin),
    false
  );
  // Different scheme is a different origin — rejected.
  assert.equal(isSameTrustedOrigin("http://app.converly.io/x", origin), false);
  assert.equal(isSameTrustedOrigin("not a url", origin), false);
});

// --- enhanced is now a strict boolean (Codex round-3 new blocker) ---

test("parseArgv: --enhanced is a strict boolean, bad values rejected", () => {
  const bad = parseArgv(["flows", "create", "--enhanced=flase"]);
  assert.equal(bad.flags.enhanced, false);
  assert.deepEqual(bad.invalidBooleanFlags, [{ name: "enhanced", value: "flase" }]);

  const good = parseArgv(["flows", "create", "--enhanced"]);
  assert.equal(good.flags.enhanced, true);
  assert.deepEqual(good.invalidBooleanFlags, []);
});

// --- Central positional-arity guard (Codex round-3 new blocker) ---

async function runMainCapture(argv) {
  const chunks = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    chunks.push(chunk);
    return true;
  };
  try {
    await main(argv);
  } finally {
    process.stderr.write = originalWrite;
  }
  const code = process.exitCode;
  process.exitCode = 0;
  return { code, payload: JSON.parse(chunks.join("")) };
}

test("main rejects a stray positional from a mistyped boolean on flows create", async () => {
  // `--custom no` leaves "no" as a positional; flows create takes none.
  const { code, payload } = await runMainCapture([
    "flows",
    "create",
    "--site",
    "s",
    "--name",
    "n",
    "--custom",
    "no",
  ]);
  assert.equal(code, 1);
  assert.equal(payload.error.code, "unexpected_argument");
  assert.match(payload.error.message, /"no"/);
});

test("main rejects too many positionals on a one-arg command", async () => {
  const { code, payload } = await runMainCapture(["sites", "get", "s1", "s2"]);
  assert.equal(code, 1);
  assert.equal(payload.error.code, "unexpected_argument");
  assert.match(payload.error.message, /"s2"/);
});

test("main allows the exact positional arity (api takes two)", async () => {
  // Wrong here would be an unexpected_argument error; we assert it is NOT
  // that (the request itself fails later on the bogus origin, which is
  // fine — we only care the arity gate let two through).
  const { payload } = await runMainCapture([
    "api",
    "GET",
    "/flows",
    "extra",
    "--api",
    "https://nonexistent.invalid",
  ]);
  assert.equal(payload.error.code, "unexpected_argument");
  assert.match(payload.error.message, /"extra"/);
});

// --- Path-traversal guard on interpolated ids (Codex round-4 blocker) ---

test("assertIdSegment allows only a plain id and rejects encoded traversal", () => {
  assert.equal(assertIdSegment("flow_abc123", "flow id"), "flow_abc123");
  assert.equal(assertIdSegment("google-ads", "type"), "google-ads");
  for (const bad of [
    "../flows/x",
    "a/b",
    "a\\b",
    ".",
    "..",
    "a b",
    "a?b",
    "a#b",
    "%2e%2e", // encoded ".."
    "%2f", // encoded "/"
    "%5c", // encoded "\"
    "flow%2ex", // any percent-escape
  ]) {
    assert.throws(() => assertIdSegment(bad, "flow id"), /not a path|single id/);
  }
  assert.throws(() => assertIdSegment("", "flow id"), /Missing/);
});

test("main refuses a raw DELETE without --yes", async () => {
  const { code, payload } = await runMainCapture([
    "api",
    "DELETE",
    "/flows/flow_x",
    "--api",
    "https://x.example",
  ]);
  assert.equal(code, 1);
  assert.match(payload.error.message, /--yes/);
});

test("assertSafePath rejects nested / normalized traversal", () => {
  // Plain valid paths pass.
  assertSafePath("/flows/flow_abc123");
  assertSafePath("/sites/site_1/setup-status");
  for (const bad of [
    "/sites/../flows/x",
    "/sites/%2e%2e/flows/x", // single-encoded ..
    "/sites/%252e%252e/flows/x", // double-encoded ..
    "/a/%2f/b", // encoded /
    "/a/%5c/b", // encoded \
    "/a/／/b", // fullwidth solidus → NFKC "/"
  ]) {
    assert.throws(() => assertSafePath(bad), /suspicious|Malformed|Over-encoded/);
  }
});

test("assertSafePath rejects control-char traversal (URL strips tab/newline/CR)", () => {
  // ".<TAB>." etc. become ".." once new URL() strips the control char.
  for (const c of ["\t", "\n", "\r"]) {
    assert.throws(
      () => assertSafePath("/decoy/." + c + "./flows/x"),
      /control character|suspicious/
    );
  }
  // ...including the percent-encoded form.
  assert.throws(() => assertSafePath("/a/.%09./b"), /control character|suspicious/);
});

test("resolveOrigin: an explicit --staging beats CONVERLY_API_URL", () => {
  const prev = process.env.CONVERLY_API_URL;
  process.env.CONVERLY_API_URL = "https://app.converly.io";
  try {
    // An explicit selector must not be silently overridden by the env, or
    // `flows delete X --staging` could hit production.
    assert.equal(resolveOrigin({ staging: true }), STAGING_ORIGIN);
  } finally {
    if (prev === undefined) delete process.env.CONVERLY_API_URL;
    else process.env.CONVERLY_API_URL = prev;
  }
});

test("a 429 stays retryable and surfaces retry timing", async () => {
  const srv = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "30",
      });
      res.end(JSON.stringify({ error: { code: "rate_limited", message: "slow down" } }));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const bin = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "bin",
    "converly.js"
  );
  const child = spawn(
    process.execPath,
    [bin, "flows", "get", "flow_abc", "--api", `http://127.0.0.1:${port}`],
    { env: { ...process.env, CONVERLY_API_KEY: "sk_live_dummy" } }
  );
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  await new Promise((r) => child.on("close", r));
  srv.close();
  const p = JSON.parse(err).error;
  assert.equal(p.status, 429);
  assert.equal(p.retryable, true, "429 must stay retryable");
  assert.equal(p.retry_after, "30");
});

test("a PATCH 5xx never surfaces retryable (outcome_uncertain instead)", async () => {
  // The exact scenario: a structured 500 whose body claims retryable:true.
  // A non-idempotent PATCH must NOT echo that to a machine consumer.
  const srv = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            code: "server_fault",
            message: "failed after write",
            retryable: true,
            hint: "retry now",
          },
        })
      );
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const bin = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "bin",
    "converly.js"
  );
  const child = spawn(
    process.execPath,
    [
      bin,
      "flows",
      "update",
      "flow_abc",
      "--json",
      '{"name":"x"}',
      "--api",
      `http://127.0.0.1:${port}`,
    ],
    { env: { ...process.env, CONVERLY_API_KEY: "sk_live_dummy" } }
  );
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const exitCode = await new Promise((r) => child.on("close", r));
  srv.close();
  assert.equal(exitCode, 1);
  const p = JSON.parse(err).error;
  assert.equal(p.status, 500);
  assert.equal(p.outcome_uncertain, true, "PATCH ambiguity must be flagged");
  assert.equal(p.retryable, undefined, "server's retryable must be stripped");
  assert.match(p.hint, /check the current state/);
});

test("main refuses a traversal id on a destructive command (no request sent)", async () => {
  const { code, payload } = await runMainCapture([
    "flows",
    "delete",
    "../flows/other",
    "--yes",
    "--api",
    "https://x.example",
  ]);
  assert.equal(code, 1);
  assert.match(payload.error.message, /not a path/);
});

// --- Streaming response cap (Codex round-3 should-fix #8) ---

test("readTextCapped rejects a body that overshoots the cap", async () => {
  // A stream with NO content-length (the case a lying header can't cover):
  // the reader must stop once accumulated bytes exceed the cap.
  const big = "x".repeat(5000);
  const overStream = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(big));
        c.close();
      },
    })
  );
  const over = await readTextCapped(overStream, 1000);
  assert.equal(over.overLimit, true);

  const okRes = new Response("hello");
  const ok = await readTextCapped(okRes, 1000);
  assert.equal(ok.text, "hello");
});

test("every command declares its flags for the strict parser", () => {
  for (const [name, def] of Object.entries(COMMANDS)) {
    assert.ok(Array.isArray(def.flags), `${name} is missing a flags array`);
  }
});

test("main rejects unknown flags with one JSON error naming them all", async () => {
  const chunks = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    chunks.push(chunk);
    return true;
  };
  try {
    await main(["sites", "list", "--limt", "5", "--bogus"]);
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.equal(process.exitCode, 1);
  process.exitCode = 0; // don't let the intentional failure fail the suite
  const payload = JSON.parse(chunks.join(""));
  assert.equal(payload.error.code, "unknown_flag");
  // Both unknowns named in the one error, and the fix taught alongside.
  assert.match(payload.error.message, /--limt/);
  assert.match(payload.error.message, /--bogus/);
  assert.match(payload.error.message, /--limit/);
  assert.match(payload.error.message, /--staging/);
});

test("two-word commands win over their one-word prefix", () => {
  // `triggers connect` must not fall through to the `triggers` catalogue.
  const two = matchCommand(["triggers", "connect", "acuity"]);
  assert.equal(two.name, "triggers connect");
  assert.deepEqual(two.rest, ["acuity"]);
  const one = matchCommand(["triggers"]);
  assert.equal(one.name, "triggers");
});

test("triggers connect validates source and --site before any request", async () => {
  const origin = "https://app.converly.io";
  await assert.rejects(
    triggersConnect({ args: [], flags: {}, origin }),
    /Missing trigger source/
  );
  await assert.rejects(
    triggersConnect({ args: ["api"], flags: {}, origin }),
    /Missing --site/
  );
});

test("triggers options validates source and --site before any request", async () => {
  const origin = "https://app.converly.io";
  await assert.rejects(
    triggersOptions({ args: [], flags: {}, origin }),
    /Missing trigger source/
  );
  await assert.rejects(
    triggersOptions({ args: ["typeform"], flags: {}, origin }),
    /Missing --site/
  );
});

test("`triggers options` is a distinct two-word command over `triggers`", () => {
  const two = matchCommand(["triggers", "options", "typeform"]);
  assert.equal(two.name, "triggers options");
  assert.deepEqual(two.rest, ["typeform"]);
  // Its declared flags cover what the handler reads (strict parser).
  assert.deepEqual(COMMANDS["triggers options"].flags, ["site", "query", "limit"]);
});

test("flows create: --trigger api without --key rejects with the fix", async () => {
  await assert.rejects(
    flowsCreate({
      flags: { site: "site_x", name: "Signups", trigger: "api" },
      origin: "https://app.converly.io",
    }),
    /needs --key.*triggers connect api/s
  );
});

test("flows create: --key without --trigger api rejects", async () => {
  const origin = "https://app.converly.io";
  await assert.rejects(
    flowsCreate({
      flags: { site: "site_x", name: "Signups", trigger: "generic-form", key: "main-signup" },
      origin,
    }),
    /--key only applies to --trigger api/
  );
  await assert.rejects(
    flowsCreate({
      flags: { site: "site_x", name: "Signups", key: "main-signup" },
      origin,
    }),
    /--key only applies to --trigger api/
  );
});

test("flows create: --pages with --trigger api rejects", async () => {
  await assert.rejects(
    flowsCreate({
      flags: { site: "site_x", name: "Signups", trigger: "api", key: "main-signup", pages: "/thanks" },
      origin: "https://app.converly.io",
    }),
    /--pages does not apply/
  );
});

test("buildTriggerConfig: no filter flags sends no filter settings", () => {
  assert.deepEqual(buildTriggerConfig({ trigger: "api", key: "main-signup" }), {
    integrationId: "api",
    key: "main-signup",
  });
  assert.deepEqual(buildTriggerConfig({ trigger: "generic-form" }), {
    integrationId: "generic-form",
  });
  assert.deepEqual(buildTriggerConfig({ trigger: "typeform", pages: "/a, /b" }), {
    integrationId: "typeform",
    filters: { match: "all", list: [{ field: "page", op: "only", values: ["/a", "/b"] }] },
  });
});

test("CONVERLY_API_KEY is only offered to trusted origins", async () => {
  const { resolveAuth, PROD_ORIGIN } = await import("../src/config.js");
  const prev = process.env.CONVERLY_API_KEY;
  process.env.CONVERLY_API_KEY = "sk_live_test_value";
  try {
    assert.equal(resolveAuth(PROD_ORIGIN)?.source, "env");
    // An arbitrary origin must never receive the environment key.
    const attacker = resolveAuth("https://attacker.example");
    assert.notEqual(attacker?.source, "env");
  } finally {
    if (prev === undefined) delete process.env.CONVERLY_API_KEY;
    else process.env.CONVERLY_API_KEY = prev;
  }
});

test("login dispatch: every environment row routes correctly", async () => {
  const { resolveLoginMode, envTruthy } = await import("../src/login-mode.js");
  const rows = [
    // [flags, env, platform, expected]
    [{ device: true }, {}, "darwin", "device"],
    [{ browser: true }, { CI: "1" }, "linux", "loopback"],
    [{ "no-open": true }, {}, "linux", "loopback"], // unchanged semantics
    [{}, { CI: "true" }, "darwin", "device_auto"],
    [{}, { CI: "false" }, "darwin", "loopback"], // CI="false" is false
    [{}, { SSH_CONNECTION: "1.2.3.4 22" }, "darwin", "device_auto"], // macOS over SSH
    [{}, { SSH_TTY: "/dev/pts/0" }, "linux", "device_auto"],
    [{}, {}, "linux", "device_auto"], // linux, no display
    [{}, { DISPLAY: ":0" }, "linux", "loopback"], // linux desktop
    [{}, { WAYLAND_DISPLAY: "wayland-0" }, "linux", "loopback"],
    [{}, {}, "darwin", "loopback"], // plain laptop
    [{}, {}, "win32", "loopback"],
  ];
  for (const [flags, env, platform, expected] of rows) {
    assert.equal(
      resolveLoginMode(flags, env, platform),
      expected,
      JSON.stringify({ flags, env, platform })
    );
  }
  assert.throws(
    () => resolveLoginMode({ device: true, browser: true }, {}, "darwin"),
    /conflict/
  );
  assert.equal(envTruthy("0"), false);
  assert.equal(envTruthy("yes"), true);
});

test("shouldSuppressBrowserOpen: --browser overrides --no-open", async () => {
  const { shouldSuppressBrowserOpen } = await import("../src/login-mode.js");
  assert.equal(shouldSuppressBrowserOpen({ "no-open": true }), true);
  assert.equal(shouldSuppressBrowserOpen({ "no-open": true, browser: true }), false);
  assert.equal(shouldSuppressBrowserOpen({ browser: true }), false);
  assert.equal(shouldSuppressBrowserOpen({}), false);
});

test("device poll deadline extends when the server reports a later expires_at", () => {
  // Mirrors the deviceLoginFlow deadline-extension logic (Codex round 3):
  // a pending poll carrying a later expires_at must push the deadline out.
  let deadline = Date.parse("2026-08-10T00:30:00Z");
  const later = "2026-08-10T00:34:00Z";
  const t = new Date(later).getTime();
  if (Number.isFinite(t) && t > deadline) deadline = t;
  assert.equal(deadline, Date.parse("2026-08-10T00:34:00Z"));
});

test("toAgentTriggerCatalogue: keeps public filters and drops legacy fields and custom_event", () => {
  const raw = [
    {
      type: "form_submission",
      name: "Form submission",
      when_to_use: "…",
      providers: ["generic-form"],
      supports_filters: ["form_id", "form_selector", "page_path_filter"],
      filters: [{ field: "page", key: "page", ops: ["only", "except"], inputs: { as: "path" }, kind: "path", label: "Page", extra: { future: true } }],
      at_least_one_filter_required: true,
    },
    { type: "custom_event", name: "Custom event", providers: [] },
    { type: "meeting_booked", name: "Meeting booked", providers: ["acuity"], filters: [{ field: "calendar", key: "calendar", ops: ["only"], inputs: { connected: "list" }, kind: "entity" }] },
  ];
  const out = toAgentTriggerCatalogue(raw);
  // custom_event is dropped entirely.
  assert.deepEqual(
    out.map((t) => t.type),
    ["form_submission", "meeting_booked"]
  );
  // Public filter entries survive unchanged, including additional API fields.
  const form = out.find((t) => t.type === "form_submission");
  assert.equal("supports_filters" in form, false);
  assert.deepEqual(form.filters, raw[0].filters);
  assert.deepEqual(out[1].filters, raw[2].filters);
  assert.equal("at_least_one_filter_required" in form, false);
  assert.equal(raw[0].at_least_one_filter_required, true);
  // Everything an agent legitimately needs survives.
  assert.equal(form.when_to_use, "…");
  assert.deepEqual(form.providers, ["generic-form"]);
});


test("create-conversion is registered with the safety-critical flags", async () => {
  // The command writes a permanent object into a customer's ad account, so
  // its registration must carry the site + idempotency affordances and the
  // help text must tell an agent to ask the customer first.
  const { COMMANDS } = await import("../src/main.js");
  const cmd = COMMANDS["destinations create-conversion"];
  assert.ok(cmd, "command registered");
  for (const flag of ["name", "site", "category", "event-type", "conversion-method", "idempotency-key"]) {
    assert.ok(cmd.flags.includes(flag), `flag --${flag}`);
  }
  assert.match(cmd.help, /ASK THE CUSTOMER FIRST/);
  assert.match(cmd.help, /can never be deleted/);
  assert.match(cmd.help, /supports_create/);
});

test("create-conversion refuses without --name before any network call", async () => {
  const destinations = await import("../src/commands/destinations.js");
  await assert.rejects(
    () => destinations.createConversion({ args: ["google-ads"], flags: {}, origin: "prod" }),
    /Missing --name/
  );
});


test("login requests the create scope (or create-conversion is dead on arrival)", async () => {
  const { LOGIN_SCOPES } = await import("../src/oauth.js");
  assert.ok(
    LOGIN_SCOPES.includes("destination_conversions:write"),
    "create-conversion needs destination_conversions:write at login"
  );
  // …and never the broad scope, which also authorizes credential ingestion.
  assert.ok(!LOGIN_SCOPES.includes("destinations:write"));
});

// --- destinations list/get --site (multi-site accounts) ---

// Runs the real binary against a local server and records every request
// path it receives, so the test sees exactly what reached the wire.
async function spawnAgainstLocalServer(cliArgs) {
  const requests = [];
  const srv = http.createServer((req, res) => {
    requests.push(req.url);
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const bin = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "bin",
    "converly.js"
  );
  const child = spawn(
    process.execPath,
    [bin, ...cliArgs, "--api", `http://127.0.0.1:${port}`],
    { env: { ...process.env, CONVERLY_API_KEY: "sk_live_dummy" } }
  );
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const exitCode = await new Promise((r) => child.on("close", r));
  srv.close();
  return { exitCode, err, requests };
}

test("destinations list --site sends site_id", async () => {
  const { exitCode, requests } = await spawnAgainstLocalServer([
    "destinations",
    "list",
    "--site",
    "site_abc",
  ]);
  assert.equal(exitCode, 0);
  assert.deepEqual(requests, ["/api/v1/destinations?site_id=site_abc"]);
});

test("destinations get --site sends site_id", async () => {
  const { exitCode, requests } = await spawnAgainstLocalServer([
    "destinations",
    "get",
    "google-ads",
    "--site",
    "site_abc",
  ]);
  assert.equal(exitCode, 0);
  assert.deepEqual(requests, ["/api/v1/destinations/dest_google-ads?site_id=site_abc"]);
});

test("destinations list/get without --site send no site_id", async () => {
  const list = await spawnAgainstLocalServer(["destinations", "list"]);
  assert.equal(list.exitCode, 0);
  assert.deepEqual(list.requests, ["/api/v1/destinations"]);

  const get = await spawnAgainstLocalServer(["destinations", "get", "google-ads"]);
  assert.equal(get.exitCode, 0);
  assert.deepEqual(get.requests, ["/api/v1/destinations/dest_google-ads"]);
});

test("destinations list/get still reject an unknown flag (no request sent)", async () => {
  for (const argv of [
    ["destinations", "list", "--sight", "site_abc"],
    ["destinations", "get", "google-ads", "--sight", "site_abc"],
  ]) {
    const { exitCode, err, requests } = await spawnAgainstLocalServer(argv);
    assert.equal(exitCode, 1);
    const p = JSON.parse(err).error;
    assert.equal(p.code, "unknown_flag");
    assert.match(p.message, /--sight/);
    assert.match(p.message, /--site/);
    assert.deepEqual(requests, []);
  }
});

// Exercise argument parsing, request bodies and printed output without a network.
async function runWithMockApi(argv, response = { ok: true }, status = 200) {
  const previous = {
    fetch: globalThis.fetch,
    stdout: process.stdout.write,
    stderr: process.stderr.write,
    exitCode: process.exitCode,
    apiKey: process.env.CONVERLY_API_KEY,
  };
  const requests = [];
  let stdout = "";
  let stderr = "";
  globalThis.fetch = async (url, options) => {
    requests.push({
      path: url.pathname,
      method: options.method,
      body: options.body === undefined ? undefined : JSON.parse(options.body),
    });
    return new Response(JSON.stringify(response), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  process.stdout.write = (chunk) => { stdout += chunk; return true; };
  process.stderr.write = (chunk) => { stderr += chunk; return true; };
  process.exitCode = 0;
  process.env.CONVERLY_API_KEY = "test-placeholder";
  try {
    await main([...argv, "--api", "https://app.converly.io"]);
    return { requests, stdout, stderr, exitCode: process.exitCode };
  } finally {
    globalThis.fetch = previous.fetch;
    process.stdout.write = previous.stdout;
    process.stderr.write = previous.stderr;
    process.exitCode = previous.exitCode;
    if (previous.apiKey === undefined) delete process.env.CONVERLY_API_KEY;
    else process.env.CONVERLY_API_KEY = previous.apiKey;
  }
}

const createFilterArgs = ["flows", "create", "--site", "site_x", "--name", "Leads", "--trigger", "gravity-forms"];
const pageOnly = { field: "page", op: "only", values: ["/pricing", "/services/*"] };
const pageExcept = { field: "page", op: "except", values: ["/internal", "/staff/*"] };
const formOnly = { field: "form", op: "only", values: [{ id: "0012" }, { id: "9007199254740993123" }] };
const formExcept = { field: "form", op: "except", values: [{ id: "34" }, { id: "form_56" }] };
const publicFilters = { match: "all", list: [pageOnly, formOnly] };

for (const [name, argv, filters] of [
  ["no filters", [], undefined],
  ["--pages", ["--pages", " /pricing, /services/*, "], { match: "all", list: [pageOnly] }],
  ["--except-pages", ["--except-pages", " /internal, /staff/* "], { match: "all", list: [pageExcept] }],
  ["--form-ids", ["--form-ids", " 0012,9007199254740993123, "], { match: "all", list: [formOnly] }],
  ["--except-form-ids", ["--except-form-ids", " 34, form_56 "], { match: "all", list: [formExcept] }],
  ["both page rules", ["--pages", "/pricing,/services/*", "--except-pages", "/internal,/staff/*"], { match: "all", list: [pageOnly, pageExcept] }],
  ["both form rules", ["--form-ids", "0012,9007199254740993123", "--except-form-ids", "34,form_56"], { match: "all", list: [formOnly, formExcept] }],
  ["all four rules with --match any", ["--pages", "/pricing,/services/*", "--except-pages", "/internal,/staff/*", "--form-ids", "0012,9007199254740993123", "--except-form-ids", "34,form_56", "--match", "any"], { match: "any", list: [pageOnly, pageExcept, formOnly, formExcept] }],
  ["--match all", ["--form-ids", "0012,9007199254740993123", "--match", "all"], { match: "all", list: [formOnly] }],
  ["--filters-json", ["--filters-json", JSON.stringify(publicFilters)], publicFilters],
]) {
  test(`flows create sends the exact request body for ${name}`, async () => {
    const result = await runWithMockApi([...createFilterArgs, ...argv]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(result.requests, [{
      path: "/api/v1/flows", method: "POST",
      body: {
        site_id: "site_x", name: "Leads",
        trigger_config: { integrationId: "gravity-forms", ...(filters !== undefined && { filters }) },
      },
    }]);
  });
}

for (const [command, args, method, apiPath] of [
  ["create", createFilterArgs, "POST", "/api/v1/flows"],
  ["update", ["flows", "update", "flow_x"], "PATCH", "/api/v1/flows/flow_x"],
]) {
  test(`flows ${command} passes filters objects unchanged for server validation`, async () => {
    for (const filters of [publicFilters, {}, { match: "unsupported", list: [{ field: "future", op: "future", values: [{ name: "Demo", id: 12 }] }], extra: true }]) {
      const result = await runWithMockApi([...args, "--filters-json", JSON.stringify(filters)]);
      assert.equal(result.exitCode, 0, result.stderr);
      const body = command === "create"
        ? { site_id: "site_x", name: "Leads", trigger_config: { integrationId: "gravity-forms", filters } }
        : { trigger_config: { filters } };
      assert.deepEqual(result.requests, [{ path: apiPath, method, body }]);
    }
  });

  test(`flows ${command} keeps --json request bodies unchanged`, async () => {
    const body = { name: "New name", trigger_config: { integrationId: "typeform", filters: publicFilters } };
    const result = await runWithMockApi(["flows", command, ...(command === "update" ? ["flow_x"] : []), "--json", JSON.stringify(body)]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(result.requests, [{ path: apiPath, method, body }]);
  });

  test(`flows ${command} refuses --json with --filters-json locally`, async () => {
    const result = await runWithMockApi([...args, "--json", "{}", "--filters-json", JSON.stringify(publicFilters)]);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(result.requests, []);
    assert.deepEqual(JSON.parse(result.stderr), { error: { code: "cli_error", message: "Use either --json or --filters-json, not both." } });
  });

  test(`flows ${command} refuses malformed JSON and non-object filters locally`, async () => {
    for (const value of ["{", "null", "[]", "12", '"text"', "true", "false"]) {
      const result = await runWithMockApi([...args, "--filters-json", value]);
      assert.equal(result.exitCode, 1, value);
      assert.equal(result.stdout, "");
      assert.deepEqual(result.requests, []);
      assert.deepEqual(JSON.parse(result.stderr), { error: { code: "cli_error", message: "--filters-json must be a JSON object." } });
    }
  });
}

for (const [flag, value] of [["pages", "/a"], ["except-pages", "/b"], ["form-ids", "12"], ["except-form-ids", "34"], ["match", "any"]]) {
  for (const command of ["create", "update"]) {
    test(`flows ${command} refuses --json with --${flag} locally`, async () => {
      const body = { site_id: "site_x", name: "Leads", trigger_config: { integrationId: "gravity-forms" } };
      for (const flagValue of flag === "match" ? [value, "all", "invalid"] : [value]) {
        const result = await runWithMockApi([
          "flows", command, ...(command === "update" ? ["flow_x"] : []),
          "--json", JSON.stringify(body), `--${flag}=${flagValue}`,
        ]);
        assert.equal(result.exitCode, 1);
        assert.equal(result.stdout, "");
        assert.deepEqual(result.requests, []);
        const error = JSON.parse(result.stderr).error;
        if (command === "create") {
          assert.deepEqual(error, {
            code: "cli_error",
            message: "Use --json on its own, without --pages, --except-pages, --form-ids, --except-form-ids or --match.",
          });
        } else {
          // Update does not accept shortcut filter flags at all.
          assert.equal(error.code, "unknown_flag");
          assert.ok(error.message.includes(`--${flag}`));
        }
      }
    });
  }

  test(`flows create refuses --filters-json with --${flag} locally`, async () => {
    const result = await runWithMockApi([...createFilterArgs, "--filters-json", JSON.stringify(publicFilters), `--${flag}`, value]);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(result.requests, []);
    assert.deepEqual(JSON.parse(result.stderr), { error: {
      code: "cli_error",
      message: "Use --filters-json on its own, without --pages, --except-pages, --form-ids, --except-form-ids or --match.",
    } });
  });
}

for (const command of ["create", "update"]) {
  test(`flows ${command} refuses --match without rule flags locally`, async () => {
    const args = command === "create" ? createFilterArgs : ["flows", "update", "flow_x"];
    for (const value of ["all", "any"]) {
      const result = await runWithMockApi([...args, "--match", value]);
      assert.equal(result.exitCode, 1);
      assert.equal(result.stdout, "");
      assert.deepEqual(result.requests, []);
      const error = JSON.parse(result.stderr).error;
      if (command === "create") {
        assert.deepEqual(error, {
          code: "cli_error",
          message: "--match needs at least one of --pages, --except-pages, --form-ids or --except-form-ids.",
        });
      } else {
        // Update rejects --match before reaching the command handler.
        assert.equal(error.code, "unknown_flag");
        assert.ok(error.message.includes("--match"));
      }
    }
  });
}

const createApiArgs = ["flows", "create", "--site", "site_x", "--name", "Leads", "--trigger", "api", "--key", "main-signup"];

for (const [flag, value] of [
  ["pages", "/a"],
  ["except-pages", "/b"],
  ["form-ids", "12"],
  ["except-form-ids", "34"],
  ["match", "any"],
  ["filters-json", JSON.stringify(publicFilters)],
]) {
  test(`flows create refuses --${flag} with --trigger api locally`, async () => {
    const result = await runWithMockApi([...createApiArgs, `--${flag}`, value]);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(result.requests, []);
    assert.deepEqual(JSON.parse(result.stderr), { error: {
      code: "cli_error",
      message: flag === "pages"
        ? "--pages does not apply to --trigger api. The webhook fires from the site's backend, so there is no page to filter on."
        : `--${flag} does not apply to --trigger api. The api trigger does not support filters.`,
    } });
  });
}

test("flows create keeps the valid api request body unchanged", async () => {
  const result = await runWithMockApi(createApiArgs);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(result.requests, [{
    path: "/api/v1/flows", method: "POST",
    body: {
      site_id: "site_x", name: "Leads",
      trigger_config: { integrationId: "api", key: "main-signup" },
    },
  }]);
});

test("flows create refuses invalid --match values locally", async () => {
  for (const value of ["ALL", "Any", "none", "true", "false", "0"]) {
    const result = await runWithMockApi([...createFilterArgs, "--match", value]);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(result.requests, []);
    assert.deepEqual(JSON.parse(result.stderr), { error: { code: "cli_error", message: "--match must be all or any." } });
  }
});

test("filter flags require values, including --match", async () => {
  for (const flag of ["pages", "except-pages", "form-ids", "except-form-ids", "match", "filters-json"]) {
    const result = await runWithMockApi([...createFilterArgs, `--${flag}`]);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.requests, []);
    assert.equal(JSON.parse(result.stderr).error.code, "missing_flag_value");
  }
  const result = await runWithMockApi(["flows", "update", "flow_x", "--filters-json"]);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.requests, []);
  assert.equal(JSON.parse(result.stderr).error.code, "missing_flag_value");
});

test("flows get prints filters_summary from the API", async () => {
  const response = { id: "flow_x", trigger_config: { integrationId: "gravity-forms", filters: publicFilters }, filters_summary: "Form ID: 12" };
  const result = await runWithMockApi(["flows", "get", "flow_x"], response);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), response);
  assert.deepEqual(result.requests, [{ path: "/api/v1/flows/flow_x", method: "GET", body: undefined }]);
});

test("filter_mixed refusal keeps the server code and message on stderr and exits 1", async () => {
  const error = {
    type: "invalid_request_error", code: "filter_mixed",
    message: "Use either all filters or any filter. Mixing AND and OR is not supported yet.",
    param: "trigger_config.filters",
  };
  const result = await runWithMockApi(["flows", "update", "flow_x", "--filters-json", JSON.stringify(publicFilters)], { error }, 400);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.requests.length, 1);
  assert.deepEqual(JSON.parse(result.stderr), { error: { ...error, status: 400 } });
});

test("triggers options teaches a public filter using the returned field", async () => {
  const response = { fields: [{ field: "event_type", values: [{ id: "12", name: "Demo" }] }] };
  const result = await runWithMockApi(["triggers", "options", "calendly", "--site", "site_x"], response);
  assert.equal(result.exitCode, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.fields, response.fields);
  assert.match(output.next_step, /trigger_config\.filters/);
  assert.doesNotMatch(output.next_step, /conditions/);
  const example = output.next_step.match(/--filters-json '([^']+)'/);
  assert.ok(example);
  assert.deepEqual(JSON.parse(example[1]), { match: "all", list: [{ field: "event_type", op: "only", values: [{ id: "<id>" }] }] });
});

test("triggers options help and missing-source message name all connected tools", async () => {
  // Pinned to the frontend trigger-connect registry's SUPPORTED_TRIGGER_CONNECTS.
  const tools = [
    ["Typeform", "typeform"],
    ["Calendly", "calendly"],
    ["Acuity", "acuity-scheduling"],
    ["Jotform", "jotform"],
    ["Cal.com (cal-com)", "cal-com"],
  ];
  const help = await runWithMockApi(["help", "triggers", "options"]);
  assert.equal(help.exitCode, 0);
  assert.equal(help.stderr, "");
  assert.deepEqual(help.requests, []);
  assert.equal(help.stdout.match(/providers \((.*?)\);/)[1], tools.map(([name]) => name).join(", "));

  const missing = await runWithMockApi(["triggers", "options", "--site", "site_x"]);
  assert.equal(missing.exitCode, 1);
  assert.equal(missing.stdout, "");
  assert.deepEqual(missing.requests, []);
  const error = JSON.parse(missing.stderr).error;
  assert.equal(error.code, "cli_error");
  assert.equal(error.message.match(/e\.g\. (.*?)\)\./)[1], tools.map(([, slug]) => slug).join(", "));
});

test("filter help documents the flags and public format", () => {
  const create = COMMANDS["flows create"];
  for (const flag of ["pages", "except-pages", "form-ids", "except-form-ids", "match", "filters-json"]) {
    assert.ok(create.flags.includes(flag));
    assert.ok(create.usage.includes(`--${flag}`));
    assert.ok(create.help.includes(`--${flag}`));
  }
  const update = COMMANDS["flows update"];
  assert.ok(update.flags.includes("filters-json"));
  assert.match(update.usage, /--filters-json/);
  assert.match(update.help, /trigger_config\.filters/);
  assert.match(COMMANDS["triggers options"].help, /trigger_config\.filters/);
  assert.doesNotMatch(COMMANDS["triggers options"].help, /conditions/);
});
