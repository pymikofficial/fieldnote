# Fieldnote

Speak a messy classroom or field observation, get back a clean structured report with highlights, flags, and next steps.

**Live:** [cosmik-fieldnote.netlify.app](https://cosmik-fieldnote.netlify.app)

Part of the [cosmik.work](https://cosmik.work) Education OS suite.

## The headache

Field observations (a classroom walkthrough, a site visit, an inspection) get captured as a voice memo or a scrawled note in the moment, then either get typed up properly hours later when the detail has faded, or never get written up at all. Fieldnote is meant to be usable in the moment: speak or type the raw observation right there, and get back something structured enough to actually act on or hand off.

## The machinery

Single-page frontend, one Netlify Function, Netlify Blobs for the daily usage counter. No job-polling pattern here (unlike the multi-call tools in this suite): one observation is short enough for a single Claude call to finish inside Netlify's synchronous function timeout, so the frontend just waits on one request.

1. Voice input via the browser's native Web Speech API (Chromium-based browsers), or type directly. No third-party transcription service involved.
2. The note is PII-scrubbed (emails, phone numbers) before it reaches the API.
3. One Claude call turns the raw note into `{ summary, highlights, flags, nextSteps }`.

## Guardrails

- **PII scrub**: emails and phone numbers are stripped from the note before it's sent to Claude.
- **Daily rate limit, global and per-IP**: a shared daily cap keeps total API spend bounded, plus a per-IP cap so one scripted client can't consume the whole shared quota on its own.
- **Input cap**: 4,000 characters per observation.
- **CORS locked to this site's own origin**, the generation endpoint isn't meant to be called from anywhere else.

## Environment variables (all required)

| Variable | What it is |
|---|---|
| `ANTHROPIC_API_KEY` | Shared Anthropic API key (reused across cosmik.work tools) |
| `NETLIFY_SITE_ID` | This site's ID, from Project details |
| `NETLIFY_BLOBS_TOKEN` | Netlify Personal Access Token (shared) |
| `DAILY_CAP` | Optional, defaults to 20 |
| `DAILY_CAP_PER_IP` | Optional, defaults to 6 |

Note: `getStore()` must be called with explicit `siteID` and `token`. Relying on ambient environment configuration throws `"The environment has not been configured to use Netlify Blobs"` in this deployment setup.

## Run it locally

1. Clone this repo.
2. `npm install`
3. `netlify dev` (with the env vars above set)

Built by [Soumik Chatterjee](https://cosmik.work).
