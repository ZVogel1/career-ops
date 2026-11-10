# MatchScan (free Jobscan-style ATS matcher, career-ops powered)

Web UI branded **MatchScan** — Match Rate (75%+ target), hard/soft skills, searchability,
recruiter tips, ATS vendor rules — over career-ops engines (`keyword-match.mjs`,
`verify-ats.mjs`, `jd-skill-gap.mjs`). Original UI (not affiliated with Jobscan).
Every scan is saved to a **database**; **notifications** cover scan results, library saves,
and tracker follow-ups. Diagnostic only — never edits files or fabricates keywords.

**Jobs stay fresh:** while the server runs it re-runs `scan.mjs` every **6 hours**
(`JOBS_REFRESH_HOURS`, set `JOBS_AUTO_REFRESH=0` to disable). Click **Refresh jobs now**
anytime. The Jobs feed merges your scored dump with last-3-day eng/remote/CLT hits from
`data/scan-history.tsv`.

## Run locally (free, private by default)

```bash
cd /Users/zacharyvogel/Documents/GitHub/career-ops   # wrong cwd = MODULE_NOT_FOUND
node tools/ats-site/server.mjs
# -> http://127.0.0.1:4317    (storage: tools/ats-site/local-data.json)
```

**Self-hosted only:** the server binds `127.0.0.1` — reachable solely from this Mac.
Nothing is on your network or the internet, no accounts, $0 forever (the Mac just
has to be on when you use it). To open it to *your own* Wi-Fi devices only
(e.g. your phone at home): `HOST=0.0.0.0 SITE_PASSWORD=<password> node tools/ats-site/server.mjs`
— still self-hosted, never public; keep the password on in that mode.

Optional local password + Neon: copy `.env.example` values into `tools/ats-site/.env`
(`SITE_PASSWORD=...`, `DATABASE_URL=postgres://...`) or export them in the shell.

## Host it free (Render + Neon) — always-on public URL

Personal files (`cv.md`, tracker, `output/`) are **not in git and never deployed** —
hosted resumes/JDs live in the Neon **Library** instead. Only code deploys.

1. **Neon (database, free):** sign up at neon.tech → New Project → copy the
   **connection string** (`postgres://user:pass@ep-....aws.neon.tech/db?sslmode=require`).
   Free tier: 0.5 GB, scales to zero when idle, no card.
2. **Push the code:** in this repo —
   `git add tools/ats-site render.yaml .gitignore && git commit -m "ats-site" && git push`
3. **Render (host, free):** sign up at render.com → New → **Blueprint** → pick
   `ZVogel1/career-ops` → it reads `render.yaml`. When prompted, set:
   - `DATABASE_URL` = the Neon connection string from step 1
   - `SITE_PASSWORD` = a password you'll use to sign in
4. Open the `*.onrender.com` URL, sign in, and seed your library: paste your resume
   (Library → Resume → save), paste JDs as you evaluate them. Scans, history, and
   notifications persist in Neon from there.

Free-tier reality: Render free services **sleep after ~15 min idle** and take
~30–60 s to wake on the next visit. Neon wakes in ~1 s. $0 total.

## Features

- **ATS scan (Jobscan-style):** weighted Match Rate (hard skills → education → job title → soft
  skills), Searchability, JD-vs-resume keyword counts, exclude-irrelevant keywords, Recruiter
  Tips (measurable results, pronouns, clichés, bullet length), company/ATS-vendor rules
  (Workday/Greenhouse/Lever/Ashby auto-detected), resume-vs-resume compare, scan history +
  Match Rate trend chart.
- **Paste-URL JD fetch:** paste a Greenhouse / Lever / Ashby / Workday URL → pulls the posting
  text via `fetch-jd.mjs` into the scanner.
- **Keyword in JD context:** click any present/missing/thin chip to see the surrounding JD
  sentence(s).
- **Exact-form warnings:** flags when the resume only has a singular/plural or synonym variant
  of a JD keyword (some ATSes match the exact form only).
- **Predicted skills:** role-family skills common for the JD but not listed in it (add only if true).
- **Power Edit:** surfaces cv.md-supported keywords still missing from the resume + weakest
  bullets; Copy AI prompt (any chat model) or optional local Ollama rewrite — reformulate only,
  never fabricate.
- **Cover letter scan:** keyword coverage + structure checks against the same JD.
- **Tracker kanban:** your `data/applications.md` as drag-and-drop columns; status changes
  write through `set-status.mjs` (validated + status-logged).
- **Jobs for you:** newest Apply/Check candidates from the board-refresh dump, with
  Load-JD-&-scan and per-job **x/10 match score vs your CV** (fetches the JD from the employer ATS).
- **Resume tailorer / CV maker:** pick Resume (1p, Jake) or Full CV (2p, Modern); it selects and
  reorders your **verbatim** `cv.md` bullets/skills by JD relevance — never invents content —
  then passes `verify-cv-facts` + `cv-title-check`, builds the PDF (strict 1-page for resumes),
  scores parseability, and saves the result to the Library.
  *(LinkedIn optimizer intentionally skipped.)*

## How it works

- **Sources:** repo files (`cv.md`, `output/source/*.html`, `jds/*.md`) when they exist
  on disk (local), plus database Library documents (everywhere). Picking an HTML
  resume also scores that file with `verify-ats.mjs`.
- **Storage:** `DATABASE_URL` → Neon Postgres via its HTTPS SQL API (zero npm deps);
  otherwise a local JSON file. Tables: `documents`, `scans`, `notifications` (auto-created).
- **Notifications:** every scan + library save creates one; locally, due/overdue rows
  from `data/follow-ups.md` are turned into follow-up alerts automatically (deduped).
- **Auth:** `SITE_PASSWORD` set → signed-cookie session (7 days). Unset → open (local dev only).
