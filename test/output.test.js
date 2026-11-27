import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

import {
  resolveOutputMode,
  resolveErrorMode,
  formatResult,
  formatError,
  cliSpeak,
  translateError,
  reasonFor,
  withReasons,
  hasKnownReason,
  stripApiSentences,
  deploymentFlag,
} from "../src/output.js";
import { PROD_ORIGIN, STAGING_ORIGIN } from "../src/config.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "converly.js");
const tty = { isTTY: true };
const pipe = { isTTY: false };
const noEnv = {};

test("output mode: a terminal gets text, a pipe gets json", () => {
  assert.equal(resolveOutputMode({}, tty, noEnv), "text");
  assert.equal(resolveOutputMode({}, pipe, noEnv), "json");
  assert.equal(resolveOutputMode({}, undefined, noEnv), "json");
});

test("output mode: --output and CONVERLY_OUTPUT override the terminal check", () => {
  assert.equal(resolveOutputMode({ output: "json" }, tty, noEnv), "json");
  assert.equal(resolveOutputMode({ output: "TEXT" }, pipe, noEnv), "text");
  assert.equal(resolveOutputMode({}, tty, { CONVERLY_OUTPUT: "json" }), "json");
  // The flag beats the environment.
  assert.equal(resolveOutputMode({ output: "text" }, pipe, { CONVERLY_OUTPUT: "json" }), "text");
});

test("output mode: a known agent harness keeps JSON even in a pseudo-terminal", () => {
  assert.equal(resolveOutputMode({}, tty, { CLAUDECODE: "1" }), "json");
  assert.equal(resolveOutputMode({}, tty, { CODEX_SANDBOX: "seatbelt" }), "json");
  assert.equal(resolveOutputMode({}, tty, { CLAUDECODE: "" }), "text");
  // An explicit request still wins.
  assert.equal(resolveOutputMode({ output: "text" }, tty, { CLAUDECODE: "1" }), "text");
});

test("errors stay JSON unless both stdout and stderr are terminals", () => {
  assert.equal(resolveErrorMode({}, tty, tty, noEnv), "text");
  assert.equal(resolveErrorMode({}, tty, pipe, noEnv), "json", "2>err.json keeps JSON");
  assert.equal(resolveErrorMode({}, pipe, tty, noEnv), "json");
  assert.equal(resolveErrorMode({ output: "text" }, pipe, pipe, noEnv), "text");
  assert.equal(resolveErrorMode({}, tty, tty, { CLAUDECODE: "1" }), "json");
});

test("events get text skips null actions instead of crashing", () => {
  const out = formatResult(
    "events get",
    { id: "evt_1", status: "failed", actions: [null, { integration_id: "meta", server_status: "success" }] },
    { mode: "text", origin: PROD_ORIGIN, stream: pipe }
  );
  assert.match(out, /✓ Meta: success/);
});

test("no reason (and no 'undefined' command) without a destination id", () => {
  assert.equal(reasonFor("destination_not_connected", undefined), null);
  const out = withReasons({ actions: [{ server_status: "failed", error_code: "destination_not_connected" }] });
  assert.equal("reason" in out.actions[0], false);
});

test("first-conversion step says to submit the real form first", () => {
  const out = formatResult(
    "status",
    { site_id: "s", items: [{ id: "first_conversion", status: "action_needed", what_and_why: "No conversions yet.", before_running: "Make one real conversion happen first.", command: "converly events list --site s" }] },
    { mode: "text", origin: STAGING_ORIGIN, stream: pipe }
  );
  assert.match(out, /First: Make one real conversion happen first\.\n {4}Then run: converly events list --site s --staging/);
});

test("json mode is byte-identical to the old output for every command", () => {
  const result = { ok: true, origin: PROD_ORIGIN, scope: "a b" };
  for (const name of ["login", "status", "whoami", "events get", "flows list"]) {
    assert.equal(
      formatResult(name, result, { mode: "json", origin: PROD_ORIGIN }),
      JSON.stringify(result, null, 2) + "\n"
    );
  }
});

test("text mode: commands without a renderer still print JSON", () => {
  const result = { data: [] };
  assert.equal(
    formatResult("flows list", result, { mode: "text", origin: PROD_ORIGIN, stream: pipe }),
    JSON.stringify(result, null, 2) + "\n"
  );
});

test("login text names the next command, with --staging on staging", () => {
  const prod = formatResult("login", { ok: true }, { mode: "text", origin: PROD_ORIGIN, stream: pipe });
  assert.match(prod, /You're logged in to Converly\./);
  assert.match(prod, /Next, run: converly status\n/);
  const staging = formatResult("login", { ok: true }, { mode: "text", origin: STAGING_ORIGIN, stream: pipe });
  assert.match(staging, /converly status --staging/);
  assert.doesNotMatch(prod, /\u001b\[/, "no colour codes when the stream isn't a terminal");
});

test("status text: checklist with commands, no API paths", () => {
  const out = formatResult(
    "status",
    {
      site_id: "site_abc",
      items: [
        { id: "site_domain", status: "done", what_and_why: "The website address is set (example.com)." },
        {
          id: "site_domain",
          status: "action_needed",
          what_and_why: "No website address is set.",
          next: {
            kind: "ask_the_user",
            question:
              'What is the website\'s public address (for example https://example.com)? Then set it via PATCH /v1/sites/{site_id} with { "domain": "..." }.',
          },
          command: "converly sites update site_abc --domain <their-domain>",
        },
        {
          id: "destination_connections",
          status: "action_needed",
          what_and_why: "Google Ads isn't connected.",
          next: { kind: "human_browser_step", note: "Create a connect handoff (POST /v1/handoffs …)." },
          command: "converly destinations connect google-ads --site site_abc",
        },
      ],
    },
    { mode: "text", origin: PROD_ORIGIN, stream: pipe }
  );
  assert.match(out, /✓ The website address is set/);
  assert.match(out, /→ No website address is set\./);
  assert.match(out, /Ask: What is the website's public address \(for example https:\/\/example\.com\)\?\n/);
  assert.match(out, /Run: converly sites update site_abc --domain <their-domain>/);
  assert.match(out, /1 of 3 done\./);
  assert.doesNotMatch(out, /\/v1\//);
  assert.doesNotMatch(out, /PATCH|POST/);
});

test("status text names platforms and adds --staging to every command", () => {
  const out = formatResult(
    "status",
    {
      site_id: "site_abc",
      items: [
        {
          id: "destination_connections",
          status: "action_needed",
          what_and_why: "A flow sends conversions to google-ads, but google-ads isn't connected.",
          command: "converly destinations connect google-ads --site site_abc",
        },
        { id: "flows", status: "action_needed", what_and_why: "Draft.", command: "converly flows validate <flow_id>, then converly flows publish <flow_id>" },
      ],
    },
    { mode: "text", origin: STAGING_ORIGIN, stream: pipe }
  );
  assert.match(out, /sends conversions to Google Ads, but Google Ads isn't connected/);
  assert.match(out, /Run: converly destinations connect google-ads --site site_abc --staging/);
  assert.match(out, /converly flows validate <flow_id> --staging, then converly flows publish <flow_id> --staging/);
});

test("stripApiSentences keeps the question and drops the request", () => {
  assert.equal(
    stripApiSentences("Which tool renders the form? Then create the flow via POST /v1/flows."),
    "Which tool renders the form?"
  );
  assert.equal(stripApiSentences("Plain sentence."), "Plain sentence.");
});

test("whoami text shows plan, trial end and sites", () => {
  const out = formatResult(
    "whoami",
    {
      subscription: { plan_name: "Starter", status: "trialing", trial_ends_at: "2026-12-10T00:00:00Z" },
      sites: [{ id: "site_1", name: "Main", domain: "example.com" }],
    },
    { mode: "text", origin: PROD_ORIGIN, stream: pipe }
  );
  assert.match(out, /Plan:  Starter, free trial until 10 Dec 2026/);
  assert.match(out, /Main {2}example\.com {2}site_1/);
});

test("whoami text doesn't say trial twice for the trial plan", () => {
  const out = formatResult(
    "whoami",
    { subscription: { plan_name: "14-day Trial", status: "trialing", trial_ends_at: "2026-12-10T00:00:00Z" }, sites: [] },
    { mode: "text", origin: PROD_ORIGIN, stream: pipe }
  );
  assert.match(out, /Plan:  Free trial until 10 Dec 2026/);
});

test("whoami keeps a named plan's tier while trialing", () => {
  const out = formatResult(
    "whoami",
    { subscription: { plan_name: "Enterprise Trial", status: "trialing", trial_ends_at: "2026-12-10T00:00:00Z" }, sites: [] },
    { mode: "text", origin: PROD_ORIGIN, stream: pipe }
  );
  assert.match(out, /Plan:  Enterprise Trial, free trial until 10 Dec 2026/);
});

test("whoami: 'Free Trial' isn't doubled and an odd plan value doesn't crash", () => {
  const free = formatResult("whoami", { subscription: { plan_name: "Free Trial", status: "trialing" }, sites: [] }, { mode: "text", origin: PROD_ORIGIN, stream: pipe });
  assert.match(free, /Plan:  Free trial\n/);
  const odd = formatResult("whoami", { subscription: { plan_name: 42, status: "trialing" }, sites: [] }, { mode: "text", origin: PROD_ORIGIN, stream: pipe });
  assert.match(odd, /Plan:  42, free trial/);
});

test("a date-only ISO error is left alone", () => {
  assert.equal(cliSpeak("start must be an ISO 8601 date", {}), "start must be an ISO 8601 date");
});

test("cliSpeak shows the date shape instead of saying ISO 8601", () => {
  assert.equal(
    cliSpeak("occurred_after must be an ISO 8601 timestamp", { commandFlags: ["since"] }),
    "--since must be a date and time like 2026-11-25T09:00:00Z"
  );
});

test("reasonFor explains each delivery code and names the command", () => {
  const r = reasonFor("destination_not_connected", "google-ads", { origin: STAGING_ORIGIN, site: "site_1" });
  assert.match(r, /Google Ads isn't connected to this site/);
  assert.match(r, /converly destinations connect google-ads --site site_1 --staging/);
  assert.match(reasonFor("destination_needs_reconnect", "meta"), /Meta's connection stopped working/);
  assert.match(reasonFor("conversion_not_set", "google-analytics"), /Google Analytics conversion/);
  assert.match(reasonFor("destination_paused", "reddit-ads"), /paused/);
  assert.match(reasonFor("delivery_unavailable", "linkedin-ads"), /Nothing is wrong with your setup/);
  assert.equal(reasonFor("google_ads_unknown", "google-ads"), null);
  assert.equal(reasonFor(null, "google-ads"), null);
});

test("withReasons adds reason only next to known codes", () => {
  const event = {
    id: "evt_1",
    actions: [
      { integration_id: "google-ads", server_status: "failed", error_code: "destination_not_connected" },
      { integration_id: "meta", server_status: "failed", error_code: "meta_unknown" },
      { integration_id: "meta", server_status: "success", error_code: null },
    ],
  };
  assert.equal(hasKnownReason(event), true);
  const out = withReasons(event, { origin: PROD_ORIGIN, site: "site_9" });
  assert.match(out.actions[0].reason, /--site site_9$/);
  assert.equal("reason" in out.actions[1], false);
  assert.equal("reason" in out.actions[2], false);
  assert.equal(hasKnownReason({ actions: [{ error_code: "meta_unknown" }] }), false);
});

test("withReasons prefers the server's wording and turns its fix into a command", () => {
  const out = withReasons(
    {
      actions: [
        {
          integration_id: "google-ads",
          server_status: "failed",
          error_code: "destination_not_connected",
          user_message: "Google Ads isn't connected to this site, so Converly's server didn't send this conversion.",
          hint: "Connect Google Ads to this site.",
          fix: { step: "connect_destination", destination: "dest_google-ads" },
        },
        { integration_id: "meta", server_status: "failed", error_code: "delivery_unavailable", user_message: "Problem on our side.", fix: { step: "contact_support", destination: "dest_meta" } },
      ],
    },
    { origin: STAGING_ORIGIN, site: "site_1" }
  );
  assert.equal(
    out.actions[0].reason,
    "Google Ads isn't connected to this site, so Converly's server didn't send this conversion. Connect Google Ads to this site. Run: converly destinations connect google-ads --site site_1 --staging"
  );
  assert.equal(out.actions[1].reason, "Problem on our side.");
  // choose_conversion, a null destination (falls back to the action's), and no command for edit_flow_action
  const more = withReasons({ actions: [
    { integration_id: "linkedin-ads", error_code: "conversion_not_set", user_message: "Pick a conversion.", fix: { step: "choose_conversion", destination: null } },
    { integration_id: "meta", error_code: "x", user_message: "Edit the flow.", fix: { step: "edit_flow_action", destination: "dest_meta" } },
  ] }, { origin: PROD_ORIGIN, site: "site_2" });
  assert.equal(more.actions[0].reason, "Pick a conversion. Run: converly destinations conversions linkedin-ads --site site_2");
  assert.equal(more.actions[1].reason, "Edit the flow.");
  assert.equal(hasKnownReason({ actions: [{ user_message: "x", error_code: "meta_unknown" }] }), true);
});

test("events get text shows each destination and its reason", () => {
  const out = formatResult(
    "events get",
    {
      id: "evt_1",
      occurred_at: "2026-11-26T04:00:00Z",
      flow_name: "Leads",
      status: "failed",
      actions: [
        { integration_id: "google-ads", server_status: "failed", error_code: "destination_not_connected", reason: "Google Ads isn't connected." },
        { integration_id: "meta", server_status: "success" },
        { integration_id: "reddit-ads", server_status: "failed", error_code: "reddit_unknown" },
      ],
    },
    { mode: "text", origin: PROD_ORIGIN, stream: pipe }
  );
  assert.match(out, /✗ Google Ads: failed\n {4}Google Ads isn't connected\./);
  assert.match(out, /✓ Meta: success/);
  assert.match(out, /Reason code: reddit_unknown/);
});

test("cliSpeak turns API field names into the command's own flags", () => {
  assert.equal(
    cliSpeak("site_id is required on multi-site accounts", { commandFlags: ["site"] }),
    "--site is required on multi-site accounts"
  );
  assert.equal(
    cliSpeak("occurred_after must not be later than occurred_before", { commandFlags: ["since", "until"] }),
    "--since must not be later than --until"
  );
});

test("cliSpeak never suggests a flag the command doesn't take, and leaves codes alone", () => {
  assert.equal(cliSpeak("site_id is required", { commandFlags: [] }), "site_id is required");
  assert.equal(cliSpeak("site_id_required: pass site_id", { commandFlags: ["site"] }), "site_id_required: pass --site");
  const translated = translateError(
    { code: "site_id_required", message: "Pass site_id.", status: 400 },
    { commandFlags: ["site"] }
  );
  assert.equal(translated.code, "site_id_required");
  assert.equal(translated.message, "Pass --site.");
});

test("cliSpeak points login advice at the deployment in use", () => {
  assert.equal(
    cliSpeak("Not logged in. Run `converly login` (or set CONVERLY_API_KEY).", { origin: STAGING_ORIGIN }),
    "Not logged in. Run `converly login --staging` (or set CONVERLY_API_KEY)."
  );
  assert.equal(cliSpeak("Run `converly login`.", { origin: PROD_ORIGIN }), "Run `converly login`.");
  assert.equal(deploymentFlag("https://example.test"), " --api https://example.test");
});

test("formatError: json stays json, text reads as a sentence", () => {
  const payload = { error: { code: "not_logged_in", message: "Not logged in." } };
  assert.equal(formatError(payload, { mode: "json" }), JSON.stringify(payload, null, 2) + "\n");
  const text = formatError(payload, { mode: "text", stream: pipe });
  assert.equal(text, "Error: Not logged in.\n(not_logged_in)\n");
});

function runCli(args, env = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "converly-out-"));
  return spawnSync(process.execPath, [BIN, ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home, CONVERLY_API_KEY: "", ...env },
    encoding: "utf8",
  });
}

test("end to end: a piped run still prints JSON errors", () => {
  const r = runCli(["status"]);
  assert.equal(r.status, 1);
  const parsed = JSON.parse(r.stderr);
  assert.equal(parsed.error.code, "not_logged_in");
});

test("end to end: --output text prints a sentence and the staging login command", () => {
  const r = runCli(["status", "--staging", "--output", "text"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^Error: Not logged in to .*Run `converly login --staging`/);
});

test("end to end: a bad --output value is refused", () => {
  const r = runCli(["status", "--output", "yaml"]);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stderr).error.code, "invalid_flag_value");
});
