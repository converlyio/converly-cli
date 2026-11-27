/**
 * How results and errors are shown.
 *
 * Two audiences use the CLI. AI agents and scripts read stdout as one JSON
 * document, and that contract never changes for them. People typing in a
 * terminal get plain sentences for the commands a newcomer runs first
 * (login, status, whoami, events get), for help and support, and for errors.
 *
 * The switch is whether stdout is a terminal. Agents run the CLI with
 * stdout piped, so they keep JSON without doing anything. `--output json`
 * forces JSON anywhere and `--output text` forces sentences anywhere.
 * (`--json` was not available: it already carries request bodies on
 * `flows create`, `flows update` and `api`.)
 */

import { PROD_ORIGIN, STAGING_ORIGIN } from "./config.js";

export const OUTPUT_MODES = ["json", "text"];

// Some agent harnesses run commands inside a pseudo-terminal, so stdout
// looks like a terminal even though a model is reading it. These are the
// markers the common ones set; any of them keeps JSON. The agent skill also
// tells agents to add --output json if they ever see sentences.
const AGENT_ENV_MARKERS = [
  "CLAUDECODE", // Claude Code
  "CODEX_SANDBOX", // OpenAI Codex CLI
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "GEMINI_CLI", // Gemini CLI
  "CURSOR_AGENT", // Cursor's agent terminal
  "OPENCLAW", // OpenClaw
];

export function isAgentEnvironment(env = process.env) {
  return AGENT_ENV_MARKERS.some((name) => env[name] !== undefined && env[name] !== "");
}

/** "text" or "json" for this run. */
export function resolveOutputMode(flags, stream = process.stdout, env = process.env) {
  const asked = typeof flags.output === "string" ? flags.output.toLowerCase() : null;
  if (asked === "json" || asked === "text") return asked;
  const fromEnv = typeof env.CONVERLY_OUTPUT === "string" ? env.CONVERLY_OUTPUT.toLowerCase() : null;
  if (fromEnv === "json" || fromEnv === "text") return fromEnv;
  if (isAgentEnvironment(env)) return "json";
  return stream && stream.isTTY ? "text" : "json";
}

/**
 * Errors go to stderr, so a terminal on stdout alone isn't enough: a script
 * that captures stderr (`converly status 2>err.json`) must still get JSON.
 * Text only when the person asked for it, or when both streams are terminals.
 */
export function resolveErrorMode(flags, stdout = process.stdout, stderr = process.stderr, env = process.env) {
  const asked = typeof flags.output === "string" ? flags.output.toLowerCase() : null;
  const fromEnv = typeof env.CONVERLY_OUTPUT === "string" ? env.CONVERLY_OUTPUT.toLowerCase() : null;
  if (asked === "json" || asked === "text") return asked;
  if (fromEnv === "json" || fromEnv === "text") return fromEnv;
  if (isAgentEnvironment(env)) return "json";
  return stdout && stdout.isTTY && stderr && stderr.isTTY ? "text" : "json";
}

// ---------------------------------------------------------------------------
// Small text helpers

function useColor(stream = process.stdout, env = process.env) {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  return Boolean(stream && stream.isTTY);
}

function paint(code, text, color) {
  return color ? `\u001b[${code}m${text}\u001b[0m` : text;
}

const bold = (t, c) => paint("1", t, c);
const dim = (t, c) => paint("2", t, c);
const green = (t, c) => paint("32", t, c);
const yellow = (t, c) => paint("33", t, c);
const red = (t, c) => paint("31", t, c);

/** The flag that points a command at the same deployment it just used. */
export function deploymentFlag(origin) {
  if (!origin || origin === PROD_ORIGIN) return "";
  if (origin === STAGING_ORIGIN) return " --staging";
  return ` --api ${origin}`;
}

function formatDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function formatDateTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Setup-status wording is written for API callers and sometimes ends with
// "Then set it via PATCH /v1/sites/{site_id} …". A person needs the
// question, not the request. Drop any sentence that names an API path.
export function stripApiSentences(text) {
  if (typeof text !== "string") return "";
  // A sentence ends at . ? or ! followed by a space and a capital letter, so
  // "example.com" and "{ \"domain\": \"...\" }" don't split mid-sentence.
  const sentences = text.split(/(?<=[.?!])\s+(?=[A-Z])/);
  return sentences
    .filter((s) => !/\b(GET|POST|PATCH|DELETE)\s+\/v1\//.test(s) && !/\/v1\/[a-z]/.test(s))
    .join(" ")
    .trim();
}

// ---------------------------------------------------------------------------
// Delivery failure reasons, shared by events get/list in both modes.

const DESTINATION_NAMES = {
  "google-ads": "Google Ads",
  meta: "Meta",
  "meta-ads": "Meta",
  "google-analytics": "Google Analytics",
  ga4: "Google Analytics",
  "linkedin-ads": "LinkedIn",
  "reddit-ads": "Reddit",
  "tiktok-ads": "TikTok",
  "chatgpt-ads": "ChatGPT Ads",
  "microsoft-ads": "Microsoft Ads",
};

export function destinationName(slug) {
  return DESTINATION_NAMES[slug] ?? slug;
}

// "A flow sends conversions to google-ads, but google-ads isn't connected"
// reads better with the platform's name. Only the "to X" / "but X" shapes
// the setup checklist uses are touched, so a slug inside a command is left as is.
const SLUG_IN_PROSE = new RegExp(
  `\\b(to|but) (${Object.keys(DESTINATION_NAMES).map((k) => k.replace(/-/g, "\\-")).join("|")})(?![\\w-])`,
  "g"
);
function proseNames(text) {
  return typeof text === "string" ? text.replace(SLUG_IN_PROSE, (_, w, slug) => `${w} ${destinationName(slug)}`) : text;
}

/** Point every `converly ...` command in a suggestion at the same deployment. */
function withDeployment(command, origin) {
  const dep = deploymentFlag(origin);
  return dep ? command.replace(/converly [^,]*/g, (c) => c.trimEnd() + dep) : command;
}

/**
 * A plain sentence for an action's error_code, or null when the code is
 * unknown (the code itself is still shown). `site` is the site id when the
 * caller knows it, so the suggested command is copy-pasteable.
 */
export function reasonFor(errorCode, integrationId, { origin, site } = {}) {
  // Without the destination there's no honest command to suggest.
  if (!errorCode || typeof integrationId !== "string" || integrationId === "") return null;
  const name = destinationName(integrationId);
  const siteArg = site ? ` --site ${site}` : " --site <site_id>";
  const dep = deploymentFlag(origin);
  switch (errorCode) {
    case "destination_not_connected":
      return `${name} isn't connected to this site, so Converly's server couldn't send it. Connect it with: converly destinations connect ${integrationId}${siteArg}${dep}`;
    case "destination_needs_reconnect":
      return `${name}'s connection stopped working and needs to be reconnected. Reconnect it with: converly destinations connect ${integrationId}${siteArg}${dep}`;
    case "conversion_not_set":
      return `The flow doesn't say which ${name} conversion to report. Pick one with: converly destinations conversions ${integrationId}${siteArg}${dep}, then update the flow.`;
    case "destination_paused":
      return `Sending to ${name} is paused for this site on Converly's side. Contact Converly support.`;
    case "delivery_unavailable":
      return `Converly couldn't send this to ${name} because of a problem on Converly's side. Nothing is wrong with your setup. Contact Converly support if it keeps happening.`;
    default:
      return null;
  }
}

/** True when any action carries a code reasonFor() can explain. */
export function hasKnownReason(event) {
  return Boolean(
    event &&
      Array.isArray(event.actions) &&
      event.actions.some(
        (a) =>
          (typeof a?.user_message === "string" && a.user_message !== "") ||
          reasonFor(a?.error_code, a?.integration_id) !== null
      )
  );
}

/** Add a `reason` sentence next to every known error_code in an event. */
// What the API's structured `fix` (or, from an older API, the code) means
// as a CLI command. The wording itself comes from the server when it sends
// some; the CLI's own sentences above are only the fallback for an API that
// doesn't yet.
const FIX_FOR_CODE = {
  destination_not_connected: "connect_destination",
  destination_needs_reconnect: "connect_destination",
  conversion_not_set: "choose_conversion",
  destination_paused: "contact_support",
  delivery_unavailable: "contact_support",
};

export function fixCommand(fix, integrationId, { origin, site } = {}) {
  if (typeof integrationId !== "string" || integrationId === "") return null;
  const siteArg = site ? ` --site ${site}` : " --site <site_id>";
  const dep = deploymentFlag(origin);
  // Steps from the API's fix.step (delivery-error-copy.ts). edit_flow_action
  // and contact_support have no single command, so the text stands alone.
  switch (fix) {
    case "connect_destination":
      return `converly destinations connect ${integrationId}${siteArg}${dep}`;
    case "choose_conversion":
      return `converly destinations conversions ${integrationId}${siteArg}${dep}`;
    default:
      return null;
  }
}

function serverReason(action, ctx) {
  const text = [action.user_message, action.hint]
    .filter((t) => typeof t === "string" && t.trim() !== "")
    .join(" ");
  if (!text) return null;
  // fix is { step, destination: "dest_<slug>" | null } or null.
  const fix = action.fix && typeof action.fix === "object" ? action.fix : null;
  const fromFix =
    fix && typeof fix.destination === "string" && fix.destination.startsWith("dest_")
      ? fix.destination.slice("dest_".length)
      : null;
  const destination = fromFix || action.integration_id;
  const command = fixCommand(fix ? fix.step : FIX_FOR_CODE[action.error_code], destination, ctx);
  return command ? `${text} Run: ${command}` : text;
}

export function withReasons(event, { origin, site } = {}) {
  if (!event || typeof event !== "object" || !Array.isArray(event.actions)) return event;
  return {
    ...event,
    actions: event.actions.map((a) => {
      if (!a || typeof a !== "object") return a;
      const reason =
        serverReason(a, { origin, site }) ??
        reasonFor(a.error_code, a.integration_id, { origin, site });
      return reason ? { ...a, reason } : a;
    }),
  };
}

// ---------------------------------------------------------------------------
// Text renderers, keyed by command name. A command without one prints JSON
// even in a terminal.

/** The server's own sentence(s) for this reply, printed as given. */
function guidanceText(result) {
  const g = result?.assistant_guidance;
  return g && typeof g.text === "string" && g.text.trim() !== "" ? g.text.trim() : null;
}

function renderLogin(result, { origin, color }) {
  const lines = [green("✓", color) + " " + bold("You're logged in to Converly.", color)];
  if (origin && origin !== PROD_ORIGIN) lines.push(dim(`  (${origin})`, color));
  lines.push("", `Next, run: ${bold(`converly status${deploymentFlag(origin)}`, color)}`);
  lines.push(dim("It lists what's set up and the exact command for each next step.", color));
  return lines.join("\n");
}

const STATUS_MARKS = {
  done: ["✓", green],
  action_needed: ["→", yellow],
  blocked: ["✗", red],
  unknown: ["?", dim],
  manual_check: ["!", yellow],
};

function renderStatus(result, { origin, color }) {
  const items = Array.isArray(result?.items) ? result.items : [];
  const done = items.filter((i) => i.status === "done").length;
  const lines = [bold("Setup checklist", color) + dim(`  site ${result?.site_id ?? ""}`, color), ""];
  for (const item of items) {
    const [mark, tint] = STATUS_MARKS[item.status] ?? ["•", (t) => t];
    lines.push(`${tint(mark, color)} ${proseNames(stripApiSentences(item.what_and_why))}`);
    const next = item.next;
    if (item.status !== "done" && next) {
      if (next.kind === "ask_the_user" && next.question) {
        const q = stripApiSentences(next.question);
        if (q) lines.push(`    Ask: ${q}`);
      } else if (next.kind === "manual_check" && next.note) {
        const n = stripApiSentences(next.note);
        if (n) lines.push(`    Check: ${n}`);
      }
    }
    if (item.command) {
      if (item.before_running) lines.push(`    First: ${item.before_running}`);
      const run = item.before_running ? "Then run" : "Run";
      lines.push(`    ${run}: ${bold(withDeployment(item.command, origin), color)}`);
    }
    lines.push("");
  }
  lines.push(
    items.length === 0
      ? "Nothing to check yet."
      : `${done} of ${items.length} done.` +
          (done === items.length ? " Tracking is set up." : "")
  );
  const note = guidanceText(result);
  if (note) lines.push("", note);
  return lines.join("\n");
}

function describeSubscription(sub) {
  if (!sub || typeof sub !== "object") return null;
  const plan = String(sub.plan_name ?? sub.plan_id ?? "Unknown plan");
  if (sub.status === "trialing") {
    const ends = formatDate(sub.trial_ends_at);
    const until = ends ? ` until ${ends}` : "";
    // The trial plan is itself called "14-day Trial"; don't say trial twice.
    return /^(\d+[- ]day |free )?trial$/i.test(plan.trim()) ? `Free trial${until}` : `${plan}, free trial${until}`;
  }
  if (sub.status === "active") {
    return sub.cancel_at_period_end
      ? `${plan}, cancels on ${formatDate(sub.current_period_end) ?? "the period end"}`
      : `${plan}, active`;
  }
  return `${plan} (${String(sub.status ?? "unknown").replace(/_/g, " ")})`;
}

function renderWhoami(result, { origin, color }) {
  const lines = [bold("Converly account", color)];
  if (origin && origin !== PROD_ORIGIN) lines.push(dim(`(${origin})`, color));
  const plan = describeSubscription(result?.subscription);
  if (plan) lines.push(`Plan:  ${plan}`);
  const sites = Array.isArray(result?.sites) ? result.sites : [];
  lines.push(`Sites: ${sites.length === 0 ? "none yet" : ""}`.trimEnd());
  for (const s of sites) {
    lines.push(`  ${s.name ?? "Untitled site"}  ${dim(s.domain ?? "no website address yet", color)}  ${dim(s.id, color)}`);
  }
  if (result?.sites_note) lines.push(dim(result.sites_note, color));
  return lines.join("\n");
}

function renderEvent(result, { color }) {
  const when = formatDateTime(result?.occurred_at);
  const head = [`Conversion ${result?.id ?? ""}`.trim()];
  if (when) head.push(when);
  if (result?.flow_name) head.push(`flow "${result.flow_name}"`);
  const lines = [bold(head.join(" · "), color)];
  if (result?.status) lines.push(`Status: ${String(result.status).replace(/_/g, " ")}`);
  const actions = Array.isArray(result?.actions) ? result.actions : [];
  if (actions.length > 0) lines.push("");
  for (const a of actions) {
    if (!a || typeof a !== "object") continue;
    const status = a.server_status ?? a.client_status ?? "unknown";
    const ok = status === "success" || status === "sent";
    const failed = status === "failed";
    const mark = ok ? green("✓", color) : failed ? red("✗", color) : yellow("•", color);
    lines.push(`${mark} ${destinationName(a.integration_id)}: ${String(status).replace(/_/g, " ")}`);
    if (a.reason) lines.push(`    ${a.reason}`);
    else if (a.error_code) lines.push(`    Reason code: ${a.error_code}`);
  }
  const notices = Array.isArray(result?.notices) ? result.notices : [];
  for (const n of notices) {
    const text = n?.user_message ?? n?.message ?? n?.error_code;
    if (text) lines.push(`! ${text}`);
  }
  const note = guidanceText(result);
  if (note) lines.push("", note);
  return lines.join("\n");
}

function renderHelpSearch(result, { color }) {
  const articles = Array.isArray(result?.articles) ? result.articles : [];
  const lines = [];
  for (const a of articles) {
    if (!a || typeof a !== "object") continue;
    lines.push(bold(a.title ?? a.url ?? "Untitled", color));
    if (a.description) lines.push(`  ${a.description}`);
    if (a.url) lines.push(dim(`  ${a.url}`, color));
    lines.push("");
  }
  const note = guidanceText(result);
  if (note) lines.push(note);
  else if (articles.length === 0) lines.push("No help articles matched.");
  return lines.join("\n").trimEnd();
}

function renderHelpArticle(result, { color }) {
  const article = result?.article ?? {};
  const lines = [];
  if (article.title) lines.push(bold(article.title, color));
  if (article.url) lines.push(dim(article.url, color));
  if (article.text) lines.push("", String(article.text).trim());
  const note = guidanceText(result);
  if (note) lines.push("", note);
  return lines.join("\n");
}

function renderSupport(result) {
  return guidanceText(result) ?? "Sent to Converly support.";
}

const RENDERERS = {
  login: renderLogin,
  status: renderStatus,
  whoami: renderWhoami,
  "events get": renderEvent,
  "docs search": renderHelpSearch,
  "docs read": renderHelpArticle,
  support: renderSupport,
};

/**
 * The string to write to stdout for a successful command.
 */
export function formatResult(commandName, result, { mode, origin, stream = process.stdout, env = process.env }) {
  const renderer = RENDERERS[commandName];
  if (mode === "text" && renderer) {
    return renderer(result, { origin, color: useColor(stream, env) }) + "\n";
  }
  return JSON.stringify(result ?? { ok: true }, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// Errors

// API field names that leak into server error messages, and the CLI flag a
// person actually types. Only applied when the command HAS that flag, so a
// message is never rewritten to suggest a flag the command doesn't take.
const FIELD_TO_FLAG = [
  ["occurred_after", "since"],
  ["occurred_before", "until"],
  ["action_id", "action-id"],
  ["flow_id", "flow"],
  ["site_id", "site"],
];

/**
 * Rewrite API wording in an error sentence into what a CLI user types.
 * `commandFlags` is the list of flags the command accepts.
 */
export function cliSpeak(text, { commandFlags = [], origin } = {}) {
  if (typeof text !== "string" || text === "") return text;
  let out = text;
  for (const [field, flag] of FIELD_TO_FLAG) {
    if (!commandFlags.includes(flag)) continue;
    // "set some_flag: true" / "some_flag=true" → "add --some-flag"
    out = out.replace(
      new RegExp(`\\bset\\s+${field}\\s*[:=]\\s*true\\b`, "g"),
      `add --${flag}`
    );
    out = out.replace(new RegExp(`\\b${field}\\s*[:=]\\s*true\\b`, "g"), `--${flag}`);
    out = out.replace(new RegExp(`\\b${field}\\b`, "g"), `--${flag}`);
  }
  // "ISO 8601" means nothing to most people; show the shape instead.
  out = out.replace(
    /\bmust be an ISO[ -]?8601 (timestamp|date[- ]?time)\b/gi,
    "must be a date and time like 2026-11-25T09:00:00Z"
  );
  // Point login advice at the deployment the command was aimed at.
  const dep = deploymentFlag(origin);
  if (dep) {
    out = out.replace(/`converly login`/g, `\`converly login${dep}\``);
    out = out.replace(/`converly login --device`/g, `\`converly login --device${dep}\``);
  }
  return out;
}

/** Apply cliSpeak to every human-readable field of an error object. */
export function translateError(error, ctx) {
  const out = { ...error };
  for (const key of ["message", "user_message", "hint"]) {
    if (typeof out[key] === "string") out[key] = cliSpeak(out[key], ctx);
  }
  return out;
}

/** The string to write to stderr for a failed command. */
export function formatError(payload, { mode, stream = process.stderr, env = process.env }) {
  if (mode !== "text") return JSON.stringify(payload, null, 2) + "\n";
  const color = useColor(stream, env);
  const error = payload?.error ?? {};
  const main = error.user_message ?? error.message ?? "Something went wrong.";
  const lines = [`${red("Error:", color)} ${main}`];
  if (error.user_message && error.message && error.message !== error.user_message) {
    lines.push(dim(error.message, color));
  }
  if (error.hint) lines.push(error.hint);
  const note = error.assistant_guidance?.text;
  if (typeof note === "string" && note !== main && !lines.includes(note)) lines.push(note);
  if (payload?.handoff?.url) lines.push(`Open this link to finish: ${payload.handoff.url}`);
  if (error.retryable) lines.push("It's safe to run the same command again.");
  if (error.idempotency_key) {
    lines.push(dim(`To retry without risking a duplicate, add --idempotency-key ${error.idempotency_key}`, color));
  }
  if (error.code) lines.push(dim(`(${error.code}${error.status ? `, HTTP ${error.status}` : ""})`, color));
  return lines.join("\n") + "\n";
}
