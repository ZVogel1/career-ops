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
cd /path/to/career-ops   # must be the repo root (wrong cwd = MODULE_NOT_FOUND)
node tools/ats-site/server.mjs
# -> http://127.0.0.1:4317    (storage: tools/ats-site/local-data.json)
```

**Self-hosted only:** the server binds `127.0.0.1` — reachable solely from this machine.
Nothing is on your network or the internet, no accounts, $0 forever (the machine just
has to be on when you use it). To open it to *your own* Wi-Fi devices only
(e.g. your phone at home): `HOST=0.0.0.0 SITE_PASSWORD=<password> node tools/ats-site/server.mjs`
— still self-hosted, never public; keep the password on in that mode.

Optional local password + Neon: copy `.env.example` values into `tools/ats-site/.env`
(`SITE_PASSWORD=...`, `DATABASE_URL=postgres://...`) or export them in the shell.

## Share with friends (their data, not yours)

career-ops already splits **system code** (safe to push) from **user layer** (gitignored).
Friends clone the repo, then personalize. Your CV, tracker, portals, outreach, and PDFs
never leave your machine unless you force-add them.

**What stays private (gitignored — do not `git add -f`):**
`cv.md`, `config/profile.yml`, `portals.yml`, `modes/_profile.md`, `modes/_custom.md`,
`data/*` (tracker, scan history, apply board, outreach, board decisions), `output/*`,
`reports/*`, `jds/*`, `interview-prep/*`, `documents/*`, `tools/ats-site/.env`,
`tools/ats-site/local-data.json`.

**What a friend does after clone:**
```bash
git clone <your-public-fork-or-upstream> career-ops && cd career-ops
npm install
npx playwright install chromium   # only if they want PDF generation
node doctor.mjs --json --init-templates
# then paste their CV / answer onboarding prompts (or copy templates and edit)
node tools/ats-site/server.mjs
```
Their name, email, archetypes, and target cities go in **their** `cv.md` +
`config/profile.yml` + `portals.yml` — never in committed MatchScan code.

**Before you push a public fork, run:**
```bash
git status   # confirm cv.md / data/ / output/ are NOT listed as staged
git check-ignore -v cv.md config/profile.yml data/applications.md tools/ats-site/local-data.json
# all four should print a .gitignore rule
```

## Host it free (Render + Neon) — always-on + CI/CD

Personal files (`cv.md`, tracker, `output/`) are **not in git and never deployed** —
hosted resumes/JDs live in the Neon **Library** instead. Only code deploys.
Local state (`tools/ats-site/.env`, `local-data.json`) stays gitignored.

### One-time setup

1. **Neon (database, free):** neon.tech → New Project → copy the
   **connection string** (`postgres://…?sslmode=require`).
2. **Commit & push MatchScan** (from repo root — code only):
   ```bash
   git add tools/ats-site render.yaml .github/workflows/matchscan-ci.yml .gitignore
   git status   # double-check no cv.md / data/ / output/ slipped in
   git commit -m "feat: MatchScan + Render CI/CD"
   git push origin main
   ```
3. **Render (host, free):** render.com → New → **Blueprint** → select **your** GitHub repo
   → reads `render.yaml` (`autoDeploy: true`, health check `/api/health`). Set:
   - `DATABASE_URL` = Neon connection string
   - `SITE_PASSWORD` = login password
4. **Optional deploy hook (GitHub Actions CD):** Render → service →
   **Settings → Deploy Hook** → copy URL → GitHub
   **Settings → Secrets → Actions** → `RENDER_DEPLOY_HOOK`. Pushes that change
   MatchScan run `.github/workflows/matchscan-ci.yml` then trigger Render.
   Blueprint autoDeploy alone is enough if you skip the secret.
5. Open the `*.onrender.com` URL, sign in, seed Library (paste resume / JDs).

### What runs on every push / PR

| Job | When | Does |
|-----|------|------|
| MatchScan syntax + smoke | PR/push touching `tools/ats-site/**`, `render.yaml` | `node --check`, refuse tracked secrets, boot + `/api/health` |
| Deploy to Render | push `main` or manual **Run workflow** | POST deploy hook if `RENDER_DEPLOY_HOOK` is set |

Free-tier reality: Render **sleeps after ~15 min idle**; wake ~30–60 s. Neon ~1 s. $0.
Hosted `JOBS_AUTO_REFRESH=0` (no portal scan on the dyno).

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
  write through `set-status.mjs` (validated + status-logged). Applied cards link to Outreach.
- **Jobs for you:** newest Apply/Check candidates from the board-refresh dump, with
  Load-JD-&-scan, per-job **x/10 match score vs your CV**, plus **Applied** / **Decline**
  buttons (writes tracker + `data/board-decisions.json`; never submits the employer form).
- **Outreach tab:** for each applied job, 3 LinkedIn targets (Hiring Manager, Recruiter, Peer)
  with search links, connection-note drafts, and after-connect drafts. Real names only when
  found in `data/contacts.tsv` or a LinkedIn `Connections.csv` export — otherwise search links.
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
