# Converly CLI

Set up and manage [Converly](https://converly.io) conversion tracking from the command line. Built for AI agents (Claude Code, OpenClaw, Codex) and for people.

Converly tracks form submissions on your website and sends them as conversions to ad platforms (Google Ads, Meta, GA4, LinkedIn, TikTok and more), including server-side delivery like Google Enhanced Conversions and Meta CAPI.

## Install

You need Node.js 18 or newer. If you don't have it, install the current version from [nodejs.org](https://nodejs.org).

```bash
npm install -g @converly/cli
```

This installs the `converly` command. To try it without installing anything, put `npx @converly/cli` in place of `converly`, for example `npx @converly/cli login`.

## Log in

```bash
converly login
```

This opens your browser. Log in, or create an account there (new accounts start a 14-day free trial with no credit card). The CLI stores its login in `~/.converly/config.json`, so there's no API key to copy around. The login can't touch billing, delete sites, or read your ad platform credentials.

On a server, over SSH, in CI, or anywhere without a browser, use device login:

```bash
converly login --device
```

It prints a short code and a link. Open the link on any phone or computer, check the code matches, and approve. The CLI switches to device login by itself when it can't open a browser.

Automated jobs can set `CONVERLY_API_KEY` instead.

## See what's left to do

```bash
converly status
```

A checklist of your setup: what's done, what isn't, and the exact command for each next step. Run it any time.

## Set up tracking

```bash
converly status
converly sites update site_XXX --domain example.com
converly install snippet site_XXX            # add the tag to your website's <head>
converly destinations connect google-ads --site site_XXX
converly handoffs wait hdf_XXX               # finish connecting in the browser
converly destinations conversions google-ads --site site_XXX   # pick the conversion to report
converly flows create --site site_XXX --name "Demo requests" \
  --trigger generic-form --destination google-ads --conversion-id 123456
converly flows validate flow_XXX
converly flows publish flow_XXX
```

Then submit the real form on your website once and check it arrived:

```bash
converly events list --limit 10
converly events get evt_XXX                  # whether each ad platform accepted it, and why not
```

A real submission is the only end-to-end proof: it shows the tag is on the page, the form is detected and the conversion reached the ad platform. `converly test-event --flow flow_XXX` only checks the last step, sending to the ad platform. For Google Ads, GA4, LinkedIn and ChatGPT Ads that sends a real conversion, so it needs `--allow-real`. Meta, Reddit and TikTok can use their test codes instead (`--meta-code`, `--reddit-id`, `--tiktok-code`).

## Output

In a terminal, `login`, `status`, `whoami`, `events get` and error messages print plain sentences. Everywhere else, for example when an AI agent or a script runs the CLI, every data command prints one JSON document on stdout. Use `--output json` or `--output text` to choose (or set `CONVERLY_OUTPUT`).

## For AI agents

The agent runbook lives at [github.com/converlyio/converly-agent](https://github.com/converlyio/converly-agent). Install it with `npx skills add converlyio/converly-agent` or `clawhub install converly`. It teaches the full workflow, including the parts that need a person (approving a login, authorizing an ad platform, adding the tag to the website).

Design notes for agent use:

- When stdout isn't a terminal, stdout is one JSON document for every data command (help and version print text), and progress goes to stderr. Pass `--output json` to be certain.
- Exit code 0 means success. Errors are JSON on stderr with the API's error code.
- `converly login --device` is the way to log in from a headless agent: it prints a code and a link for the person to approve.
- Each POST generates an idempotency key for its own internal retry. To make an explicit retry of the same operation safe across invocations, pass the same `--idempotency-key` value both times.
- Ad platform credentials never pass through the CLI. Connecting a destination returns a Converly-hosted link where a person authorizes the platform directly.

## All commands

Run `converly help` for the full list, or `converly help <command>` for one command's usage. Anything the named commands don't cover is reachable via `converly api <METHOD> <path>`. The full REST API is documented at [developers.converly.io](https://developers.converly.io).

## License

MIT
