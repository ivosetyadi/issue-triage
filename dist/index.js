// Issue Triage — zero-dependency GitHub Action (Node 20).
// On a new/edited issue: auto-labels it, flags likely duplicates, and assigns.
// Stateless — it recomputes from the repo's open issues each run, so there is
// no vector store and no server. Duplicate detection uses lexical similarity by
// default, or real embeddings if an API key is provided (BYOK). No npm install.

const fs = require('fs');

const log = (m) => process.stdout.write(m + '\n');

// ---- Default label rules (keyword -> label) -----------------------------------
const DEFAULT_LABELS = {
  bug: ['bug', 'error', 'crash', 'broken', 'not working', 'exception', 'fails', 'failure', 'regression', 'stack trace'],
  enhancement: ['feature', 'enhancement', 'request', 'would be nice', 'add support', 'proposal', 'suggestion'],
  question: ['question', 'how do i', 'how to', 'help', 'clarify', 'is it possible'],
  documentation: ['docs', 'documentation', 'readme', 'typo', 'example', 'tutorial'],
  security: ['security', 'vulnerability', 'cve', 'exploit', 'xss', 'sql injection', 'csrf', 'rce'],
};

const STOP = new Set(['the', 'a', 'an', 'is', 'to', 'of', 'and', 'in', 'on', 'for', 'it', 'this', 'that', 'with', 'i', 'my', 'me', 'we', 'you', 'be', 'or', 'as', 'at', 'by', 'if', 'when', 'but', 'not', 'are', 'was', 'can', 'do', 'does', 'how', 'what', 'why', 'get', 'got']);

// ---- Pure helpers (testable) --------------------------------------------------
function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, ' ') // drop fenced code blocks
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

function termFreq(tokens) {
  const m = new Map();
  for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

function cosineTF(a, b) {
  let dot = 0;
  for (const [k, v] of a) if (b.has(k)) dot += v * b.get(k);
  const mag = (m) => Math.sqrt([...m.values()].reduce((s, v) => s + v * v, 0));
  const d = mag(a) * mag(b);
  return d === 0 ? 0 : dot / d;
}

function similarityText(a, b) {
  return cosineTF(termFreq(tokenize(a)), termFreq(tokenize(b)));
}

function cosineVec(a, b) {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function classifyLabels(text, rules) {
  const hay = String(text || '').toLowerCase();
  const out = [];
  for (const [label, kws] of Object.entries(rules)) {
    if (kws.some((kw) => hay.includes(kw.toLowerCase()))) out.push(label);
  }
  return out;
}

// candidates: [{number, text}]; sims come from a provided similarity fn
function rankDuplicates(targetText, candidates, threshold, sim) {
  return candidates
    .map((c) => ({ number: c.number, score: sim(targetText, c.text) }))
    .filter((c) => c.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

function pickAssignees(labels, assigneeMap) {
  const set = new Set();
  for (const l of labels) (assigneeMap[l] || []).forEach((u) => set.add(u));
  return [...set];
}

// ---- Config (2-level YAML subset, no dependency) ------------------------------
// duplicate-threshold: 0.6
// comment: true
// labels:
//   bug: error, crash, broken
// assignees:
//   security: alice, bob
function loadConfig() {
  const cfg = { 'duplicate-threshold': 0.55, comment: true, labels: {}, assignees: {} };
  const path = process.env.INPUT_CONFIG || '.issuetriage.yml';
  let text;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch {
    return cfg;
  }
  let section = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').replace(/\s+$/, '');
    if (!line.trim()) continue;
    const indented = /^\s+/.test(raw);
    const kv = line.trim().match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, val] = kv;
    if (!indented) {
      if (key === 'labels' || key === 'assignees') {
        section = key;
      } else {
        section = null;
        if (key === 'duplicate-threshold') cfg[key] = parseFloat(val);
        else if (key === 'comment') cfg[key] = val.trim() !== 'false';
      }
    } else if (section && val) {
      cfg[section][key] = val.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  return cfg;
}

// ---- GitHub API ---------------------------------------------------------------
const GH = 'https://api.github.com';
const H = (token) => ({ Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'issue-triage' });

async function ghJson(path, token) {
  const res = await fetch(`${GH}${path}`, { headers: H(token) });
  if (!res.ok) throw new Error(`GitHub API ${res.status} on ${path}`);
  return res.json();
}

async function listOpenIssues(repo, token, excludeNumber) {
  const out = [];
  let page = 1;
  while (page <= 5) {
    const batch = await ghJson(`/repos/${repo}/issues?state=open&per_page=100&page=${page}`, token);
    for (const it of batch) {
      if (it.pull_request) continue; // issues endpoint also returns PRs
      if (it.number === excludeNumber) continue;
      out.push({ number: it.number, text: `${it.title}\n${it.body || ''}` });
    }
    if (batch.length < 100) break;
    page++;
  }
  return out;
}

// Optional embeddings via an OpenAI-compatible endpoint (BYOK).
async function embedTexts(texts, { apiKey, baseUrl, model }) {
  const res = await fetch(`${baseUrl || 'https://api.openai.com/v1'}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: model || 'text-embedding-3-small', input: texts }),
  });
  if (!res.ok) throw new Error(`Embeddings API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.data.map((d) => d.embedding);
}

const MARKER = '<!-- issue-triage -->';

// ---- Main ---------------------------------------------------------------------
async function run() {
  const token = process.env.GITHUB_TOKEN || process.env.INPUT_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error('No GITHUB_EVENT_PATH — run on an issues event.');
  const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  const issue = event.issue;
  if (!issue) {
    log('::notice::Issue Triage runs on issues events. Skipping.');
    return;
  }

  const cfg = loadConfig();
  const rules = { ...DEFAULT_LABELS, ...cfg.labels };
  const targetText = `${issue.title}\n${issue.body || ''}`;

  // 1. labels
  let labels = classifyLabels(targetText, rules);
  if ((process.env.INPUT_LABEL || 'true') === 'true' && labels.length) {
    await fetch(`${GH}/repos/${repo}/issues/${issue.number}/labels`, {
      method: 'POST',
      headers: H(token),
      body: JSON.stringify({ labels }),
    });
    log(`Applied labels: ${labels.join(', ')}`);
  }

  // 2. duplicates
  let dupes = [];
  if ((process.env.INPUT_DUPLICATES || 'true') === 'true') {
    const candidates = await listOpenIssues(repo, token, issue.number);
    const apiKey = process.env.INPUT_API_KEY || '';
    if (apiKey && candidates.length) {
      try {
        const vecs = await embedTexts([targetText, ...candidates.map((c) => c.text)], {
          apiKey,
          baseUrl: process.env.INPUT_BASE_URL,
          model: process.env.INPUT_EMBED_MODEL,
        });
        const tv = vecs[0];
        dupes = candidates
          .map((c, i) => ({ number: c.number, score: cosineVec(tv, vecs[i + 1]) }))
          .filter((c) => c.score >= cfg['duplicate-threshold'])
          .sort((a, b) => b.score - a.score)
          .slice(0, 3);
        log('Duplicate detection: embeddings');
      } catch (e) {
        log(`::warning::Embeddings failed (${e.message}); using lexical similarity.`);
      }
    }
    if (!dupes.length) {
      dupes = rankDuplicates(targetText, candidates, cfg['duplicate-threshold'], similarityText);
    }
  }

  // 3. comment on duplicates + label
  if (dupes.length && cfg.comment) {
    const list = dupes.map((d) => `- #${d.number} (${Math.round(d.score * 100)}% similar)`).join('\n');
    const body = `${MARKER}\n🔎 **Issue Triage** — this looks similar to:\n\n${list}\n\nIf it's the same, consider closing as a duplicate.`;
    await fetch(`${GH}/repos/${repo}/issues/${issue.number}/comments`, { method: 'POST', headers: H(token), body: JSON.stringify({ body }) });
    await fetch(`${GH}/repos/${repo}/issues/${issue.number}/labels`, { method: 'POST', headers: H(token), body: JSON.stringify({ labels: ['possible-duplicate'] }) });
    labels = [...labels, 'possible-duplicate'];
    log(`Flagged ${dupes.length} possible duplicate(s).`);
  }

  // 4. assignees
  if ((process.env.INPUT_ASSIGN || 'true') === 'true') {
    const assignees = pickAssignees(labels, cfg.assignees);
    if (assignees.length) {
      await fetch(`${GH}/repos/${repo}/issues/${issue.number}/assignees`, { method: 'POST', headers: H(token), body: JSON.stringify({ assignees }) });
      log(`Assigned: ${assignees.join(', ')}`);
    }
  }

  const out = process.env.GITHUB_OUTPUT;
  if (out) fs.appendFileSync(out, `labels=${labels.join(',')}\nduplicates=${dupes.map((d) => d.number).join(',')}\n`);
}

if (require.main === module) {
  run().catch((e) => {
    log(`::error::Issue Triage failed: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { tokenize, similarityText, cosineVec, classifyLabels, rankDuplicates, pickAssignees, loadConfig, DEFAULT_LABELS };
