#!/usr/bin/env node
// ideas-review.mjs - Daily idea review + weekly progress report
// Usage: node ideas-review.mjs [--weekly]
//
// Required env vars (set in .env):
//   NICODAIMUS_API_KEY   - your nicodAImus API key
//   TELEGRAM_BOT_TOKEN   - your Telegram bot token
//   TELEGRAM_CHAT_ID     - your Telegram chat ID (send /start to @userinfobot)
//
// Optional env vars:
//   IDEAS_STORE_URL      - default: http://ideas-store:9321
//   NICODAIMUS_API_URL   - default: https://chat.nicodaimus.com/v1
//   PROJECT_NAME         - default: My Ideas Pipeline (single-project mode only)
//   TODO_FILE            - path to your TODO markdown file (single-project mode)
//   STATUS_FILE          - path to your STATUS markdown file (single-project mode)
//   REPORTS_DIR          - where to save review reports (default: ./reports)
//
// Multi-project mode (optional):
//   PROJECTS             - CSV of project names, e.g. "web,mobile,ops". Enables per-project routing.
//   PROJECT_<NAME>_TODO  - per-project TODO file, e.g. PROJECT_web_TODO=./web/TODO.md
//   PROJECT_<NAME>_STATUS - per-project STATUS file (optional)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';

const IDEAS_STORE_URL = process.env.IDEAS_STORE_URL || 'http://ideas-store:9321';
const NICODAIMUS_API_URL = process.env.NICODAIMUS_API_URL || 'https://chat.nicodaimus.com/v1';
const NICODAIMUS_API_KEY = process.env.NICODAIMUS_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PROJECT_NAME = process.env.PROJECT_NAME || 'My Ideas Pipeline';
const TODO_FILE = process.env.TODO_FILE ? resolve(process.env.TODO_FILE) : null;
const STATUS_FILE = process.env.STATUS_FILE ? resolve(process.env.STATUS_FILE) : null;
const REPORTS_DIR = process.env.REPORTS_DIR ? resolve(process.env.REPORTS_DIR) : resolve('./reports');
const MODE = process.argv.includes('--weekly') ? 'weekly' : 'daily';

// Multi-project config
const PROJECTS = (process.env.PROJECTS || '').split(',').map(s => s.trim()).filter(Boolean);
const MULTI_PROJECT = PROJECTS.length > 0;
const DEFAULT_PROJECT = PROJECTS[0] || null;
function projectOf(idea) {
  if (!MULTI_PROJECT) return null;
  return PROJECTS.includes(idea.project) ? idea.project : DEFAULT_PROJECT;
}
function perProjectPath(project, kind) {
  // kind = 'TODO' or 'STATUS'. Env var name: PROJECT_<project>_<kind>
  const envKey = 'PROJECT_' + project + '_' + kind;
  return process.env[envKey] ? resolve(process.env[envKey]) : null;
}

// ROI scoring weights
const WEIGHTS = {
  security: 0.30,
  customer: 0.30,
  effort: 0.20,    // inverse: 5=easy, 1=massive
  business: 0.20,
};

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function fetchIdeas() {
  const res = await fetch(`${IDEAS_STORE_URL}/ideas`);
  if (!res.ok) throw new Error(`Ideas store ${res.status}: ${await res.text()}`);
  return res.json();
}

async function updateIdeaStatus(id, status) {
  const res = await fetch(`${IDEAS_STORE_URL}/ideas/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) log(`Warning: failed to update idea #${id} status: ${res.status}`);
}

function extractTodoSummary(text) {
  // Pull section headers + any table rows that are not marked done, to stay within context window.
  // Works for both Markdown heading-style TODOs and table-style TODOs.
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('## ') || line.startsWith('### ')) {
      out.push(line);
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        if (/^\*\*(Priority|Area|Status):\*\*/.test(lines[j])) out.push(lines[j]);
      }
    } else if (/^\|\s*[\w-]+/.test(line) && !/\|\s*done\s*\|/i.test(line)) {
      // Table row, not done. Keep first 5 columns only.
      out.push(line.split('|').slice(0, 5).join('|'));
    }
  }
  return out.join('\n') || '(empty TODO file)';
}

function readTodo(filePath) {
  const f = filePath || TODO_FILE;
  if (!f || !existsSync(f)) return '(no TODO file configured)';
  return extractTodoSummary(readFileSync(f, 'utf8'));
}

function readStatus(filePath) {
  const f = filePath || STATUS_FILE;
  if (!f || !existsSync(f)) return '';
  const lines = readFileSync(f, 'utf8').split('\n');
  return lines.filter(l => l.startsWith('## ') || l.startsWith('### ')).join('\n');
}

// Returns { [projectName]: todoMdString } for multi-project mode, or {} otherwise.
function readProjectTodos() {
  if (!MULTI_PROJECT) return {};
  const out = {};
  for (const p of PROJECTS) {
    const path = perProjectPath(p, 'TODO');
    out[p] = path ? readTodo(path) : '(no TODO file configured for ' + p + ')';
  }
  return out;
}
function readProjectStatuses() {
  if (!MULTI_PROJECT) return {};
  const out = {};
  for (const p of PROJECTS) {
    const path = perProjectPath(p, 'STATUS');
    out[p] = path ? readStatus(path) : '';
  }
  return out;
}

async function callNicodaimus(prompt) {
  const res = await fetch(`${NICODAIMUS_API_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${NICODAIMUS_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'auto',
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`nicodAImus API ${res.status}: ${err}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('nicodAImus API returned empty choices');
  if (content.length < 200 && /failed|error|unavailable/i.test(content)) {
    throw new Error(`nicodAImus API returned error content: ${content}`);
  }
  return content;
}

function sanitizeTelegramHtml(text) {
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/?(p|div|h[1-6]|ul|ol|li|table|tr|td|th|thead|tbody|blockquote|section|article|header|footer|hr)\s*\/?>/gi, '\n');
  const allowed = /^\/?(b|i|u|s|code|pre|a)\b/i;
  text = text.replace(/<\/?[^>]+>/g, (tag) => {
    const inner = tag.replace(/^<\/?/, '').replace(/\/?>$/, '').trim();
    return allowed.test(inner) ? tag : '';
  });
  text = text.replace(/\n{3,}/g, '\n\n');
  return text;
}

async function sendTelegram(text) {
  text = sanitizeTelegramHtml(text);
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= 4000) { chunks.push(remaining); break; }
    let splitAt = remaining.lastIndexOf('\n', 4000);
    if (splitAt <= 0) splitAt = 4000;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  for (const chunk of chunks) {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: chunk, parse_mode: 'HTML' }),
      }
    );
    if (!res.ok) {
      const err = await res.text();
      log(`Telegram error: ${err}`);
      const retry = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: chunk }),
        }
      );
      if (!retry.ok) log(`Telegram retry also failed: ${await retry.text()}`);
    }
  }
}

function saveReport(filename, content) {
  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
  const filePath = join(REPORTS_DIR, filename);
  writeFileSync(filePath, content);
  log(`Report saved: ${filePath}`);
  return filePath;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function parseJsonResponse(text) {
  let jsonText = text.trim();
  // Extract JSON from markdown fences (greedy match for nested fences)
  const fenceMatch = jsonText.match(/```(?:json)?\s*\n?([\s\S]*)\n?\s*```\s*$/);
  if (fenceMatch) jsonText = fenceMatch[1].trim();
  // Fallback: find first { to last }
  if (!jsonText.startsWith('{')) {
    const start = jsonText.indexOf('{');
    const end = jsonText.lastIndexOf('}');
    if (start !== -1 && end !== -1) jsonText = jsonText.slice(start, end + 1);
  }
  return JSON.parse(jsonText);
}

// ---- DAILY REVIEW ----

async function dailyReview() {
  log('Starting daily idea review...');

  const ideas = await fetchIdeas();
  const newIdeas = ideas.filter(i => i.status === 'new');

  if (newIdeas.length === 0) {
    log('No new ideas to review.');
    await sendTelegram(`\u2615 <b>Daily Ideas Review</b> (${today()})\n\nNo new ideas to review. All caught up!`);
    return;
  }

  log(`Found ${newIdeas.length} new idea(s) to review.`);
  if (MULTI_PROJECT) {
    const counts = {};
    for (const i of newIdeas) counts[projectOf(i)] = (counts[projectOf(i)] || 0) + 1;
    log('Project breakdown: ' + Object.entries(counts).map(([k,v]) => `${k}=${v}`).join(', '));
  }
  const todoMd = MULTI_PROJECT ? null : readTodo();
  const statusMd = MULTI_PROJECT ? null : readStatus();
  const projectTodos = readProjectTodos();
  const projectStatuses = readProjectStatuses();
  const prompt = buildDailyPrompt(newIdeas, ideas, { todoMd, statusMd, projectTodos, projectStatuses });
  const analysis = await callNicodaimus(prompt);

  let result;
  try {
    result = parseJsonResponse(analysis);
  } catch (e) {
    log('Warning: Could not parse response as JSON. Sending raw analysis.');
    const reportPath = saveReport(`review-${today()}.md`, `# Daily Ideas Review - ${today()}\n\n${analysis}`);
    await sendTelegram(`\u2615 <b>Daily Ideas Review</b> (${today()})\n\n${newIdeas.length} idea(s) reviewed.\n\nNote: Auto-parse failed.\n<code>${reportPath}</code>`);
    return;
  }

  const report = buildDailyReport(result, newIdeas);
  saveReport(`review-${today()}.md`, report);

  const telegram = buildDailyTelegram(result);
  await sendTelegram(telegram);

  for (const idea of result.ideas || []) {
    if (idea.id && idea.recommendation !== 'needs_research') {
      await updateIdeaStatus(idea.id, 'reviewed');
    }
  }

  log('Daily review complete.');
}

function buildDailyPrompt(newIdeas, allIdeas, ctx) {
  const { todoMd, statusMd, projectTodos, projectStatuses } = ctx;
  // Normalize project field on ideas sent to the model in multi-project mode
  const normalizedIdeas = MULTI_PROJECT
    ? newIdeas.map(i => ({ ...i, project: projectOf(i) }))
    : newIdeas;
  const ideasJson = JSON.stringify(normalizedIdeas, null, 2);

  let prompt;
  if (MULTI_PROJECT) {
    prompt = `You are the daily review analyst for multiple projects: ${PROJECTS.join(', ')}.
Each idea has a "project" field. When checking for duplicates, check only against the TODO file of the matching project.

## ROI Scoring (1-5 scale for each, then weighted composite out of 10)
- Security Impact (weight: ${WEIGHTS.security}): Does this improve security posture, protect users, or address vulnerabilities?
- Customer Value (weight: ${WEIGHTS.customer}): Does this directly benefit users? Improve UX? Solve pain points?
- Implementation Effort (weight: ${WEIGHTS.effort}): How easy to implement? 5=trivial (hours), 4=small (1 day), 3=medium (2-3 days), 2=large (1 week), 1=massive (weeks+)
- Business Impact (weight: ${WEIGHTS.business}): Revenue potential, differentiation, growth, competitive advantage?

Composite = (security*${WEIGHTS.security} + customer*${WEIGHTS.customer} + effort*${WEIGHTS.effort} + business*${WEIGHTS.business}) * 2

## New Ideas to Review
${ideasJson}
`;
    for (const p of PROJECTS) {
      prompt += `\n## ${p} Backlog (TODO)\n${projectTodos[p] || '(none)'}\n`;
      if (projectStatuses[p]) {
        prompt += `\n## ${p} Feature Inventory (STATUS)\n${projectStatuses[p]}\n`;
      }
    }
  } else {
    prompt = `You are the daily review analyst for "${PROJECT_NAME}".
Your job is to analyze new ideas, score them by ROI, check for duplicates against the existing backlog${statusMd ? ' AND already-shipped features' : ''}, and make recommendations.

## ROI Scoring (1-5 scale for each, then weighted composite out of 10)
- Security Impact (weight: ${WEIGHTS.security}): Does this improve security posture, protect users, or address vulnerabilities?
- Customer Value (weight: ${WEIGHTS.customer}): Does this directly benefit users? Improve UX? Solve pain points?
- Implementation Effort (weight: ${WEIGHTS.effort}): How easy to implement? 5=trivial (hours), 4=small (1 day), 3=medium (2-3 days), 2=large (1 week), 1=massive (weeks+)
- Business Impact (weight: ${WEIGHTS.business}): Revenue potential, differentiation, growth, competitive advantage?

Composite = (security*${WEIGHTS.security} + customer*${WEIGHTS.customer} + effort*${WEIGHTS.effort} + business*${WEIGHTS.business}) * 2

## New Ideas to Review
${ideasJson}

## Current Backlog (TODO) - Check for duplicates against planned work
${todoMd}`;
    if (statusMd) {
      prompt += `

## Current Feature Inventory (STATUS) - Check for duplicates against shipped features
${statusMd}`;
    }
  }

  prompt += `

## Instructions
For each new idea, provide:
- ROI scores (security, customer, effort, business) and composite
- Whether it duplicates an existing backlog item or shipped feature (cite which one)
- Brief research notes: best practices, competitor approaches, security implications
- Recommendation: "add_to_todo" (should be added to backlog), "defer" (interesting but not now), "reject" (not valuable), "needs_research" (promising but needs deeper investigation)
- If "add_to_todo": suggest which backlog section and priority (P0-P3)${MULTI_PROJECT ? '\n- Echo the idea\'s project in your output so the report can group by project' : ''}

CRITICAL JSON RULES:
- Respond with ONLY the raw JSON object. No markdown fences, no text before or after.
- All string values must be single-line. Escape newlines as \\n, not literal line breaks.

{
  "ideas": [
    {
      "id": <number>,
      "title": "<string>",${MULTI_PROJECT ? `\n      "project": "${PROJECTS.join('|')}",` : ''}
      "scores": { "security": <1-5>, "customer": <1-5>, "effort": <1-5>, "business": <1-5> },
      "roi_composite": <number 0-10>,
      "is_duplicate": <boolean>,
      "duplicate_of": "<backlog/status item name or null>",
      "research_notes": "<single-line string, no literal newlines>",
      "recommendation": "add_to_todo|defer|reject|needs_research",
      "suggested_priority": "P0|P1|P2|P3",
      "suggested_section": "<backlog section name>",
      "rationale": "<1-2 sentences, single-line>"
    }
  ],
  "ranked_summary": "<optional: ranked list of ideas by ROI>",
  "top_recommendation": "<optional: 1-2 sentence focus recommendation>"
}`;

  return prompt;
}

function renderIdeaBlock(idea) {
  const rec = {
    add_to_todo: 'ADD TO BACKLOG',
    defer: 'DEFER',
    reject: 'REJECT',
    needs_research: 'NEEDS RESEARCH',
  }[idea.recommendation] || idea.recommendation;
  let md = '';
  md += `${MULTI_PROJECT ? '### ' : '## '}#${idea.id} - ${idea.title}\n\n`;
  md += `| Metric | Score |\n|--------|-------|\n`;
  md += `| Security | ${idea.scores?.security || '?'}/5 |\n`;
  md += `| Customer | ${idea.scores?.customer || '?'}/5 |\n`;
  md += `| Effort | ${idea.scores?.effort || '?'}/5 |\n`;
  md += `| Business | ${idea.scores?.business || '?'}/5 |\n`;
  md += `| **ROI Composite** | **${idea.roi_composite || '?'}/10** |\n\n`;
  md += `**Recommendation:** ${rec}`;
  if (idea.suggested_priority) md += ` (${idea.suggested_priority})`;
  if (idea.suggested_section) md += ` - Section: ${idea.suggested_section}`;
  md += `\n\n`;
  if (idea.is_duplicate) md += `**Duplicate of:** ${idea.duplicate_of}\n\n`;
  if (idea.research_notes) md += `**Research:** ${idea.research_notes}\n\n`;
  if (idea.rationale) md += `**Rationale:** ${idea.rationale}\n\n`;
  md += `---\n\n`;
  return md;
}

function buildDailyReport(result, newIdeas) {
  let md = `# Daily Ideas Review - ${today()}\n\n`;
  md += `**Project:** ${MULTI_PROJECT ? PROJECTS.join(', ') : PROJECT_NAME}\n`;
  md += `**Ideas reviewed:** ${(result.ideas || []).length}\n\n`;

  if (MULTI_PROJECT) {
    const byProject = Object.fromEntries(PROJECTS.map(p => [p, []]));
    for (const idea of result.ideas || []) {
      const p = PROJECTS.includes(idea.project) ? idea.project : DEFAULT_PROJECT;
      (byProject[p] || byProject[DEFAULT_PROJECT]).push(idea);
    }
    for (const p of PROJECTS) {
      if (!byProject[p].length) continue;
      md += `## ${p} (${byProject[p].length})\n\n`;
      for (const idea of byProject[p]) md += renderIdeaBlock(idea);
    }
  } else {
    for (const idea of result.ideas || []) md += renderIdeaBlock(idea);
  }

  if (result.ranked_summary) md += `## Ranked Summary\n\n${result.ranked_summary}\n\n`;
  if (result.top_recommendation) md += `## Top Recommendation\n\n${result.top_recommendation}\n\n`;
  return md;
}

function ideaTelegramLine(idea) {
  const emoji = {
    add_to_todo: '\u2705',
    defer: '\u23f8\ufe0f',
    reject: '\u274c',
    needs_research: '\ud83d\udd0d',
  }[idea.recommendation] || '\u2753';
  return `${emoji} #${idea.id} <b>${idea.title}</b> [${idea.roi_composite}/10]\n`;
}

function buildDailyTelegram(result) {
  let msg = `\u2615 <b>Daily Ideas Review</b> (${today()})\n\n`;

  if (MULTI_PROJECT) {
    const byProject = Object.fromEntries(PROJECTS.map(p => [p, []]));
    for (const idea of result.ideas || []) {
      const p = PROJECTS.includes(idea.project) ? idea.project : DEFAULT_PROJECT;
      (byProject[p] || byProject[DEFAULT_PROJECT]).push(idea);
    }
    for (const p of PROJECTS) {
      if (!byProject[p].length) continue;
      msg += `<b>[${p}]</b>\n`;
      for (const idea of byProject[p]) msg += ideaTelegramLine(idea);
      msg += `\n`;
    }
  } else {
    for (const idea of result.ideas || []) msg += ideaTelegramLine(idea);
  }

  if (result.top_recommendation) msg += `\n\ud83c\udfaf <b>Focus:</b> ${result.top_recommendation}`;
  return msg;
}

// ---- WEEKLY REPORT ----

async function weeklyReport() {
  log('Starting weekly progress report...');

  const ideas = await fetchIdeas();
  const todoMd = MULTI_PROJECT ? null : readTodo();
  const statusMd = MULTI_PROJECT ? null : readStatus();
  const projectTodos = readProjectTodos();
  const projectStatuses = readProjectStatuses();
  const prompt = buildWeeklyPrompt(ideas, { todoMd, statusMd, projectTodos, projectStatuses });
  const analysis = await callNicodaimus(prompt);

  let result;
  try {
    result = parseJsonResponse(analysis);
  } catch (e) {
    log('Warning: Could not parse weekly response as JSON.');
    const reportPath = saveReport(`weekly-${today()}.md`, `# Weekly Report - ${today()}\n\n${analysis}`);
    await sendTelegram(`\ud83d\udcca <b>Weekly Report</b> (${today()})\n\nSee full report:\n<code>${reportPath}</code>`);
    return;
  }

  const report = buildWeeklyReport(result);
  saveReport(`weekly-${today()}.md`, report);

  const telegram = buildWeeklyTelegram(result);
  await sendTelegram(telegram);

  log('Weekly report complete.');
}

function buildWeeklyPrompt(ideas, ctx) {
  const { todoMd, statusMd, projectTodos, projectStatuses } = ctx;
  const normalizedIdeas = MULTI_PROJECT ? ideas.map(i => ({ ...i, project: projectOf(i) })) : ideas;

  let prompt;
  if (MULTI_PROJECT) {
    prompt = `You are the weekly review analyst for multiple projects: ${PROJECTS.join(', ')}.
Produce a Sunday evening progress report: what happened this week per project, what has been implemented, parked, or deferred, and what should come next.

## All Ideas in Pipeline
${JSON.stringify(normalizedIdeas, null, 2)}
`;
    for (const p of PROJECTS) {
      prompt += `\n## ${p} Backlog (TODO)\n${projectTodos[p] || '(none)'}\n`;
      if (projectStatuses[p]) prompt += `\n## ${p} Feature Inventory\n${projectStatuses[p]}\n`;
    }
  } else {
    prompt = `You are the weekly review analyst for "${PROJECT_NAME}".
Your job is to produce a Sunday evening progress report: what happened this week, what's been implemented, parked, or deferred, and what should come next.

## All Ideas in Pipeline
${JSON.stringify(ideas, null, 2)}

## Current Backlog (TODO)
${todoMd}`;
    if (statusMd) {
      prompt += `

## Current Feature Inventory (STATUS) - What's already shipped
${statusMd}`;
    }
  }

  prompt += `

## ROI Scoring Weights
Security: ${WEIGHTS.security}, Customer: ${WEIGHTS.customer}, Effort: ${WEIGHTS.effort}, Business: ${WEIGHTS.business}

## Instructions
1. Categorize all ideas by current status (new, reviewed, done, rejected, deferred)${MULTI_PROJECT ? ' AND by project' : ''}
2. For ideas still "new" or "reviewed": re-evaluate priorities. Has anything changed? Should priorities shift?
3. Check for duplicates across ideas AND between ideas and the backlog${MULTI_PROJECT ? ' of the matching project' : ''}
4. Identify the top 3-5 items to focus on next week${MULTI_PROJECT ? ' per project' : ''} (from both ideas and backlog), ranked by ROI
5. Flag any ideas that have been sitting too long without action (>7 days in "new")
6. Provide a weekly health score (1-10)${MULTI_PROJECT ? ' per project' : ''}: is the idea pipeline flowing well? Are items getting actioned?

Respond with ONLY valid JSON:
`;
  if (MULTI_PROJECT) {
    prompt += `{
  "status_summary": {
    "total": <number>, "new": <number>, "reviewed": <number>, "done": <number>, "rejected": <number>, "deferred": <number>,
    "by_project": { ${PROJECTS.map(p => `"${p}": <number>`).join(', ')} }
  },
  "projects": {
${PROJECTS.map(p => `    "${p}": {
      "completed_this_week": ["<title>", ...],
      "priority_changes": [ { "id": <number>, "title": "<string>", "old_priority": "<string>", "new_priority": "<string>", "reason": "<string>" } ],
      "duplicates_found": [ { "idea_id": <number>, "duplicate_of": "<string>" } ],
      "stale_ideas": [ { "id": <number>, "title": "<string>", "days_old": <number> } ],
      "next_week_focus": [ { "title": "<string>", "source": "idea|todo", "roi_score": <number>, "rationale": "<string>" } ],
      "pipeline_health": <1-10>,
      "pipeline_health_notes": "<string>"
    }`).join(',\n')}
  }
}`;
  } else {
    prompt += `{
  "status_summary": {
    "total": <number>,
    "new": <number>,
    "reviewed": <number>,
    "done": <number>,
    "rejected": <number>,
    "deferred": <number>
  },
  "completed_this_week": ["<title>", ...],
  "priority_changes": [
    { "id": <number>, "title": "<string>", "old_priority": "<string>", "new_priority": "<string>", "reason": "<string>" }
  ],
  "duplicates_found": [
    { "idea_id": <number>, "duplicate_of": "<string>" }
  ],
  "stale_ideas": [
    { "id": <number>, "title": "<string>", "days_old": <number> }
  ],
  "next_week_focus": [
    { "title": "<string>", "source": "idea|todo", "roi_score": <number>, "rationale": "<string>" }
  ],
  "pipeline_health": <1-10>,
  "pipeline_health_notes": "<string>"
}`;
  }

  return prompt;
}

function renderWeeklyProjectSectionMd(data, label) {
  let md = '';
  md += `## ${label}\n\n`;
  if (data.pipeline_health) md += `**Pipeline Health:** ${data.pipeline_health}/10\n`;
  if (data.pipeline_health_notes) md += `${data.pipeline_health_notes}\n`;
  md += `\n`;

  if (data.completed_this_week?.length) {
    md += `### Completed This Week\n`;
    for (const item of data.completed_this_week) md += `- ${item}\n`;
    md += `\n`;
  }
  if (data.priority_changes?.length) {
    md += `### Priority Changes\n`;
    for (const pc of data.priority_changes) md += `- #${pc.id} ${pc.title}: ${pc.old_priority} -> ${pc.new_priority} (${pc.reason})\n`;
    md += `\n`;
  }
  if (data.duplicates_found?.length) {
    md += `### Duplicates Found\n`;
    for (const d of data.duplicates_found) md += `- Idea #${d.idea_id} duplicates: ${d.duplicate_of}\n`;
    md += `\n`;
  }
  if (data.stale_ideas?.length) {
    md += `### Stale Ideas (>7 days)\n`;
    for (const si of data.stale_ideas) md += `- #${si.id} ${si.title} (${si.days_old} days old)\n`;
    md += `\n`;
  }
  if (data.next_week_focus?.length) {
    md += `### Next Week Focus\n`;
    for (let i = 0; i < data.next_week_focus.length; i++) {
      const f = data.next_week_focus[i];
      md += `${i + 1}. **${f.title}** (ROI: ${f.roi_score}/10) - Source: ${f.source || 'unknown'}\n`;
      if (f.rationale) md += `   ${f.rationale}\n`;
    }
    md += `\n`;
  }
  return md;
}

function buildWeeklyReport(result) {
  let md = `# Weekly Progress Report - ${today()}\n\n`;
  md += `**Project:** ${MULTI_PROJECT ? PROJECTS.join(', ') : PROJECT_NAME}\n\n`;

  const s = result.status_summary || {};
  md += `## Pipeline Status\n`;
  md += `| Status | Count |\n|--------|-------|\n`;
  for (const [k, v] of Object.entries(s)) {
    if (k === 'by_project') continue;
    md += `| ${k} | ${v} |\n`;
  }
  if (MULTI_PROJECT && s.by_project) {
    md += `\n**By project:** `;
    md += PROJECTS.filter(p => s.by_project[p]).map(p => `[${p}]: ${s.by_project[p]}`).join(' | ');
    md += `\n`;
  }
  md += `\n`;

  if (MULTI_PROJECT) {
    const projects = result.projects || {};
    for (const p of PROJECTS) {
      const data = projects[p];
      if (!data) continue;
      md += renderWeeklyProjectSectionMd(data, p);
    }
  } else {
    md += renderWeeklyProjectSectionMd({
      pipeline_health: result.pipeline_health,
      pipeline_health_notes: result.pipeline_health_notes,
      completed_this_week: result.completed_this_week,
      priority_changes: result.priority_changes,
      duplicates_found: result.duplicates_found,
      stale_ideas: result.stale_ideas,
      next_week_focus: result.next_week_focus,
    }, PROJECT_NAME);
  }

  return md;
}

function renderWeeklyProjectSectionTg(data, label) {
  let msg = `<b>[${label}]</b>`;
  if (data.pipeline_health) msg += ` - Health ${data.pipeline_health}/10`;
  msg += `\n`;

  if (data.completed_this_week?.length) {
    msg += `\u2705 Shipped:\n`;
    for (const item of data.completed_this_week.slice(0, 3)) msg += `  ${item}\n`;
    if (data.completed_this_week.length > 3) msg += `  +${data.completed_this_week.length - 3} more\n`;
  }
  if (data.next_week_focus?.length) {
    msg += `\ud83c\udfaf Next:\n`;
    for (let i = 0; i < Math.min(data.next_week_focus.length, 3); i++) {
      const f = data.next_week_focus[i];
      msg += `  ${i + 1}. <b>${f.title}</b> [${f.roi_score}/10]\n`;
    }
  }
  if (data.stale_ideas?.length) {
    msg += `\u26a0\ufe0f ${data.stale_ideas.length} stale: `;
    msg += data.stale_ideas.map(si => `#${si.id}`).join(', ');
    msg += `\n`;
  }
  if (data.duplicates_found?.length) {
    msg += `\ud83d\udd04 ${data.duplicates_found.length} duplicate(s)\n`;
  }
  msg += `\n`;
  return msg;
}

function buildWeeklyTelegram(result) {
  const s = result.status_summary || {};
  let msg = `\ud83d\udcca <b>Weekly Report</b> (${today()})\n`;
  msg += `Total ideas: ${s.total || '?'}`;
  if (MULTI_PROJECT && s.by_project) {
    const parts = PROJECTS.filter(p => s.by_project[p]).map(p => `[${p}] ${s.by_project[p]}`);
    if (parts.length) msg += ` | ${parts.join(' ')}`;
  }
  msg += `\n\n`;

  if (MULTI_PROJECT) {
    const projects = result.projects || {};
    for (const p of PROJECTS) {
      const data = projects[p];
      if (!data) continue;
      msg += renderWeeklyProjectSectionTg(data, p);
    }
  } else {
    msg += renderWeeklyProjectSectionTg({
      pipeline_health: result.pipeline_health,
      completed_this_week: result.completed_this_week,
      next_week_focus: result.next_week_focus,
      stale_ideas: result.stale_ideas,
      duplicates_found: result.duplicates_found,
    }, PROJECT_NAME);
    if (result.pipeline_health_notes) {
      const first = result.pipeline_health_notes.split('. ')[0];
      const note = first.endsWith('.') ? first : first + '.';
      msg += `<i>${note}</i>`;
    }
  }

  return msg;
}

// ---- MAIN ----

async function main() {
  if (!NICODAIMUS_API_KEY) { console.error('ERROR: NICODAIMUS_API_KEY not set in .env'); process.exit(1); }
  if (!TELEGRAM_BOT_TOKEN) { console.error('ERROR: TELEGRAM_BOT_TOKEN not set in .env'); process.exit(1); }
  if (!TELEGRAM_CHAT_ID) { console.error('ERROR: TELEGRAM_CHAT_ID not set in .env'); process.exit(1); }

  try {
    if (MODE === 'weekly') await weeklyReport();
    else await dailyReview();
  } catch (err) {
    log(`ERROR: ${err.message}`);
    try {
      await sendTelegram(`\u26a0\ufe0f <b>Ideas Review Error</b> (${MODE})\n\n<code>${err.message}</code>`);
    } catch (e2) {
      log(`Could not send error notification: ${e2.message}`);
    }
    process.exit(1);
  }
}

main();
