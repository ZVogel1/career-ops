#!/usr/bin/env node
/**
 * ats-site — local/hosted Jobscan-style ATS scanner over career-ops.
 *
 * Zero-dependency Node server. Reuses the repo's own engines:
 *   keyword-match.mjs (matching) · verify-ats.mjs (parseability) · jd-skill-gap.mjs (vs cv.md)
 *
 * Storage:
 *   - DATABASE_URL set  -> Neon Postgres over its HTTPS SQL API (hosted mode, e.g. Render)
 *   - otherwise         -> tools/ats-site/local-data.json (local mode)
 * Repo files (cv.md, output/source/*.html, jds/*.md) are offered as sources whenever they
 * exist on disk; on a hosted deploy they don't, and the DB library takes over.
 *
 * Auth: set SITE_PASSWORD to require a password (cookie session). Unset = open (local dev).
 * DIAGNOSTIC ONLY. Never edits any CV, never injects keywords.
 *
 * Run local:  node tools/ats-site/server.mjs            -> http://127.0.0.1:4317
 * Run hosted: PORT/DATABASE_URL/SITE_PASSWORD from env  (see render.yaml + README)
 */
import http from 'node:http';
import { readFileSync, readdirSync, existsSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import crypto from 'node:crypto';
import { analyzeCoverage, keywordCount, countOccurrences, variantForms, htmlToText, SYNONYMS } from '../../keyword-match.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

// tiny .env loader (tools/ats-site/.env), never overrides real env
try {
  for (const line of readFileSync(join(HERE, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env */ }

const PORT = process.env.PORT || 4317;
// Self-hosted by default: localhost only, nothing on the network or internet.
// Set HOST=0.0.0.0 to reach it from other devices on your own Wi-Fi (set SITE_PASSWORD too),
// or on a hosting platform (Render sets it via render.yaml).
const BIND = process.env.HOST || '127.0.0.1';
const PASSWORD = process.env.SITE_PASSWORD || '';
const DB_URL = process.env.DATABASE_URL || '';

// ── Keyword lexicon (JD mining) ──────────────────────────────────────────────
const LEXICON = [
  'Python', 'Java', 'JavaScript', 'TypeScript', 'Go', 'Golang', 'Ruby', 'C++', 'C#', 'SQL',
  'Bash', 'Shell', 'PowerShell', 'HTML', 'CSS', 'PHP', 'Swift', 'Kotlin', 'Rust', 'Scala',
  'React', 'Angular', 'Vue', 'Node.js', 'Next.js', 'Django', 'Flask', 'FastAPI', 'Spring',
  'Ruby on Rails', 'Rails', 'Express', '.NET', 'GraphQL', 'REST APIs', 'REST API', 'microservices',
  'AWS', 'Amazon Web Services', 'GCP', 'Google Cloud Platform', 'Azure', 'Docker', 'Kubernetes',
  'Terraform', 'Jenkins', 'GitHub Actions', 'GitLab CI', 'CI/CD', 'Git', 'GitHub', 'GitLab',
  'Linux', 'nginx', 'Ansible', 'AWX', 'Ansible Automation Platform', 'Argo CD', 'Helm',
  'infrastructure as code', 'DevOps', 'DevSecOps', 'SRE', 'site reliability', 'observability',
  'Prometheus', 'Grafana', 'Datadog', 'Splunk', 'containerization', 'OpenShift',
  'PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'Kafka', 'Spark', 'Snowflake', 'BigQuery',
  'Databricks', 'Airflow', 'ETL', 'data pipelines', 'data engineering', 'data warehouse',
  'Pandas', 'NumPy', 'dbt', 'Elasticsearch',
  'LLM', 'large language model', 'RAG', 'retrieval-augmented generation', 'embeddings',
  'prompt engineering', 'OpenAI', 'Anthropic', 'LangChain', 'LlamaIndex', 'vector database',
  'Pinecone', 'machine learning', 'NLP', 'natural language processing', 'GenAI', 'AI agents',
  'agentic', 'fine-tuning', 'model evaluation', 'PyTorch', 'TensorFlow', 'scikit-learn',
  'Agile', 'Scrum', 'Scrumban', 'Kanban', 'Jira', 'Confluence', 'testing', 'test automation',
  'communication', 'teamwork', 'collaboration', 'leadership', 'problem-solving', 'problem solving',
  'mentoring', 'cross-functional', 'stakeholder management', 'attention to detail', 'adaptability',
  'Selenium', 'Playwright', 'Cypress', 'unit testing', 'API testing', 'Postman',
  'Excel', 'Google Sheets', 'VBA', 'version control',
  'security', 'vulnerability management', 'IAM', 'TLS', 'OAuth', 'SSO',
  'cloud architecture', 'system design', 'distributed systems', 'event-driven',
];

function mineKeywords(jdText) {
  const found = [];
  for (const term of LEXICON) {
    const inJd = keywordCount(term, jdText || '');
    if (inJd > 0) found.push({ term, jdCount: inJd });
  }
  return found.sort((a, b) => b.jdCount - a.jdCount);
}

const SOFT_SKILLS = new Set(['communication', 'teamwork', 'collaboration', 'leadership',
  'problem-solving', 'problem solving', 'mentoring', 'cross-functional', 'stakeholder management',
  'attention to detail', 'adaptability', 'agile', 'scrum', 'scrumban', 'kanban']);

function splitSkills(coverage, resumeText, jdCounts) {
  const out = { hard: { present: [], thin: [], missing: [], total: 0, presentCount: 0, pct: 0 },
                soft: { present: [], thin: [], missing: [], total: 0, presentCount: 0, pct: 0 } };
  const bucketOf = (term) => SOFT_SKILLS.has(term.toLowerCase()) ? 'soft' : 'hard';
  for (const k of coverage.present) out[bucketOf(k)].present.push({ term: k, jdCount: jdCounts[k.toLowerCase()] || 0, cvCount: keywordCount(k, resumeText) });
  for (const k of coverage.thin) out[bucketOf(k)].thin.push(k);
  for (const k of coverage.missing) out[bucketOf(k)].missing.push({ term: k, jdCount: jdCounts[k.toLowerCase()] || 0, cvCount: 0 });
  for (const b of ['hard', 'soft']) {
    out[b].total = out[b].present.length + out[b].missing.length;
    out[b].presentCount = out[b].present.length;
    out[b].pct = out[b].total === 0 ? 100 : Math.round((out[b].presentCount / out[b].total) * 100);
  }
  return out;
}

function titleMatchOf(jdTitle, jdText, resumeText) {
  let title = String(jdTitle || '').trim();
  if (!title) {
    const line = String(jdText || '').split('\n').map(s => s.trim())
      .find(l => /(engineer|analyst|developer|architect|scientist|specialist|consultant)/i.test(l) && l.length < 90);
    title = line || '';
  }
  if (!title) return { jdTitle: '', score: null, status: 'info', detail: 'No JD title detected — add one for the title check.' };
  const stop = new Set(['senior', 'sr', 'junior', 'jr', 'lead', 'staff', 'principal', 'the', 'of', 'and', 'for', 'a', 'an', 'i', 'ii', 'iii']);
  const words = title.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w && !stop.has(w));
  const head = String(resumeText || '').split('\n').slice(0, 15).join(' ').toLowerCase();
  const anywhere = String(resumeText || '').toLowerCase();
  const inHead = words.filter(w => head.includes(w)).length;
  const anywhereCount = words.filter(w => anywhere.includes(w)).length;
  const score = words.length === 0 ? 0 : Math.round((anywhereCount / words.length) * 100);
  return { jdTitle: title, score,
    status: inHead >= Math.ceil(words.length / 2) ? 'pass' : score >= 50 ? 'warn' : 'warn',
    detail: inHead >= Math.ceil(words.length / 2)
      ? 'Title keywords appear near the top of your resume.'
      : 'Mirror the JD title wording in your headline/summary if truthful — never claim a title you did not hold.' };
}

function educationMatch(jdText, resumeText) {
  const jd = String(jdText || '').toLowerCase(), cv = String(resumeText || '').toLowerCase();
  const required = /\bph\.?d\b|doctorate/.test(jd) ? 'PhD'
    : /\bmaster'?s?\b|\bm\.s\.\b|\bmba\b/.test(jd) ? "Master's"
    : /\bbachelor'?s?\b|\bb\.s\.\b|undergraduate degree/.test(jd) ? "Bachelor's" : null;
  const found = /\bph\.?d\b|doctorate/.test(cv) ? 'PhD'
    : /\bmaster'?s?\b|\bm\.s\.\b|\bmba\b/.test(cv) ? "Master's"
    : /\bbachelor'?s?\b|\bb\.s\.\b|university|college/.test(cv) ? "Bachelor's" : null;
  if (!required) return { required: null, found, status: 'info', detail: 'JD states no degree requirement (Jobscan only scores education when it does).' };
  const rank = { "Bachelor's": 1, "Master's": 2, 'PhD': 3 };
  const ok = found && rank[found] >= rank[required];
  return { required, found, status: ok ? 'pass' : 'warn',
    detail: ok ? `JD asks ${required}; resume shows ${found}.` : `JD asks ${required}; resume shows ${found || 'no degree found'} — if you have it, name it explicitly.` };
}

const CLICHES = ['team player', 'results-driven', 'results driven', 'go-getter', 'synergy',
  'fast-paced environment', 'detail-oriented', 'hard worker', 'self-starter', 'think outside the box',
  'proven track record', 'dynamic', 'guru', 'ninja', 'rockstar'];
function recruiterTips(text) {
  const t = String(text || '');
  const lines = t.split('\n').map(s => s.trim()).filter(Boolean);
  const bullets = lines.filter(l => /^[-*•·]/.test(l)).map(l => l.replace(/^[-*•·]\s*/, ''));
  const quantified = bullets.filter(l => /(\d+\s?%|\$\s?\d|\b\d+\+?\b)/.test(l));
  const words = (t.match(/\S+/g) || []).length;
  const pronouns = (t.match(/\b(I|me|my|mine)\b/g) || []).length;
  const longBullets = bullets.filter(l => l.split(/\s+/).length > 35);
  const cliches = CLICHES.filter(c => t.toLowerCase().includes(c));
  return [
    { label: `Measurable results in ${quantified.length}/${bullets.length || 0} bullets`, ok: bullets.length > 0 && quantified.length / bullets.length >= 0.3, detail: 'Recruiters scan for numbers: %, $, counts, time saved.' },
    { label: `Word count ${words}`, ok: words >= 350 && words <= 900, detail: 'One page ≈ 350–650 words for early-career; two pages needs the depth to justify it.' },
    { label: `Bullet length (${longBullets.length} bullets over 35 words)`, ok: longBullets.length === 0, detail: 'Keep bullets to 1–2 lines; split or trim the long ones.' },
    { label: `First-person pronouns ×${pronouns} (I / me / my)`, ok: pronouns <= 2, detail: 'Resume convention drops pronouns — start bullets with the verb.' },
    { label: `Clichés found: ${cliches.length ? cliches.join(', ') : 'none'}`, ok: cliches.length === 0, detail: 'Replace filler with a measurable result.' },
  ];
}

// ── ATS text checks ──────────────────────────────────────────────────────────
const ACTION_VERBS = ['built', 'developed', 'designed', 'implemented', 'automated', 'migrated',
  'led', 'created', 'improved', 'reduced', 'increased', 'launched', 'delivered', 'optimized',
  'integrated', 'deployed', 'maintained', 'collaborated', 'engineered', 'architected'];

function atsChecks(text) {
  const t = text || '';
  const lines = t.split('\n').map(s => s.trim()).filter(Boolean);
  const bullets = lines.filter(l => /^[-*•·]/.test(l));
  const quantified = bullets.filter(l => /(\d+\s?%|\$\s?\d|\b\d+\+?\b)/.test(l));
  const verbStarts = bullets.filter(l => ACTION_VERBS.some(v =>
    l.replace(/^[-*•·]\s*/, '').toLowerCase().startsWith(v)));
  const words = (t.match(/\S+/g) || []).length;
  const has = (re) => re.test(t);
  return [
    { label: 'Email address present', ok: has(/[\w.+-]+@[\w-]+\.[\w.]+/) },
    { label: 'Phone number present', ok: has(/(\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/) },
    { label: 'LinkedIn URL present', ok: has(/linkedin\.com/i) },
    { label: 'GitHub / portfolio URL present', ok: has(/github\.com|gitlab\.com/i) },
    { label: 'Experience section found', ok: has(/experience/i) },
    { label: 'Education section found', ok: has(/education/i) },
    { label: 'Skills section found', ok: has(/skills/i) },
    { label: 'Dates present (employment/education)', ok: has(/(19|20)\d{2}/) },
    { label: `Bullets start with action verbs (${verbStarts.length}/${bullets.length || 0})`, ok: bullets.length > 0 && verbStarts.length / bullets.length >= 0.5 },
    { label: `Quantified bullets (${quantified.length}/${bullets.length || 0}) — aim for 30%+`, ok: bullets.length > 0 && quantified.length / bullets.length >= 0.3 },
    { label: `Length ~1 page (${words} words; 350–650 typical for 1p resume)`, ok: words >= 250 && words <= 800 },
    { label: 'No tables / columns markers (ATS-safe layout)', ok: !/(\|\s*\|)|(\t{2,})/.test(t) },
  ];
}

// ── Storage ──────────────────────────────────────────────────────────────────
async function pg(sql, params = []) {
  const host = new URL(DB_URL).host;
  const res = await fetch(`https://${host}/sql`, {
    method: 'POST',
    headers: { 'Neon-Connection-String': DB_URL, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql, params }),
  });
  if (!res.ok) throw new Error(`db ${res.status}: ${await res.text()}`);
  return (await res.json()).rows || [];
}

const LOCAL_FILE = join(HERE, 'local-data.json');
function localLoad() {
  try { return JSON.parse(readFileSync(LOCAL_FILE, 'utf8')); }
  catch { return { documents: [], scans: [], notifications: [], seq: 0 }; }
}
function localSave(d) { writeFileSync(LOCAL_FILE, JSON.stringify(d, null, 1)); }

const store = DB_URL ? {
  async init() {
    await pg(`CREATE TABLE IF NOT EXISTS documents (id SERIAL PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL, content TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now())`);
    await pg(`CREATE TABLE IF NOT EXISTS scans (id SERIAL PRIMARY KEY, created_at TIMESTAMPTZ DEFAULT now(), resume_label TEXT, jd_label TEXT, match_pct INT, present_count INT, total_count INT, detail JSONB)`);
    await pg(`CREATE TABLE IF NOT EXISTS notifications (id SERIAL PRIMARY KEY, created_at TIMESTAMPTZ DEFAULT now(), kind TEXT, title TEXT, body TEXT, dedupe_key TEXT UNIQUE, read_at TIMESTAMPTZ)`);
  },
  async listDocs(kind) { return pg(`SELECT id, kind, label, created_at FROM documents WHERE kind=$1 ORDER BY id`, [kind]); },
  async getDoc(id) { const r = await pg(`SELECT * FROM documents WHERE id=$1`, [id]); return r[0] || null; },
  async addDoc(kind, label, content) { const r = await pg(`INSERT INTO documents (kind,label,content) VALUES ($1,$2,$3) RETURNING id`, [kind, label, content]); return r[0].id; },
  async deleteDoc(id) { await pg(`DELETE FROM documents WHERE id=$1`, [id]); },
  async addScan(s) { const r = await pg(`INSERT INTO scans (resume_label,jd_label,match_pct,present_count,total_count,detail) VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING id`, [s.resumeLabel, s.jdLabel, s.pct, s.present, s.total, JSON.stringify(s.detail)]); return r[0].id; },
  async listScans() { return pg(`SELECT id, created_at, resume_label, jd_label, match_pct, present_count, total_count FROM scans ORDER BY id DESC LIMIT 50`); },
  async getScan(id) { const r = await pg(`SELECT * FROM scans WHERE id=$1`, [id]); return r[0] || null; },
  async addNotif(n) { await pg(`INSERT INTO notifications (kind,title,body,dedupe_key) VALUES ($1,$2,$3,$4) ON CONFLICT (dedupe_key) DO NOTHING`, [n.kind, n.title, n.body, n.key || null]); },
  async listNotifs() { return pg(`SELECT * FROM notifications ORDER BY id DESC LIMIT 50`); },
  async markAllRead() { await pg(`UPDATE notifications SET read_at=now() WHERE read_at IS NULL`); },
} : {
  async init() { localSave(localLoad()); },
  async listDocs(kind) { return localLoad().documents.filter(d => d.kind === kind).map(({ content, ...rest }) => rest); },
  async getDoc(id) { return localLoad().documents.find(d => String(d.id) === String(id)) || null; },
  async addDoc(kind, label, content) { const d = localLoad(); const id = ++d.seq; d.documents.push({ id, kind, label, content, created_at: new Date().toISOString() }); localSave(d); return id; },
  async deleteDoc(id) { const d = localLoad(); d.documents = d.documents.filter(x => String(x.id) !== String(id)); localSave(d); },
  async addScan(s) { const d = localLoad(); const id = ++d.seq; d.scans.push({ id, created_at: new Date().toISOString(), resume_label: s.resumeLabel, jd_label: s.jdLabel, match_pct: s.pct, present_count: s.present, total_count: s.total, detail: s.detail }); localSave(d); return id; },
  async listScans() { return localLoad().scans.slice(-50).reverse().map(({ detail, ...rest }) => rest); },
  async getScan(id) { return localLoad().scans.find(x => String(x.id) === String(id)) || null; },
  async addNotif(n) { const d = localLoad(); if (n.key && d.notifications.some(x => x.dedupe_key === n.key)) return; d.notifications.push({ id: ++d.seq, created_at: new Date().toISOString(), kind: n.kind, title: n.title, body: n.body, dedupe_key: n.key || null, read_at: null }); localSave(d); },
  async listNotifs() { return localLoad().notifications.slice(-50).reverse(); },
  async markAllRead() { const d = localLoad(); for (const n of d.notifications) if (!n.read_at) n.read_at = new Date().toISOString(); localSave(d); },
};

// ── Repo-file sources (exist locally; absent on hosted deploys) ──────────────
function prettyDocLabel(file, group) {
  const base = String(file || '').replace(/\.html$/i, '').replace(/^site-/, '');
  const nice = base.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
  return group === 'cv' ? `CV — ${nice}` : group === 'resume' ? `Resume — ${nice}` : nice;
}
function repoSources() {
  const resumes = [], jds = [];
  const cv = join(ROOT, 'cv.md');
  if (existsSync(cv)) {
    resumes.push({ id: 'repo:cv', label: 'Master CV (cv.md)', path: cv, kind: 'md', group: 'master' });
  }
  for (const [dir, group] of [['output/source/resumes', 'resume'], ['output/source/cvs', 'cv']]) {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const f of readdirSync(abs).filter(f => f.endsWith('.html')).sort()) {
      resumes.push({
        id: `repo:${dir}/${f}`,
        label: prettyDocLabel(f, group),
        path: join(abs, f),
        kind: 'html',
        group,
        file: f,
      });
    }
  }
  const jdDir = join(ROOT, 'jds');
  if (existsSync(jdDir)) {
    for (const f of readdirSync(jdDir).filter(f => f.endsWith('.md')).sort()) {
      jds.push({ id: `repo:jds/${f}`, label: f, path: join(jdDir, f), kind: 'md', group: 'jd' });
    }
  }
  return { resumes, jds };
}

async function resolveDoc(id) {
  if (!id) return null;
  if (String(id).startsWith('repo:')) {
    const { resumes, jds } = repoSources();
    const hit = [...resumes, ...jds].find(s => s.id === id);
    if (!hit) return null;
    return { label: hit.label, content: readFileSync(hit.path, 'utf8'), isHtml: hit.kind === 'html' };
  }
  const doc = await store.getDoc(id);
  if (!doc) return null;
  return { label: doc.label, content: doc.content, isHtml: /^\s*</.test(doc.content) && doc.content.includes('<') };
}

// ── Subprocess engines ───────────────────────────────────────────────────────
function runNode(args) {
  return new Promise((res) => {
    execFile('node', args, { cwd: ROOT, timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => res(err && !stdout ? null : stdout));
  });
}

async function parseabilityScore(html) {
  const tmp = join(tmpdir(), `ats-site-cv-${Date.now()}.html`);
  try {
    writeFileSync(tmp, html);
    const out = await runNode(['verify-ats.mjs', tmp, '--json']);
    if (!out) return null;
    const j = JSON.parse(out);
    return { score: j.score ?? j.total ?? null, grade: j.grade ?? null, issues: j.issues ?? [] };
  } catch { return null; } finally { try { unlinkSync(tmp); } catch { /* noop */ } }
}

async function skillGap(jdText) {
  if (!existsSync(join(ROOT, 'cv.md'))) return null; // compares against cv.md, local only
  const tmp = join(tmpdir(), `ats-site-jd-${Date.now()}.md`);
  try {
    writeFileSync(tmp, jdText || '');
    const out = await runNode(['jd-skill-gap.mjs', tmp]);
    return out ? JSON.parse(out) : null;
  } catch { return null; } finally { try { unlinkSync(tmp); } catch { /* noop */ } }
}

// ── Follow-up notifications (from tracker files, when present) ───────────────
async function genFollowupNotifs() {
  const fuPath = join(ROOT, 'data/follow-ups.md');
  const appPath = join(ROOT, 'data/applications.md');
  if (!existsSync(fuPath)) return;
  const companies = {};
  if (existsSync(appPath)) {
    for (const line of readFileSync(appPath, 'utf8').split('\n')) {
      const m = line.match(/^\|\s*(\d+)\s*\|[^|]*\|\s*([^|]+)\|\s*([^|]+)\|/);
      if (m) companies[m[1]] = { company: m[2].trim(), role: m[3].trim() };
    }
  }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (const line of readFileSync(fuPath, 'utf8').split('\n')) {
    const m = line.match(/^- next #(\d+) (\d{4}-\d{2}-\d{2})/);
    if (!m || line.includes('DONE')) continue;
    const due = new Date(m[2] + 'T00:00:00');
    if (due.getTime() <= today.getTime() + 86400000) {
      const c = companies[m[1]] || {};
      await store.addNotif({
        kind: 'followup', key: `fu-${m[1]}-${m[2]}`,
        title: `Follow-up due: ${c.company || 'application #' + m[1]}`,
        body: `${c.role || ''} — follow-up date ${m[2]} (tracker #${m[1]})`,
      });
    }
  }
}

// ── Tracker (kanban) — reads data/applications.md, writes via set-status.mjs ─
const CANONICAL_STATES = ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Hired', 'Rejected', 'Discarded', 'SKIP'];
const DECISIONS_PATH = join(ROOT, 'data/board-decisions.json');
const OUTREACH_DIR = join(ROOT, 'data/outreach');

function normCo(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseTracker() {
  const p = join(ROOT, 'data/applications.md');
  if (!existsSync(p)) return null;
  const rows = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\|\s*(\d+)\s*\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|?([^|]*)\|?\s*$/);
    if (!m) continue;
    const rawUrl = (m[10] || '').trim();
    const md = rawUrl.match(/\((https?:\/\/[^)\s]+)\)/);
    rows.push({ num: Number(m[1]), date: m[2].trim(), company: m[3].trim(), role: m[4].trim(),
      score: m[5].trim(), status: m[6].trim(), pdf: m[7].trim(), report: m[8].trim(),
      notes: m[9].trim(), url: md ? md[1] : rawUrl });
  }
  return rows;
}

function readDecisions() {
  if (!existsSync(DECISIONS_PATH)) return { decisions: [] };
  try {
    const j = JSON.parse(readFileSync(DECISIONS_PATH, 'utf8'));
    return { decisions: Array.isArray(j.decisions) ? j.decisions : [] };
  } catch {
    return { decisions: [] };
  }
}
function writeDecisions(doc) {
  mkdirSync(dirname(DECISIONS_PATH), { recursive: true });
  writeFileSync(DECISIONS_PATH, JSON.stringify(doc, null, 2) + '\n');
}
function upsertDecision(entry) {
  const doc = readDecisions();
  const key = String(entry.url || `${entry.company}|${entry.title}`).toLowerCase();
  const i = doc.decisions.findIndex(d => String(d.url || `${d.company}|${d.title}`).toLowerCase() === key);
  if (i >= 0) doc.decisions[i] = { ...doc.decisions[i], ...entry };
  else doc.decisions.push(entry);
  writeDecisions(doc);
  return entry;
}
function decisionMap() {
  const map = new Map();
  for (const d of readDecisions().decisions) {
    if (d.url) map.set(String(d.url).toLowerCase(), d);
    map.set(`${normCo(d.company)}|${String(d.title || '').toLowerCase()}`, d);
  }
  return map;
}
function runNodeCli(args, timeoutMs = 60000) {
  return new Promise((resolveOut) => {
    execFile('node', args, {
      cwd: ROOT, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env },
    }, (err, stdout, stderr) => resolveOut({
      code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
      stdout: stdout || '', stderr: stderr || '',
    }));
  });
}
function findTrackerRow({ url, company, title }) {
  const rows = parseTracker() || [];
  const u = String(url || '').trim().toLowerCase();
  if (u) {
    const byUrl = rows.find(r => String(r.url || '').toLowerCase() === u);
    if (byUrl) return byUrl;
  }
  const co = normCo(company);
  const role = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return rows.find(r => normCo(r.company) === co && String(r.role || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === role) || null;
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function slugify(s) {
  return String(s || 'company').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'company';
}
async function markApplied({ company, title, url, note }) {
  const existing = findTrackerRow({ url, company, title });
  let trackerNum = existing ? existing.num : null;
  if (existing) {
    if (existing.status !== 'Applied') {
      const out = await runNodeCli(['set-status.mjs', '--row', String(existing.num), 'Applied', '--json',
        '--note', note || `Applied via MatchScan ${todayISO()}`], 30000);
      if (out.code !== 0) {
        let err = 'set-status failed';
        try { err = JSON.parse(out.stdout.slice(out.stdout.indexOf('{'))).error || err; } catch { /* */ }
        return { ok: false, error: err };
      }
    }
  } else {
    const rows = parseTracker() || [];
    trackerNum = Math.max(0, ...rows.map(r => r.num || 0)) + 1;
    const dir = join(ROOT, 'batch/tracker-additions');
    mkdirSync(dir, { recursive: true });
    const tsvPath = join(dir, `${String(trackerNum).padStart(3, '0')}-${slugify(company)}.tsv`);
    const safeNote = (note || `Applied via MatchScan ${todayISO()}`).replace(/\t/g, ' ').replace(/\n/g, ' ');
    const tsv = [
      'num\tdate\tcompany\trole\tstatus\tscore\tpdf\treport\tnotes\turl',
      `${trackerNum}\t${todayISO()}\t${company}\t${title}\tApplied\tN/A\t❌\t—\t${safeNote}\t${url || ''}`,
      '',
    ].join('\n');
    writeFileSync(tsvPath, tsv);
    const merge = await runNodeCli(['merge-tracker.mjs'], 60000);
    if (merge.code !== 0) {
      return { ok: false, error: (merge.stderr || merge.stdout || 'merge-tracker failed').slice(-300) };
    }
  }
  const decision = upsertDecision({
    action: 'applied', company, title, url: url || '', trackerNum,
    at: new Date().toISOString(), note: note || '',
  });
  const pack = await buildOutreachPack({ num: trackerNum, company, role: title, url });
  return { ok: true, trackerNum, decision, outreach: pack, rows: parseTracker() };
}
async function markDeclined({ company, title, url, note }) {
  const existing = findTrackerRow({ url, company, title });
  if (existing && !['Rejected', 'Discarded', 'SKIP', 'Hired'].includes(existing.status)) {
    const out = await runNodeCli(['set-status.mjs', '--row', String(existing.num), 'SKIP', '--json',
      '--note', note || `Declined via MatchScan ${todayISO()}`], 30000);
    if (out.code !== 0) {
      let err = 'set-status failed';
      try { err = JSON.parse(out.stdout.slice(out.stdout.indexOf('{'))).error || err; } catch { /* */ }
      return { ok: false, error: err };
    }
  }
  const decision = upsertDecision({
    action: 'declined', company, title, url: url || '',
    trackerNum: existing ? existing.num : null,
    at: new Date().toISOString(), note: note || '',
  });
  return { ok: true, decision, rows: parseTracker() };
}
function proofSnippet() {
  try {
    const y = readFileSync(join(ROOT, 'config/profile.yml'), 'utf8');
    const m = y.match(/hero_metric:\s*"([^"]+)"/);
    if (m) return m[1].replace(/[—–‐‑‒−-]/g, ' ').replace(/\s+/g, ' ').trim();
  } catch { /* */ }
  return 'Migrated 10+ automation workflows from Jenkins, XLR, and Ansible AWX to GitHub Actions';
}
function cleanMsg(s) {
  return String(s || '')
    .replace(/[—–‐‑‒−]/g, ', ')
    .replace(/(?<=\w)-(?=\w)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function linkedInPeopleSearch(keywords) {
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}`;
}
async function lookupWarmContacts(company) {
  const warm = [];
  const lookup = await runNodeCli(['contact-lookup.mjs', '--company', company], 20000);
  if (lookup.code === 0) {
    try {
      const j = JSON.parse(lookup.stdout.slice(lookup.stdout.indexOf('{')));
      for (const c of (j.contacts || j.matches || [])) {
        warm.push({
          name: c.name || c.full_name || 'Saved contact',
          title: c.title || c.role || 'Prior contact',
          type: 'Internal Referral',
          source: 'contacts.tsv',
          linkedinUrl: c.linkedin || c.url || null,
        });
      }
    } catch { /* */ }
  }
  if (existsSync(join(ROOT, 'data/Connections.csv'))) {
    const joinOut = await runNodeCli(['linkedin-join.mjs', '--company', company], 20000);
    try {
      const text = joinOut.stdout;
      const start = text.indexOf('{') >= 0 ? text.indexOf('{') : text.indexOf('[');
      if (start >= 0) {
        const j = JSON.parse(text.slice(start));
        const rows = Array.isArray(j) ? j : (j.matches || j.connections || j.companies || []);
        const list = Array.isArray(rows) ? rows : [];
        for (const c of list.slice(0, 5)) {
          const name = c.name || c.full_name || [c.first_name, c.last_name].filter(Boolean).join(' ');
          if (!name) continue;
          warm.push({
            name,
            title: c.position || c.title || 'LinkedIn connection',
            type: 'Warm connection',
            source: 'Connections.csv',
            linkedinUrl: c.url || c.linkedin || null,
          });
        }
      }
    } catch { /* */ }
  }
  // de-dupe by name
  const seen = new Set();
  return warm.filter(w => {
    const k = String(w.name).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
function draftMessages({ type, company, role, name }) {
  const proof = proofSnippet();
  const who = name && name !== 'Find on LinkedIn' ? name.split(' ')[0] : 'there';
  const roleShort = cleanMsg(role).slice(0, 60);
  const co = cleanMsg(company);
  if (type === 'Hiring Manager') {
    return {
      connection: cleanMsg(`Hi ${who}, I applied to the ${roleShort} role at ${co}. ${proof}. Would be glad to connect.`).slice(0, 200),
      afterConnect: cleanMsg(`Thanks for connecting. Happy to share how I have shipped reusable GitHub Actions workflows and full stack tools if useful for the ${roleShort} search.`),
    };
  }
  if (type === 'Recruiter') {
    return {
      connection: cleanMsg(`Hi ${who}, I applied for ${roleShort} at ${co}. Dec 2026 CS grad, Charlotte based, CI/CD and full stack internship experience. Happy to share my resume.`).slice(0, 200),
      afterConnect: cleanMsg(`Thanks for connecting. I am targeting a Jan 2027 start. Glad to send a one page resume or answer screening questions for ${roleShort}.`),
    };
  }
  // Peer / warm
  return {
    connection: cleanMsg(`Hi ${who}, I just applied to ${roleShort} at ${co} and have been doing CI/CD and full stack work in the same space. Would love to connect.`).slice(0, 200),
    afterConnect: cleanMsg(`Thanks for connecting. Curious how your team approaches CI/CD and platform tooling day to day. I have been migrating bank pipelines to GitHub Actions this year.`),
  };
}
async function buildOutreachPack({ num, company, role, url }) {
  mkdirSync(OUTREACH_DIR, { recursive: true });
  const warm = await lookupWarmContacts(company);
  const slots = [];
  const usedTypes = new Set();
  for (const w of warm.slice(0, 3)) {
    const msgs = draftMessages({ type: w.type.includes('Referral') || w.type.includes('Warm') ? 'Peer' : w.type, company, role, name: w.name });
    slots.push({
      ...w,
      searchUrl: w.linkedinUrl || linkedInPeopleSearch(`${w.name} ${company}`),
      messages: msgs,
      named: true,
    });
    usedTypes.add(w.type);
  }
  const templates = [
    { type: 'Hiring Manager', keywords: `${company} Engineering Manager OR "Hiring Manager" OR "Software Engineering Manager"` },
    { type: 'Recruiter', keywords: `${company} Recruiter OR "Technical Recruiter" OR "Talent Acquisition" OR "University Recruiter"` },
    { type: 'Peer', keywords: `${company} "Software Engineer" OR DevOps OR "Platform Engineer"` },
  ];
  for (const t of templates) {
    if (slots.length >= 3) break;
    if ([...usedTypes].some(u => u.toLowerCase().includes(t.type.toLowerCase().split(' ')[0]))) continue;
    const msgs = draftMessages({ type: t.type, company, role, name: 'Find on LinkedIn' });
    slots.push({
      name: 'Find on LinkedIn',
      title: t.type,
      type: t.type,
      source: 'linkedin-search',
      named: false,
      searchUrl: linkedInPeopleSearch(t.keywords),
      messages: msgs,
      howTo: `Open the LinkedIn search, pick one real ${t.type.toLowerCase()} at ${company}, then paste their first name into the drafts below before sending.`,
    });
  }
  while (slots.length < 3) {
    const t = templates[slots.length];
    const msgs = draftMessages({ type: t.type, company, role, name: 'Find on LinkedIn' });
    slots.push({
      name: 'Find on LinkedIn', title: t.type, type: t.type, source: 'linkedin-search', named: false,
      searchUrl: linkedInPeopleSearch(t.keywords), messages: msgs,
      howTo: `Open the LinkedIn search, pick one real person, then personalize the draft.`,
    });
  }
  const pack = {
    trackerNum: num || null,
    company,
    role,
    url: url || '',
    generatedAt: new Date().toISOString(),
    disclaimer: 'Names are only filled when found in your saved contacts or LinkedIn Connections export. Search links never invent people. Edit drafts before sending. Never auto send.',
    people: slots.slice(0, 3),
  };
  if (num) writeFileSync(join(OUTREACH_DIR, `${num}.json`), JSON.stringify(pack, null, 2) + '\n');
  return pack;
}
function readOutreachPack(num) {
  const p = join(OUTREACH_DIR, `${Number(num)}.json`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

// ── Next steps — from data/apply-board.md (user board) ────────────────────────
function readNextSteps() {
  const boardPath = join(ROOT, 'data/apply-board.md');
  const dumpPath = join(ROOT, 'data/charlotte-fit-candidates.json');
  const out = {
    available: false,
    updated: null,
    summary: null,
    actions: [],
    applyNow: [],
    checks: [],
    info: [],
  };
  if (existsSync(dumpPath)) {
    try {
      const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
      out.summary = dump.summary || null;
      out.updated = (dump.summary && dump.summary.scanned_at) || null;
    } catch { /* ignore */ }
  }
  if (!existsSync(boardPath)) return out;
  out.available = true;
  const md = readFileSync(boardPath, 'utf8');
  const updated = md.match(/Updated:\s*\*\*([^*]+)\*\*/);
  if (updated) out.updated = updated[1].trim();
  const section = (name) => {
    const re = new RegExp(`##[^\\n]*${name}[\\s\\S]*?(?=\\n## |\\n<details|\\n---|$)`, 'i');
    const m = md.match(re);
    return m ? m[0] : '';
  };
  const next = section('Next actions');
  for (const line of next.split('\n')) {
    const m = line.match(/^\d+\.\s+\*\*(.+?)\*\*:?\s*(.*)$/) || line.match(/^\d+\.\s+(.+)$/);
    if (m) out.actions.push({ title: (m[1] || '').replace(/\*\*/g, '').trim(), detail: (m[2] || '').replace(/\*\*/g, '').trim() });
  }
  const apply = section('Apply now');
  const applyBlocks = apply.split(/\n(?=\*\*[^*\n]+—|\*\*[^*\n]+ - )/).slice(1);
  for (const block of applyBlocks.slice(0, 6)) {
    const title = (block.match(/^\*\*(.+?)\*\*/) || [])[1];
    const url = (block.match(/https?:\/\/\S+/) || [])[0];
    const blurb = block.replace(/^\*\*.+?\*\*\s*/, '').replace(/→\s*https?:\/\/\S+/, '').replace(/\n+/g, ' ').trim().slice(0, 280);
    if (title && !/was applied/i.test(title)) out.applyNow.push({ title: title.replace(/\s+/g, ' ').trim(), url: url || null, blurb });
  }
  const check = section('Check first');
  for (const row of check.split('\n')) {
    if (!row.startsWith('|') || /\|\s*#\s*\|/.test(row) || /^\|[-| ]+\|$/.test(row)) continue;
    const cells = row.split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length < 4) continue;
    if (!/^C\d+/i.test(cells[0])) continue; // only board check rows (C3, C6…), not Applied tables
    const link = (cells[4] || '').match(/\((https?:\/\/[^)]+)\)/);
    out.checks.push({
      id: cells[0], company: cells[1].replace(/\*\*/g, ''), role: cells[2],
      note: cells[3].replace(/\*\*/g, '').slice(0, 220), url: link ? link[1] : null,
    });
  }
  if (out.summary && out.summary.refresh_2026_11_10) out.info.push(String(out.summary.refresh_2026_11_10));
  else if (out.summary && out.summary.new_apply) out.info.push(`New apply: ${(out.summary.new_apply || []).join('; ')}`);
  return out;
}

// ── Jobs feed — scored dump + fresh scan-history (auto-refresh) ──────────────
const CLT_RE = /(charlotte|fort mill|indian land|huntersville|concord|gastonia|rock hill|mooresville|hickory|statesville)/i;
const SENIOR_RE = /\b(senior|staff|principal|lead|manager|director|vp|head of|sr\.?)\b/i;
const ENG_RE = /\b(software|devops|sre|platform|full.?stack|backend|frontend|front.?end|engineer|developer|qa|quality|security analyst|vulnerability|site reliability)\b/i;
const INTERN_RE = /\b(intern|internship|co-?op|summer)\b/i;
let jobsRefreshState = { running: false, lastStarted: null, lastFinished: null, lastError: null, lastScanExit: null };

function enrichJob(j, appliedCos) {
  return {
    ...j,
    remote: /\bremote\b/i.test(j.location || ''),
    charlotte: CLT_RE.test(j.location || ''),
    appliedCompany: appliedCos.has(normCo(j.company)),
  };
}
function recentScanJobs(days = 3) {
  const histPath = join(ROOT, 'data/scan-history.tsv');
  if (!existsSync(histPath)) return [];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cut = cutoff.toISOString().slice(0, 10);
  const out = [];
  const seen = new Set();
  for (const line of readFileSync(histPath, 'utf8').split('\n')) {
    if (!line || line.startsWith('url\t')) continue;
    const c = line.split('\t');
    const [url, firstSeen, , title, company, status, location, , posted] = c;
    if (!url || !title || status === 'skipped_expired') continue;
    const when = (posted && /^\d{4}-\d{2}-\d{2}/.test(posted) ? posted : firstSeen || '').slice(0, 10);
    if (!when || when < cut) continue;
    if (SENIOR_RE.test(title) || INTERN_RE.test(title) || !ENG_RE.test(title)) continue;
    if (!CLT_RE.test(location || '') && !/\bremote\b/i.test(location || '')) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      company: company || 'Unknown', title, location: location || '', url,
      posted: when, source: 'scan-history', bucket: 'new-scan',
      applicants: null, entry_hint: '', note: 'Fresh from portal scan — open JD before treating as apply-ready.',
    });
  }
  return out.sort((a, b) => String(b.posted).localeCompare(String(a.posted))).slice(0, 60);
}
function jobsFeed() {
  const dumpPath = join(ROOT, 'data/charlotte-fit-candidates.json');
  const tracker = parseTracker() || [];
  const appliedCos = new Set(tracker.map(r => normCo(r.company)));
  const dmap = decisionMap();
  const rank = { 'apply-ready': 0, 'check-level': 1, 'new-scan': 2 };
  const fromDump = existsSync(dumpPath)
    ? (JSON.parse(readFileSync(dumpPath, 'utf8')).jobs || []).filter(j => j.bucket in rank)
    : [];
  const dumpUrls = new Set(fromDump.map(j => j.url));
  const fresh = recentScanJobs(3).filter(j => !dumpUrls.has(j.url));
  const dumpMeta = existsSync(dumpPath) ? JSON.parse(readFileSync(dumpPath, 'utf8')).summary : null;
  const jobs = [...fromDump, ...fresh]
    .map(j => {
      const enriched = enrichJob(j, appliedCos);
      const d = dmap.get(String(j.url || '').toLowerCase())
        || dmap.get(`${normCo(j.company)}|${String(j.title || '').toLowerCase()}`);
      const tracked = findTrackerRow({ url: j.url, company: j.company, title: j.title });
      return {
        ...enriched,
        decision: d ? d.action : (tracked && tracked.status === 'Applied' ? 'applied' : null),
        trackerNum: (d && d.trackerNum) || (tracked && tracked.num) || null,
      };
    })
    .filter(j => j.decision !== 'declined')
    .sort((a, b) => (rank[a.bucket] - rank[b.bucket]) || String(b.posted || '').localeCompare(String(a.posted || '')))
    .slice(0, 100);
  if (!jobs.length) return null;
  return {
    scannedAt: (dumpMeta && dumpMeta.scanned_at) || null,
    freshCount: fresh.length,
    dumpCount: fromDump.length,
    refresh: { ...jobsRefreshState },
    jobs,
  };
}
async function runPortalScanRefresh() {
  if (jobsRefreshState.running) return { ok: false, error: 'refresh already running' };
  jobsRefreshState = { ...jobsRefreshState, running: true, lastStarted: new Date().toISOString(), lastError: null };
  try {
    const out = await new Promise((resolveOut) => {
      execFile('node', ['scan.mjs', '--quiet'], {
        cwd: ROOT, timeout: 12 * 60 * 1000, maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env },
      }, (err, stdout, stderr) => resolveOut({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: stdout || '', stderr: stderr || '',
      }));
    });
    jobsRefreshState.lastScanExit = out.code;
    if (out.code !== 0) {
      jobsRefreshState.lastError = (out.stderr || out.stdout || 'scan failed').slice(-400);
    } else {
      await store.addNotif({
        kind: 'jobs',
        title: 'Jobs refreshed from portal scan',
        body: 'scan.mjs finished — Jobs for you now includes fresh scan-history matches.',
        key: `jobs-refresh-${Date.now()}`,
      });
    }
    return { ok: out.code === 0, code: out.code, feed: jobsFeed() };
  } catch (e) {
    jobsRefreshState.lastError = String(e.message || e);
    return { ok: false, error: jobsRefreshState.lastError };
  } finally {
    jobsRefreshState.running = false;
    jobsRefreshState.lastFinished = new Date().toISOString();
  }
}
const JOBS_REFRESH_MS = Math.max(1, Number(process.env.JOBS_REFRESH_HOURS || 6)) * 60 * 60 * 1000;
// Auto portal-scan on an interval while the site is up (default every 6h).
// Set JOBS_AUTO_REFRESH=0 to disable. Set JOBS_REFRESH_ON_BOOT=1 to also scan ~60s after start.
if (process.env.JOBS_AUTO_REFRESH !== '0') {
  setInterval(() => { runPortalScanRefresh().catch(() => {}); }, JOBS_REFRESH_MS);
  if (process.env.JOBS_REFRESH_ON_BOOT === '1') {
    setTimeout(() => { runPortalScanRefresh().catch(() => {}); }, 60_000);
  }
}

// ── Company / ATS-vendor rules ───────────────────────────────────────────────
const COMPANY_ATS = {
  "lowe's": 'Workday', 'lpl financial': 'Workday', 'vanguard': 'Workday', 'assetmark': 'Workday',
  'duke energy': 'Workday', 'ally': 'Workday', 'wells fargo': 'Workday', 'lseg': 'Workday',
  'truist': 'Workday', 'allstate': 'Workday', 'axs': 'Greenhouse', 'bloomerang': 'Greenhouse',
  'twilio': 'Greenhouse', 'affirm': 'Greenhouse', 'gitlab': 'Greenhouse', 'coinbase': 'Greenhouse',
  'reddit': 'Greenhouse', 'cohere': 'Ashby', 'deepgram': 'Ashby', 'pinecone': 'Ashby',
  'langchain': 'Ashby', 'clearcapital': 'Lever',
};
const COMPANY_NOTES = {
  'lseg': 'Graduate Programme has a one-application rule (programme guidance) — the FTSE pool posting is separate.',
  "lowe's": 'Single candidate profile only — duplicate Workday profiles cause merge/reactivation problems (your C3 block).',
  'smbc': 'SMBC Analyst reqs run on its own careers portal, not Workday; the tailored 8331 resume is the reference copy.',
};
function detectVendor(company, jdText) {
  const c = String(company || '').toLowerCase();
  for (const [name, vendor] of Object.entries(COMPANY_ATS)) if (c.includes(name)) return vendor;
  const t = String(jdText || '').toLowerCase();
  if (t.includes('workday')) return 'Workday';
  if (t.includes('greenhouse')) return 'Greenhouse';
  if (t.includes('ashby')) return 'Ashby';
  if (t.includes('lever')) return 'Lever';
  return 'Generic';
}
function buildAtsRules(vendor, company, resumeText, coverage, checks) {
  const items = [];
  const add = (label, status, detail) => items.push({ label, status, detail: detail || '' });
  const checkMap = Object.fromEntries(checks.map(c => [c.label, c.ok]));
  const pct = coverage.pct;
  add(`Keyword coverage ${pct}% (${coverage.presentCount}/${coverage.total})`,
    pct >= 75 ? 'pass' : pct >= 50 ? 'warn' : 'warn',
    pct >= 75 ? 'Strong ATS keyword alignment.' : 'Below the ~75% bar most screeners reward — close real gaps only.');
  add(`${coverage.missing.length} JD keywords missing`,
    coverage.missing.length === 0 ? 'pass' : coverage.missing.length <= 5 ? 'warn' : 'warn',
    coverage.missing.slice(0, 6).map(m => m.term).join(', ') + (coverage.missing.length > 6 ? '…' : ''));
  add('Standard section headings (Experience / Education / Skills)',
    (checks.find(c => c.label.includes('Experience section')) || {}).ok ? 'pass' : 'warn',
    `${vendor} parsers map these headings into structured fields.`);
  add('Contact block parseable (email + phone)',
    (checks.find(c => c.label.startsWith('Email')) || {}).ok && (checks.find(c => c.label.startsWith('Phone')) || {}).ok ? 'pass' : 'warn', '');
  // acronym + spelled-out form (Workday/Greenhouse match literally)
  const lower = String(resumeText || '').toLowerCase();
  const oneFormOnly = [];
  for (const group of SYNONYMS) {
    const presentForms = group.filter(f => lower.includes(f));
    if (presentForms.length === 1 && group.length > 1) oneFormOnly.push(`${group[0]} / ${group[1]}`);
  }
  if (vendor === 'Workday' || vendor === 'Greenhouse' || vendor === 'Lever') {
    add('Acronym + spelled-out form both present',
      oneFormOnly.length === 0 ? 'pass' : 'warn',
      oneFormOnly.length ? `Only one form found for: ${oneFormOnly.slice(0, 3).join(' · ')} — ${vendor} keyword matching is literal.` : '');
  }
  if (vendor === 'Workday') {
    const dates = (String(resumeText).match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}|\b\d{1,2}\/\d{4}\b/g) || []).length;
    add('Dates in parseable format (Mon YYYY or MM/YYYY)', dates >= 2 ? 'pass' : 'warn', `${dates} dated entries detected — Workday builds your timeline from these.`);
    const tableCheck = checks.find(c => c.label.includes('tables'));
    add('No tables / multi-column layout', tableCheck && tableCheck.ok ? 'pass' : 'warn', 'Workday is the strictest mainstream parser on layout.');
  }
  if (vendor === 'Ashby' || vendor === 'Lever') {
    add('Skills mirrored verbatim from the JD (where true)', coverage.pct >= 60 ? 'pass' : 'warn', `${vendor} search indexes your file text — exact tool names matter.`);
  }
  if (vendor === 'Generic') {
    add('Mirror the exact job title in your summary if truthful', 'info', 'Many screeners weight title similarity; never claim a title you did not hold.');
  }
  const note = COMPANY_NOTES[String(company || '').toLowerCase()];
  if (note) add(`Company note — ${company}`, 'info', note);
  add('Diagnostic only', 'info', 'Rules are guidance on how these parsers typically behave. Reformulate, never fabricate.');
  return { vendor, company: company || '', items };
}

// ── Resume tailorer — deterministic: selects/reorders verbatim cv.md facts ──
function playwrightBrowsersPath() {
  // Prefer an explicit env path, then the real user cache (not a sandbox temp).
  const envPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (envPath && existsSync(envPath)) return envPath;
  const homeCache = join(process.env.HOME || '', 'Library/Caches/ms-playwright');
  if (existsSync(homeCache)) return homeCache;
  return envPath || homeCache;
}
function runNodeFull(args, opts = {}) {
  return new Promise((resolveRun) => {
    execFile('node', args, { cwd: ROOT, timeout: opts.timeout || 60000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath() } },
      (err, stdout, stderr) => resolveRun({ code: err ? (err.code ?? 1) : 0, stdout: stdout || '', stderr: stderr || '' }));
  });
}

function parseCv(md) {
  const lines = String(md || '').split('\n');
  const cv = { name: '', location: '', email: '', phone: '', linkedin: '', github: '',
    summary: '', experience: [], projects: [], education: [], certifications: [], skills: [] };
  let section = '', entry = null;
  const flush = () => { if (entry) { (entry._kind === 'project' ? cv.projects : cv.experience).push(entry); entry = null; } };
  for (const raw of lines) {
    const line = raw.trim();
    const h1 = line.match(/^#\s+CV\s+--\s+(.+)/); if (h1) { cv.name = h1[1].trim(); continue; }
    const contact = line.match(/^\*\*(Location|Email|Phone|LinkedIn|GitHub):\*\*\s*(.+)/);
    if (contact) { cv[contact[1].toLowerCase()] = contact[2].trim(); continue; }
    const h2 = line.match(/^##\s+(.+)/);
    if (h2) { flush(); section = h2[1].trim(); continue; }
    if (section === 'Professional Summary' && line) {
      const bullet = line.replace(/^[-*•]\s+/, '').trim();
      if (bullet) cv.summary += (cv.summary ? '\n' : '') + `• ${bullet}`;
      continue;
    }
    if (section === 'Work Experience' || section === 'Projects') {
      const h3 = line.match(/^###\s+(.+)/);
      if (h3) {
        flush();
        const [head, loc] = h3[1].split(/\s+--\s+/);
        entry = { _kind: section === 'Projects' ? 'project' : 'job',
          company: head.trim(), name: head.trim(), location: (loc || '').trim(),
          role: '', dates: '', bullets: [] };
        continue;
      }
      if (!entry) continue;
      const role = line.match(/^\*\*(.+)\*\*$/);
      if (role && entry._kind === 'job' && !entry.role) { entry.role = role[1].trim(); continue; }
      if (line.startsWith('- ')) { entry.bullets.push(line.slice(2).trim()); continue; }
      if (line && !entry.dates && !/^Under\b/.test(line)) { entry.dates = line; continue; }
      continue;
    }
    if (section === 'Education' && line.startsWith('- ')) {
      const rawEdu = line.slice(2).trim();
      const m = rawEdu.match(/^([^,]+),\s*([^(]+)\(([^)]+)\)\s*(?:—\s*(.+))?$/);
      if (m) cv.education.push({ title: m[1].trim(), org: m[2].trim(), year: m[3].trim(),
        description: (m[4] || '').replace(/,\s*Charlotte, NC\.?$/, '').replace(/GPA:\s*/i, 'GPA ').replace(/,\s*/g, ' · '), location: 'Charlotte, NC' });
      else cv.education.push({ title: rawEdu, org: '', year: '', description: '', location: '' });
      continue;
    }
    if (section === 'Certifications' && line.startsWith('- ')) {
      const title = line.slice(2).trim();
      cv.certifications.push({ title, org: /AWS|Amazon/.test(title) ? 'Amazon Web Services' : '', year: '' });
      continue;
    }
    if (section === 'Skills') {
      const m = line.match(/^- \*\*(.+?):\*\*\s*(.+)/);
      if (m) cv.skills.push({ category: m[1].trim(), items: m[2].trim() });
      continue;
    }
  }
  flush();
  return cv;
}

/** Human-typing QA for resume/CV text (modes/_custom.md). */
function polishHumanTyping(text, { stripSummaryLocation = false } = {}) {
  let s = String(text || '');
  s = s.replace(/\bU\.?S\.?\s*citizen\b[,.]?/gi, '');
  s = s.replace(/\bno (visa )?sponsorship( needed| required)?\b[,.]?/gi, '');
  if (stripSummaryLocation) {
    s = s.replace(/\bCharlotte-based\b/gi, '');
    s = s.replace(/\b(based in|located in|from)\s+Charlotte(,? NC)?\b/gi, '');
    s = s.replace(/\bCharlotte preferred\b/gi, '');
    s = s.replace(/\blocal to [A-Z][A-Za-z .'-]+\b/gi, '');
    s = s.replace(/,?\s*Charlotte\s*\([^)]*\)/gi, '');
    s = s.replace(/,?\s*Charlotte,? NC\b/gi, '');
    s = s.replace(/\bin Fort Mill\b[^.]*/gi, '');
  }
  s = s.replace(/\s*--\s*/g, ' – ');
  s = s.replace(/\s{2,}/g, ' ').replace(/\s+([,.;:])/g, '$1');
  s = s.replace(/\s+;\s*;/g, ';').replace(/^[\s,;.–-]+|[\s,;.–-]+$/g, '').trim();
  return s;
}

function summaryAsBullets(summary) {
  let s = String(summary || '').trim();
  if (!s) return '';
  const lines = s.split(/\n+/).map(line => polishHumanTyping(line.replace(/^[-*•]\s+/, ''), { stripSummaryLocation: true }))
    .filter(Boolean);
  if (!lines.length) return '';
  if (lines.length > 1 || /^[-*•]/.test(summary.trim())) {
    return lines.map(l => `• ${l}`).join('\n');
  }
  // Paragraph → a few bullets on sentence boundaries (max 4).
  const parts = lines[0].split(/(?<=[.!?])\s+/).map(p => polishHumanTyping(p, { stripSummaryLocation: true })).filter(Boolean).slice(0, 4);
  return parts.map(p => `• ${p}`).join('\n');
}

function tailorPayload(cv, jdText, { company, jdTitle, format, bulletCap }) {
  const keywords = mineKeywords(jdText).map(k => k.term);
  const score = (text) => keywords.reduce((a, k) => a + keywordCount(k, text), 0) + (/\d/.test(text) ? 1 : 0);
  const byScore = (arr) => arr.map((b, i) => ({ b, i, s: score(b) }))
    .sort((x, y) => y.s - x.s || x.i - y.i).map(x => polishHumanTyping(x.b));
  const experience = cv.experience.map(e => ({
    company: polishHumanTyping(e.company), role: polishHumanTyping(e.role),
    location: e.location, dates: e.dates,
    bullets: byScore(e.bullets).slice(0, bulletCap),
  })).filter(e => e.bullets.length);
  const projects = cv.projects
    .map(p => ({ p, s: p.bullets.reduce((a, b) => a + score(b), 0) }))
    .sort((x, y) => y.s - x.s)
    .slice(0, format === 'cv' ? 99 : 2)
    .map(({ p }) => ({ name: polishHumanTyping(p.name), tech: p.dates || '',
      description: polishHumanTyping(byScore(p.bullets).slice(0, 2).join(' ')) }));
  const skills = cv.skills
    .filter(s => !/^spoken$/i.test(s.category) && !/spanish/i.test(s.items))
    .map(s => {
      const items = s.items.split(/,\s*/).map(polishHumanTyping).filter(Boolean)
        .filter(it => !/spanish/i.test(it));
      const matched = items.filter(it => keywords.some(k => keywordCount(k, it) > 0));
      const rest = items.filter(it => !matched.includes(it));
      return { category: s.category, items: [...matched, ...rest].join(', '),
        _s: matched.length };
    }).filter(s => s.items).sort((a, b) => b._s - a._s).map(({ _s, ...s }) => s);
  const education = (cv.education || []).map(e => ({
    ...e,
    title: polishHumanTyping(e.title),
    org: polishHumanTyping(e.org),
    description: polishHumanTyping(String(e.description || '')
      .replace(/\bU\.?S\.?\s*citizen\b[^·|]*/gi, '')
      .replace(/\bno sponsorship[^.·|]*/gi, '')
      .replace(/\bCharlotte preferred\b/gi, '')
      .replace(/\s*·\s*·+/g, ' · ').replace(/^\s*·\s*|\s*·\s*$/g, '').trim()),
  }));
  return {
    lang: 'en', page_format: 'letter',
    candidate: { name: cv.name, title: jdTitle || '', phone: cv.phone, email: cv.email,
      linkedin: { url: 'https://' + cv.linkedin.replace(/^https?:\/\//, ''), display: cv.linkedin },
      github: { url: 'https://' + cv.github.replace(/^https?:\/\//, ''), display: cv.github },
      location: cv.location },
    summary: summaryAsBullets(cv.summary), experience, projects,
    education, certifications: cv.certifications, skills,
  };
}

// ── Jobscan extras: predicted skills, power-edit, exact-form ─────────────────
const ROLE_FAMILIES = [
  { name: 'DevOps / Platform', keys: ['devops', 'kubernetes', 'terraform', 'ci/cd', 'aws', 'docker', 'sre', 'platform'],
    skills: ['Kubernetes', 'Terraform', 'Docker', 'CI/CD', 'AWS', 'Linux', 'GitHub Actions', 'Helm', 'Prometheus', 'observability'] },
  { name: 'Backend', keys: ['backend', 'api', 'microservices', 'java', 'python', 'node'],
    skills: ['REST APIs', 'microservices', 'SQL', 'PostgreSQL', 'Redis', 'Kafka', 'system design', 'unit testing', 'Docker', 'AWS'] },
  { name: 'Frontend', keys: ['frontend', 'react', 'ui', 'typescript'],
    skills: ['React', 'TypeScript', 'JavaScript', 'HTML', 'CSS', 'Next.js', 'testing', 'REST APIs'] },
  { name: 'Data', keys: ['data', 'etl', 'pipeline', 'analytics', 'sql'],
    skills: ['SQL', 'Python', 'data pipelines', 'ETL', 'Airflow', 'Snowflake', 'dbt', 'Spark', 'data warehouse'] },
  { name: 'AI / ML', keys: ['llm', 'machine learning', 'ai', 'ml', 'nlp'],
    skills: ['Python', 'LLM', 'RAG', 'embeddings', 'prompt engineering', 'model evaluation', 'PyTorch', 'vector database'] },
  { name: 'QA', keys: ['qa', 'quality', 'test'],
    skills: ['test automation', 'Selenium', 'Playwright', 'API testing', 'CI/CD', 'unit testing'] },
  { name: 'Security', keys: ['security', 'vulnerability', 'iam'],
    skills: ['security', 'vulnerability management', 'IAM', 'TLS', 'cloud architecture', 'Linux'] },
];
function predictedSkills(jdText, jdKeywords, resumeText) {
  const jd = String(jdText || '').toLowerCase();
  const scored = ROLE_FAMILIES.map(f => ({ f, hits: f.keys.filter(k => jd.includes(k)).length }))
    .sort((a, b) => b.hits - a.hits);
  const top = scored[0];
  if (!top || top.hits === 0) return { family: null, skills: [] };
  const inJd = new Set(jdKeywords.map(k => k.toLowerCase()));
  const skills = top.f.skills.filter(s => !inJd.has(s.toLowerCase()))
    .map(s => ({ term: s, inResume: keywordCount(s, resumeText) > 0 }));
  return { family: top.f.name, skills };
}

function exactFormWarnings(coverage, resumeText) {
  const out = [];
  for (const k of coverage.present) {
    if (countOccurrences(k, resumeText) > 0) continue;
    if (keywordCount(k, resumeText) === 0) continue;
    const alt = variantForms(k).find(f => f !== String(k).toLowerCase() && countOccurrences(f, resumeText) > 0);
    if (alt) {
      out.push({
        term: k,
        detail: `Resume has "${alt}" but the JD uses "${k}" — some ATSes match only the exact singular/plural form. Prefer the JD spelling where it's true.`,
      });
    } else {
      out.push({
        term: k,
        detail: `Only a synonym/variant form appears — some ATSes match the exact form "${k}".`,
      });
    }
  }
  return out;
}

function powerEditData(coverage, resumeText, gap) {
  const termOf = (m) => String((m && m.term) != null ? m.term : m || '');
  const supportedAdds = [];
  if (gap && Array.isArray(gap.supportedByResume)) {
    const supported = new Set(gap.supportedByResume.map(s => String(s).toLowerCase()));
    for (const m of coverage.missing) {
      const term = termOf(m);
      if (term && supported.has(term.toLowerCase())) {
        supportedAdds.push({ term, detail: 'Appears in your cv.md prose but not framed as a skill — safe to surface explicitly.' });
      }
    }
  }
  const bullets = String(resumeText || '').split('\n').map(s => s.trim())
    .filter(l => /^[-*•·]/.test(l)).map(l => l.replace(/^[-*•·]\s*/, ''));
  const keywords = [...coverage.present, ...coverage.missing.map(termOf)].filter(Boolean);
  const weakBullets = bullets
    .map(b => ({ b, s: keywords.reduce((a, k) => a + keywordCount(k, b), 0) }))
    .filter(x => x.s === 0 && x.b.split(/\s+/).length >= 6)
    .slice(0, 3)
    .map(x => ({ bullet: x.b, detail: 'Zero JD keywords — deprioritize or move below stronger bullets (the tailorer already reorders by this).' }));
  return { supportedAdds, weakBullets };
}

async function ollamaStatus() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    const r = await fetch('http://127.0.0.1:11434/api/tags', { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return { available: false, models: [] };
    const j = await r.json();
    return { available: true, models: (j.models || []).map(m => m.name) };
  } catch { return { available: false, models: [] }; }
}

// ── Auth ─────────────────────────────────────────────────────────────────────
function makeToken() {
  const exp = Date.now() + 7 * 86400000;
  const sig = crypto.createHmac('sha256', PASSWORD).update(String(exp)).digest('base64url');
  return `${exp}.${sig}`;
}
function isAuthed(req) {
  if (!PASSWORD) return true;
  const cookie = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('ats_auth='));
  if (!cookie) return false;
  const [exp, sig] = cookie.slice('ats_auth='.length).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const want = crypto.createHmac('sha256', PASSWORD).update(exp).digest('base64url');
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want)); } catch { return false; }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
const INDEX = readFileSync(join(HERE, 'index.html'), 'utf8');
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }
function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let b = ''; req.on('data', c => { b += c; if (b.length > 4_000_000) req.destroy(); });
    req.on('end', () => resolveBody(b)); req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(INDEX);
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, { ok: true, service: 'matchscan', storage: DB_URL ? 'neon' : 'local-file' });
    }
    if (req.method === 'GET' && url.pathname === '/api/auth-status') {
      return json(res, 200, { required: !!PASSWORD, authed: isAuthed(req), storage: DB_URL ? 'neon' : 'local-file' });
    }
    if (req.method === 'POST' && url.pathname === '/api/login') {
      const { password } = JSON.parse(await readBody(req) || '{}');
      const ok = PASSWORD && password && crypto.timingSafeEqual(
        Buffer.from(crypto.createHash('sha256').update(String(password)).digest('hex')),
        Buffer.from(crypto.createHash('sha256').update(PASSWORD).digest('hex')));
      if (!ok) return json(res, 401, { error: 'wrong password' });
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `ats_auth=${makeToken()}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800${secure}` });
      return res.end('{"ok":true}');
    }
    if (!url.pathname.startsWith('/api/')) { res.writeHead(404); return res.end('not found'); }
    if (!isAuthed(req)) return json(res, 401, { error: 'auth required' });

    if (req.method === 'GET' && url.pathname === '/api/sources') {
      const repo = repoSources();
      const [dbResumes, dbJds] = await Promise.all([store.listDocs('resume'), store.listDocs('jd')]);
      return json(res, 200, {
        resumes: [
          ...repo.resumes.map(({ id, label, group, kind }) => ({ id, label, group, kind: kind || 'md' })),
          ...dbResumes.map(d => ({ id: String(d.id), label: d.label, group: 'library', kind: 'library' })),
        ],
        jds: [
          ...repo.jds.map(({ id, label, group }) => ({ id, label, group: group || 'jd' })),
          ...dbJds.map(d => ({ id: String(d.id), label: d.label, group: 'library' })),
        ],
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/file') {
      const id = url.searchParams.get('id') || '';
      const doc = await resolveDoc(id);
      if (!doc) return json(res, 404, { error: 'not found' });
      if (url.searchParams.get('format') === 'html' && doc.isHtml) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(doc.content);
      }
      return json(res, 200, {
        id,
        label: doc.label,
        isHtml: !!doc.isHtml,
        text: doc.isHtml ? htmlToText(doc.content) : doc.content,
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/documents') {
      const { kind, label, content } = JSON.parse(await readBody(req) || '{}');
      if (!['resume', 'jd'].includes(kind) || !label || !content) return json(res, 400, { error: 'kind, label, content required' });
      const id = await store.addDoc(kind, String(label).slice(0, 120), String(content));
      await store.addNotif({ kind: 'library', title: `Saved to library: ${label}`, body: kind, key: `doc-${id}` });
      return json(res, 200, { id: String(id) });
    }
    const delMatch = url.pathname.match(/^\/api\/documents\/(\d+)$/);
    if (req.method === 'DELETE' && delMatch) {
      await store.deleteDoc(delMatch[1]);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/scans') {
      return json(res, 200, { scans: await store.listScans() });
    }
    const scanMatch = url.pathname.match(/^\/api\/scans\/(\d+)$/);
    if (req.method === 'GET' && scanMatch) {
      const s = await store.getScan(scanMatch[1]);
      if (!s) return json(res, 404, { error: 'not found' });
      return json(res, 200, { scan: s });
    }
    if (req.method === 'GET' && url.pathname === '/api/notifications') {
      const notifs = await store.listNotifs();
      return json(res, 200, { notifications: notifs, unread: notifs.filter(n => !n.read_at).length });
    }
    if (req.method === 'POST' && url.pathname === '/api/notifications/read-all') {
      await store.markAllRead();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/tracker') {
      const rows = parseTracker();
      if (!rows) return json(res, 200, { available: false, rows: [] });
      return json(res, 200, { available: true, rows });
    }
    if (req.method === 'GET' && url.pathname === '/api/next-steps') {
      return json(res, 200, readNextSteps());
    }
    if (req.method === 'POST' && url.pathname === '/api/tracker/status') {
      const { num, status } = JSON.parse(await readBody(req) || '{}');
      if (!CANONICAL_STATES.includes(status)) return json(res, 400, { error: 'not a canonical state' });
      const out = await new Promise((resolveOut) => {
        execFile('node', ['set-status.mjs', '--row', String(Number(num)), status, '--json'],
          { cwd: ROOT, timeout: 30000, maxBuffer: 2 * 1024 * 1024 },
          (err, stdout) => resolveOut({ code: err ? (err.code ?? 1) : 0, stdout: stdout || '' }));
      });
      let verdict = null;
      try { verdict = JSON.parse(out.stdout.slice(out.stdout.indexOf('{'))); } catch { /* not json */ }
      if (out.code !== 0 || !verdict || verdict.error) {
        return json(res, 400, { error: (verdict && verdict.error) || 'set-status failed' });
      }
      if (verdict.changed) {
        await store.addNotif({ kind: 'tracker', title: `Tracker #${num} → ${status}`, body: `${verdict.company || ''} — was ${verdict.oldStatus}`, key: `trk-${num}-${status}-${Date.now()}` });
      }
      return json(res, 200, { ok: true, changed: !!verdict.changed, rows: parseTracker() });
    }
    if (req.method === 'GET' && url.pathname === '/api/jobs') {
      const feed = jobsFeed();
      if (!feed) return json(res, 200, { available: false, jobs: [], refresh: { ...jobsRefreshState } });
      return json(res, 200, { available: true, ...feed });
    }
    if (req.method === 'POST' && url.pathname === '/api/jobs/refresh') {
      // Kick a portal scan (or return in-progress status). Long-running — client should poll /api/jobs.
      if (jobsRefreshState.running) {
        return json(res, 202, { ok: false, running: true, refresh: { ...jobsRefreshState }, feed: jobsFeed() });
      }
      runPortalScanRefresh().catch(() => {});
      return json(res, 202, { ok: true, started: true, refresh: { ...jobsRefreshState } });
    }
    if (req.method === 'POST' && url.pathname === '/api/jobs/decision') {
      const body = JSON.parse(await readBody(req) || '{}');
      const action = body.action === 'declined' ? 'declined' : body.action === 'applied' ? 'applied' : null;
      const company = String(body.company || '').trim();
      const title = String(body.title || body.role || '').trim();
      const jobUrl = String(body.url || '').trim();
      if (!action) return json(res, 400, { error: 'action must be applied or declined' });
      if (!company || !title) return json(res, 400, { error: 'company and title required' });
      if (action === 'applied') {
        const result = await markApplied({ company, title, url: jobUrl, note: body.note });
        if (!result.ok) return json(res, 400, result);
        await store.addNotif({
          kind: 'tracker',
          title: `Marked Applied: ${company}`,
          body: title,
          key: `applied-${result.trackerNum}-${Date.now()}`,
        });
        return json(res, 200, { ...result, feed: jobsFeed() });
      }
      const result = await markDeclined({ company, title, url: jobUrl, note: body.note });
      if (!result.ok) return json(res, 400, result);
      await store.addNotif({
        kind: 'jobs',
        title: `Declined: ${company}`,
        body: title,
        key: `declined-${slugify(company)}-${Date.now()}`,
      });
      return json(res, 200, { ...result, feed: jobsFeed() });
    }
    if (req.method === 'GET' && url.pathname === '/api/outreach') {
      const num = Number(url.searchParams.get('num') || 0);
      const company = String(url.searchParams.get('company') || '').trim();
      if (num) {
        let pack = readOutreachPack(num);
        if (!pack) {
          const row = (parseTracker() || []).find(r => r.num === num);
          if (!row) return json(res, 404, { error: 'tracker row not found' });
          pack = await buildOutreachPack({ num, company: row.company, role: row.role, url: row.url });
        }
        return json(res, 200, { pack });
      }
      if (company) {
        const row = (parseTracker() || []).find(r => normCo(r.company) === normCo(company) && r.status === 'Applied')
          || (parseTracker() || []).find(r => normCo(r.company) === normCo(company));
        const pack = await buildOutreachPack({
          num: row ? row.num : null,
          company,
          role: row ? row.role : String(url.searchParams.get('role') || 'Software Engineer'),
          url: row ? row.url : '',
        });
        return json(res, 200, { pack });
      }
      // list applied rows + whether outreach pack exists
      const rows = (parseTracker() || []).filter(r => ['Applied', 'Responded', 'Interview', 'Offer'].includes(r.status));
      return json(res, 200, {
        applications: rows.map(r => ({
          ...r,
          hasOutreach: existsSync(join(OUTREACH_DIR, `${r.num}.json`)),
        })),
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/outreach/generate') {
      const body = JSON.parse(await readBody(req) || '{}');
      const num = Number(body.num || 0);
      const row = num ? (parseTracker() || []).find(r => r.num === num) : null;
      const company = String(body.company || (row && row.company) || '').trim();
      const role = String(body.role || body.title || (row && row.role) || '').trim();
      const jobUrl = String(body.url || (row && row.url) || '').trim();
      if (!company || !role) return json(res, 400, { error: 'company and role required (or tracker num)' });
      const pack = await buildOutreachPack({ num: num || (row && row.num) || null, company, role, url: jobUrl });
      return json(res, 200, { pack });
    }
    if (req.method === 'POST' && url.pathname === '/api/job-jd') {
      const { jdUrl } = JSON.parse(await readBody(req) || '{}');
      if (!jdUrl || !/^https:\/\//.test(jdUrl)) return json(res, 400, { error: 'https URL required' });
      const out = await new Promise((resolveOut) => {
        execFile('node', ['fetch-jd.mjs', jdUrl], { cwd: ROOT, timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
          (err, stdout) => resolveOut(err && !stdout ? null : stdout));
      });
      if (!out || !out.trim()) return json(res, 404, { error: 'JD could not be fetched from the employer ATS' });
      return json(res, 200, { text: out });
    }
    if (req.method === 'GET' && url.pathname === '/api/download') {
      const name = (url.searchParams.get('name') || '').split('/').pop();
      if (!/^[\w.-]+\.pdf$/.test(name)) return json(res, 400, { error: 'bad name' });
      for (const dir of ['output/resumes', 'output/cvs']) {
        const p = join(ROOT, dir, name);
        if (existsSync(p)) {
          res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${name}"` });
          return res.end(readFileSync(p));
        }
      }
      return json(res, 404, { error: 'not found' });
    }
    if (req.method === 'POST' && url.pathname === '/api/tailor') {
      const payload = JSON.parse(await readBody(req) || '{}');
      const jdText = String(payload.jdText || '');
      const company = String(payload.company || 'Company').trim() || 'Company';
      const format = payload.format === 'cv' ? 'cv' : 'resume';
      if (!jdText.trim()) return json(res, 400, { error: 'JD text is empty' });
      const cvPath = join(ROOT, 'cv.md');
      if (!existsSync(cvPath)) return json(res, 400, { error: 'cv.md not found — tailorer runs locally with your career-ops data' });
      const cvRaw = readFileSync(cvPath, 'utf8');
      const cv = parseCv(cvRaw);
      const jdTitle = String(payload.jdTitle || '') || titleMatchOf('', jdText, '').jdTitle || '';
      const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'company';
      const kind = format === 'cv' ? 'cvs' : 'resumes';
      const template = format === 'cv' ? 'templates/cv-template.modern.html' : 'templates/cv-template.jake.html';
      const base = `site-${slug}`;
      const jsonPath = join(ROOT, 'output/source', kind, `${base}.json`);
      const htmlPath = join(ROOT, 'output/source', kind, `${base}.html`);
      const pdfName = `Zachary-Vogel-${format === 'cv' ? 'CV' : 'Resume'}-Site-${company.replace(/[^A-Za-z0-9]+/g, '')}.pdf`;
      const pdfPath = join(ROOT, 'output', kind, pdfName);
      const keywords = mineKeywords(jdText).map(k => k.term);
      const before = analyzeCoverage(keywords, cvRaw).coveragePct;

      let built = null, lastErr = '', pdfOk = false;
      for (const cap of (format === 'cv' ? [99] : [5, 4, 3, 2])) {
        const doc = tailorPayload(cv, jdText, { company, jdTitle, format, bulletCap: cap });
        writeFileSync(jsonPath, JSON.stringify(doc, null, 2));
        const facts = await runNodeFull(['verify-cv-facts.mjs', jsonPath]);
        if (facts.code !== 0) {
          return json(res, 422, { error: 'Fact gate blocked this build (something did not trace to cv.md)', issues: (facts.stdout + facts.stderr).slice(-1200) });
        }
        await runNodeFull(['cv-title-check.mjs', jsonPath, '--summary']);
        const html = await runNodeFull(['build-cv-html.mjs', jsonPath, htmlPath, template]);
        if (html.code !== 0) { lastErr = (html.stdout + html.stderr).slice(-800); continue; }
        const pdfArgs = ['generate-pdf.mjs', htmlPath, pdfPath, ...(format === 'resume' ? ['--max-pages=1', '--strict-pages'] : [])];
        const pdf = await runNodeFull(pdfArgs, { timeout: 150000 });
        if (pdf.code === 0) { built = { cap }; pdfOk = true; break; }
        built = { cap }; // keep HTML even if PDF fails
        lastErr = (pdf.stdout + pdf.stderr).slice(-800);
      }
      if (!built || !existsSync(htmlPath)) {
        return json(res, 500, {
          error: 'Tailor build failed',
          issues: lastErr || 'No HTML/PDF output. Try: npx playwright install chromium',
        });
      }
      const htmlContent = readFileSync(htmlPath, 'utf8');
      const ats = await parseabilityScore(htmlContent);
      const tailoredText = htmlToText(htmlContent);
      const after = analyzeCoverage(keywords, tailoredText).coveragePct;
      // Presence can't change by reordering — placement can: JD keywords inside the Skills section.
      const skillsSlice = (text) => {
        const i = String(text).toLowerCase().indexOf('skills');
        return i >= 0 ? String(text).slice(i, i + 1800) : '';
      };
      const inSkills = (text) => keywords.filter(k => keywordCount(k, skillsSlice(text)) > 0).length;
      const skillsBefore = inSkills(cvRaw), skillsAfter = inSkills(tailoredText);
      await store.addDoc('resume', `Tailored ${format} — ${company} (${new Date().toISOString().slice(0, 10)})`, htmlContent);
      await store.addNotif({
        kind: 'tailor',
        title: `Tailored ${format} ready: ${company}${pdfOk ? '' : ' (HTML only)'}`,
        body: `Coverage ${before}% → ${after}% · JD keywords in Skills ${skillsBefore} → ${skillsAfter}${pdfOk ? ` · PDF: ${pdfName}` : ' · PDF skipped'}`,
        key: `tailor-${base}-${Date.now()}`,
      });
      const htmlId = `repo:output/source/${kind}/${base}.html`;
      return json(res, 200, {
        ok: true, format, company, pdfName: pdfOk ? pdfName : null, pdfOk, htmlId, ats, before, after,
        skillsBefore, skillsAfter, text: tailoredText,
        warning: pdfOk ? null : 'HTML tailored resume saved to Resume Manager; PDF needs Playwright Chromium (npx playwright install chromium).',
        issues: pdfOk ? null : lastErr,
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/ai-status') {
      return json(res, 200, await ollamaStatus());
    }
    if (req.method === 'POST' && url.pathname === '/api/ai-rewrite') {
      const payload = JSON.parse(await readBody(req) || '{}');
      const status = await ollamaStatus();
      if (!status.available) return json(res, 501, { error: 'No local Ollama found. Install Ollama (free, ollama.com) and pull a model (e.g. ollama pull llama3.1), or use the copy-prompt instead.' });
      const model = status.models[0];
      const bullets = (Array.isArray(payload.bullets) ? payload.bullets : []).slice(0, 8);
      const prompt = `Rewrite each resume bullet for the job below. STRICT RULES: use ONLY facts present in the bullet itself; never invent metrics, tools, employers, or scope; you may rephrase and naturally include JD keywords ONLY where the bullet already describes that work; keep each bullet to one line starting with a strong verb; if a bullet cannot be improved within these rules, return it unchanged.\n\nJOB:\n${String(payload.jdText || '').slice(0, 3000)}\n\nBULLETS (one per line):\n${bullets.join('\n')}\n\nReturn ONLY the rewritten bullets, one per line, no numbering.`;
      try {
        const r = await fetch('http://127.0.0.1:11434/api/generate', { method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, prompt, stream: false }) });
        const j = await r.json();
        return json(res, 200, { model, rewrites: String(j.response || '').split('\n').map(s => s.trim()).filter(Boolean),
          warning: 'AI draft — verify every claim against your real experience before using any of it.' });
      } catch (e) { return json(res, 500, { error: String((e && e.message) || e) }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/scan-letter') {
      const payload = JSON.parse(await readBody(req) || '{}');
      const letter = String(payload.letterText || ''), jdText = String(payload.jdText || '');
      if (!letter.trim() || !jdText.trim()) return json(res, 400, { error: 'Letter and JD are both required' });
      const mined = mineKeywords(jdText);
      const cov = analyzeCoverage(mined.map(m => m.term), letter);
      const jdCounts = Object.fromEntries(mined.map(m => [m.term.toLowerCase(), m.jdCount]));
      const words = (letter.match(/\S+/g) || []).length;
      const checks = [
        { label: `Word count ${words} (250–400 is the sweet spot)`, ok: words >= 200 && words <= 450 },
        { label: 'Named greeting (not "To whom it may concern")', ok: !/to whom it may concern/i.test(letter) },
        { label: 'Company named in the letter', ok: !payload.company || letter.toLowerCase().includes(String(payload.company).toLowerCase()) },
        { label: 'Sign-off present (regards / sincerely / thank you)', ok: /(regards|sincerely|thank you|best)/i.test(letter) },
        { label: 'Refers to measurable results (numbers present)', ok: /\d/.test(letter) },
      ];
      return json(res, 200, {
        coverage: { pct: cov.coveragePct, total: cov.total, presentCount: cov.presentCount,
          present: cov.present.map(k => ({ term: k, jdCount: jdCounts[k.toLowerCase()] || 0 })),
          missing: cov.missing.map(k => ({ term: k, jdCount: jdCounts[k.toLowerCase()] || 0 })) },
        checks,
        disclaimer: 'Letters persuade humans; keywords help only lightly. Never claim experience the resume cannot back.',
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/scan') {
      const payload = JSON.parse(await readBody(req) || '{}');
      const jdText = String(payload.jdText || '');
      let resumeText = String(payload.resumeText || '');
      const doc = payload.resumeId ? await resolveDoc(payload.resumeId) : null;
      let parseability = null;
      if (!resumeText && doc) {
        resumeText = doc.isHtml ? htmlToText(doc.content) : doc.content;
        if (doc.isHtml) parseability = await parseabilityScore(doc.content);
      } else if (resumeText && /^\s*</.test(resumeText) && resumeText.includes('<')) {
        parseability = await parseabilityScore(resumeText);
        resumeText = htmlToText(resumeText);
      }
      if (!jdText.trim()) return json(res, 400, { error: 'JD text is empty' });
      if (!resumeText.trim()) return json(res, 400, { error: 'Resume text is empty' });

      const mined = mineKeywords(jdText);
      const extra = Array.isArray(payload.extraKeywords) ? payload.extraKeywords : [];
      const keywords = [...new Set([...mined.map(m => m.term), ...extra])];
      const coverage = analyzeCoverage(keywords, resumeText);
      const jdCounts = Object.fromEntries(mined.map(m => [m.term.toLowerCase(), m.jdCount]));
      const gap = await skillGap(jdText);

      const skills = splitSkills(coverage, resumeText, jdCounts);
      const titleM = titleMatchOf(payload.jdTitle, jdText, resumeText);
      const eduM = educationMatch(jdText, resumeText);
      // Jobscan-style weighted match: hard skills > education (only when required) > title > soft skills
      const parts = [{ w: 0.55, v: skills.hard.pct }, { w: 0.15, v: skills.soft.pct }];
      if (titleM.score !== null) parts.push({ w: 0.15, v: titleM.score });
      if (eduM.required) parts.push({ w: 0.15, v: eduM.status === 'pass' ? 100 : 30 });
      const wSum = parts.reduce((a, p) => a + p.w, 0);
      const matchScore = Math.round(parts.reduce((a, p) => a + p.w * p.v, 0) / wSum);
      const searchChecks = atsChecks(resumeText).filter(c =>
        /Email|Phone|Experience section|Education section|Skills section|Dates/.test(c.label));

      const result = {
        match: { score: matchScore,
          breakdown: { hard: skills.hard.pct, soft: skills.soft.pct, title: titleM.score, education: eduM.required ? (eduM.status === 'pass' ? 100 : 30) : null },
          title: titleM, education: eduM },
        skills,
        tips: recruiterTips(resumeText),
        searchability: { passed: searchChecks.filter(c => c.ok).length, total: searchChecks.length },
        coverage: {
          pct: coverage.coveragePct, total: coverage.total, presentCount: coverage.presentCount,
          present: coverage.present.map(k => ({ term: k, jdCount: jdCounts[k.toLowerCase()] || 0 })),
          thin: coverage.thin,
          missing: coverage.missing.map(k => ({ term: k, jdCount: jdCounts[k.toLowerCase()] || 0 })),
        },
        checks: atsChecks(resumeText),
        parseability,
        skillGap: gap,
        exactFormWarnings: exactFormWarnings(coverage, resumeText),
        predicted: predictedSkills(jdText, keywords, resumeText),
        powerEdit: powerEditData(coverage, resumeText, gap),
        atsRules: buildAtsRules(
          payload.atsVendor && payload.atsVendor !== 'auto' ? payload.atsVendor
            : detectVendor(payload.company || payload.jdLabel || '', jdText),
          String(payload.company || ''), resumeText,
          { pct: coverage.coveragePct, presentCount: coverage.presentCount, total: coverage.total,
            missing: coverage.missing.map(k => ({ term: k })) },
          atsChecks(resumeText)),
        disclaimer: 'Diagnostic only. Keywords get reformulated, never fabricated — only add a keyword if the experience is real.',
      };
      const resumeLabel = String(payload.resumeLabel || (doc && doc.label) || 'pasted resume').slice(0, 120);
      const jdLabel = String(payload.jdLabel || jdText.split('\n').map(s => s.trim()).find(Boolean) || 'pasted JD').slice(0, 120);
      const scanId = await store.addScan({
        resumeLabel, jdLabel,
        pct: result.match.score, // weighted Match Rate (history / trend chart)
        present: result.coverage.presentCount, total: result.coverage.total, detail: result,
      });
      await store.addNotif({
        kind: 'scan',
        title: `Scan complete: ${result.match.score}% weighted match (coverage ${result.coverage.pct}%)`,
        body: `${resumeLabel} vs ${jdLabel}`,
        key: `scan-${scanId}`,
      });
      return json(res, 200, { ...result, scanId: String(scanId) });
    }
    res.writeHead(404); return res.end('not found');
  } catch (e) {
    return json(res, 500, { error: String((e && e.message) || e) });
  }
});

await store.init();
await genFollowupNotifs().catch(() => {});
setInterval(() => genFollowupNotifs().catch(() => {}), 6 * 3600 * 1000).unref();
server.listen(PORT, BIND, () => {
  console.log(`ATS site -> http://${BIND}:${PORT}  (storage: ${DB_URL ? 'Neon Postgres' : 'local file'}, auth: ${PASSWORD ? 'password' : 'off'}${BIND === '127.0.0.1' ? ', this machine only' : ', network-visible'})`);
});
