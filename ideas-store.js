const http = require('http');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
const PORT = parseInt(process.env.PORT || '9321', 10);
const OFFSET_FILE = path.join(DATA_DIR, 'telegram_offset.txt');
const IDEAS_FILE = path.join(DATA_DIR, 'ideas.json');

// Optional multi-project mode. Set PROJECTS=web,mobile,ops in .env to enable.
// When unset, batty runs in single-project mode (no project field, no filtering, no tags).
const PROJECTS = (process.env.PROJECTS || '').split(',').map(s => s.trim()).filter(Boolean);
const MULTI_PROJECT = PROJECTS.length > 0;
const DEFAULT_PROJECT = PROJECTS[0] || null;

// Resolve a project name. If `useDefault` is true and input is empty, returns DEFAULT_PROJECT.
// If input is a non-empty invalid value, returns null regardless of useDefault.
function normalizeProject(p, useDefault = false) {
  if (!MULTI_PROJECT) return undefined;
  if (!p) return useDefault ? DEFAULT_PROJECT : null;
  const lc = String(p).toLowerCase();
  return PROJECTS.find(pp => pp.toLowerCase() === lc) || null;
}
function projectTag(p) { return MULTI_PROJECT ? '[' + (p || DEFAULT_PROJECT) + '] ' : ''; }
function filterByProject(ideas, project) {
  if (!project) return ideas;
  return ideas.filter(i => (i.project || DEFAULT_PROJECT) === project);
}

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(OFFSET_FILE)) fs.writeFileSync(OFFSET_FILE, '0');
if (!fs.existsSync(IDEAS_FILE)) fs.writeFileSync(IDEAS_FILE, '[]');

function readIdeas() { return JSON.parse(fs.readFileSync(IDEAS_FILE, 'utf8')); }
function writeIdeas(ideas) { fs.writeFileSync(IDEAS_FILE, JSON.stringify(ideas, null, 2)); }
function readBody(req) {
  return new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
}
function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// One-shot backfill when multi-project is enabled on an existing install.
// Any idea without a valid project gets DEFAULT_PROJECT. Idempotent.
if (MULTI_PROJECT) {
  const ideas = readIdeas();
  let changed = 0;
  for (const i of ideas) {
    if (!i.project || !PROJECTS.includes(i.project)) {
      i.project = DEFAULT_PROJECT;
      changed++;
    }
  }
  if (changed > 0) {
    writeIdeas(ideas);
    console.log('Backfilled project=' + DEFAULT_PROJECT + ' on ' + changed + ' idea(s)');
  }
}

const ARCHIVED_STATUSES = ['done', 'rejected'];
function isActive(idea) { return !ARCHIVED_STATUSES.includes(idea.status); }
function isArchived(idea) { return ARCHIVED_STATUSES.includes(idea.status); }

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const url = new URL(req.url, 'http://localhost');
  // Project filter semantics:
  //  - no ?project= param -> no filter (show all)
  //  - ?project=valid-name -> filter to that project
  //  - ?project=invalid-name -> filter to an impossible value, returning empty results
  const rawProjectParam = MULTI_PROJECT ? url.searchParams.get('project') : null;
  const projectParam = rawProjectParam ? (normalizeProject(rawProjectParam, false) || rawProjectParam) : null;

  if (url.pathname === '/offset' && req.method === 'GET') {
    res.end(JSON.stringify({ offset: fs.readFileSync(OFFSET_FILE, 'utf8').trim() }));
  }
  else if (url.pathname === '/offset' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    fs.writeFileSync(OFFSET_FILE, body.offset);
    res.end(JSON.stringify({ ok: true }));
  }
  else if (url.pathname === '/ideas' && req.method === 'GET') {
    res.end(JSON.stringify(filterByProject(readIdeas(), projectParam)));
  }
  else if (url.pathname === '/ideas' && req.method === 'POST') {
    const newIdeas = JSON.parse(await readBody(req));
    const existing = readIdeas();
    const nextId = existing.length > 0 ? Math.max(...existing.map(i => i.id || 0)) + 1 : 1;
    const withIds = newIdeas.map((idea, idx) => {
      const base = { id: nextId + idx, ...idea };
      if (MULTI_PROJECT) base.project = normalizeProject(idea.project, true) || DEFAULT_PROJECT;
      return base;
    });
    existing.push(...withIds);
    writeIdeas(existing);
    const chat_id = withIds[0]?.chat_id;
    const titles = withIds.map(i => {
      const pri = i.priority || '?';
      return projectTag(i.project) + '<b>' + esc(i.title) + '</b> [' + pri + ']\n<i>' + esc(i.description) + '</i>';
    });
    res.end(JSON.stringify({ ok: true, saved_count: withIds.length, chat_id, titles }));
  }
  else if (url.pathname === '/ideas' && req.method === 'DELETE') {
    writeIdeas([]);
    res.end(JSON.stringify({ ok: true }));
  }
  else if (url.pathname.match(/^\/ideas\/\d+$/) && req.method === 'DELETE') {
    const id = parseInt(url.pathname.split('/')[2]);
    const ideas = readIdeas();
    const idx = ideas.findIndex(i => i.id === id);
    if (idx === -1) { res.statusCode = 404; res.end(JSON.stringify({ ok: false, error: 'Idea #' + id + ' not found' })); }
    else { const removed = ideas.splice(idx, 1)[0]; writeIdeas(ideas); res.end(JSON.stringify({ ok: true, deleted: removed.title })); }
  }
  else if (url.pathname.match(/^\/ideas\/\d+$/) && req.method === 'PATCH') {
    const id = parseInt(url.pathname.split('/')[2]);
    const updates = JSON.parse(await readBody(req));
    if (MULTI_PROJECT && 'project' in updates) {
      const p = normalizeProject(updates.project);
      if (!p) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'Invalid project (expected one of: ' + PROJECTS.join(', ') + ')' })); return; }
      updates.project = p;
    }
    const ideas = readIdeas();
    const idea = ideas.find(i => i.id === id);
    if (!idea) { res.statusCode = 404; res.end(JSON.stringify({ ok: false, error: 'Idea #' + id + ' not found' })); }
    else { Object.assign(idea, updates); writeIdeas(ideas); res.end(JSON.stringify({ ok: true, updated: idea })); }
  }
  else if (url.pathname === '/ideas/list' && req.method === 'GET') {
    const allActive = filterByProject(readIdeas().filter(isActive), projectParam);
    const projectLabel = projectParam ? ' (' + projectParam + ')' : '';
    if (allActive.length === 0) {
      const empty = projectParam
        ? 'No active ideas for ' + projectParam + '.'
        : 'No active ideas. Send a voice or text message to capture one!';
      res.end(JSON.stringify({ text: empty })); return;
    }
    const showAll = url.searchParams.get('all') === 'true';
    const limit = 10;
    const ideas = showAll ? allActive : allActive.slice(0, limit);
    const lines = ideas.map(i => {
      const pri = i.priority ? i.priority.split('-')[0] : '?';
      return '\u25cb ' + projectTag(i.project) + '<b>#' + i.id + '</b> [' + pri + '] ' + esc(i.title);
    });
    let text = lines.join('\n');
    if (!showAll && allActive.length > limit) {
      text += '\n\n<i>Showing ' + limit + ' of ' + allActive.length + ' active ideas' + projectLabel + '. Use /list all to see all.</i>';
    } else {
      text += '\n\n<i>' + allActive.length + ' active idea' + (allActive.length !== 1 ? 's' : '') + projectLabel + '</i>';
    }
    res.end(JSON.stringify({ text }));
  }
  else if (url.pathname === '/ideas/archive' && req.method === 'GET') {
    const allArchived = filterByProject(readIdeas().filter(isArchived), projectParam);
    const projectLabel = projectParam ? ' (' + projectParam + ')' : '';
    if (allArchived.length === 0) { res.end(JSON.stringify({ text: 'No archived ideas' + projectLabel + '.' })); return; }
    const showAll = url.searchParams.get('all') === 'true';
    const page = parseInt(url.searchParams.get('page') || '1');
    const perPage = 10;
    const lines = (showAll ? allArchived : allArchived.slice((page - 1) * perPage, page * perPage)).map(i => {
      const st = i.status === 'done' ? '\u2705' : '\u274c';
      return st + ' ' + projectTag(i.project) + '<b>#' + i.id + '</b> ' + esc(i.title);
    });
    let text = '\ud83d\udce6 <b>Archived Ideas</b>' + projectLabel + '\n\n' + lines.join('\n');
    if (showAll) {
      text += '\n\n<i>' + allArchived.length + ' archived idea' + (allArchived.length !== 1 ? 's' : '') + '</i>';
    } else {
      const totalPages = Math.ceil(allArchived.length / perPage);
      if (allArchived.length > perPage) {
        text += '\n\n<i>Page ' + page + '/' + totalPages + ' (' + allArchived.length + ' archived). Use /archive all to see all.</i>';
      } else {
        text += '\n\n<i>' + allArchived.length + ' archived idea' + (allArchived.length !== 1 ? 's' : '') + '</i>';
      }
    }
    res.end(JSON.stringify({ text }));
  }
  else if (url.pathname === '/ideas/status' && req.method === 'GET') {
    const allIdeas = readIdeas();
    const activeAll = allIdeas.filter(isActive);
    const scoped = projectParam ? filterByProject(activeAll, projectParam) : activeAll;
    const projectLabel = projectParam ? ' (' + projectParam + ')' : '';

    const byCategory = {}, byPriority = {}, byStatus = {}, byProject = {};
    scoped.forEach(i => {
      byCategory[i.category] = (byCategory[i.category] || 0) + 1;
      const pri = i.priority ? i.priority.split('-')[0] : 'unset';
      byPriority[pri] = (byPriority[pri] || 0) + 1;
      byStatus[i.status || 'new'] = (byStatus[i.status || 'new'] || 0) + 1;
      if (MULTI_PROJECT) {
        const proj = i.project || DEFAULT_PROJECT;
        byProject[proj] = (byProject[proj] || 0) + 1;
      }
    });
    const archivedCount = projectParam
      ? filterByProject(allIdeas.filter(isArchived), projectParam).length
      : allIdeas.filter(isArchived).length;

    let t = '\ud83d\udcca <b>Ideas Dashboard</b>' + projectLabel + '\n\nActive: ' + scoped.length + ' | Archived: ' + archivedCount + '\n\n';
    if (MULTI_PROJECT && !projectParam) {
      t += '<b>Project:</b>\n';
      PROJECTS.forEach(p => { if (byProject[p]) t += '  [' + p + ']: ' + byProject[p] + '\n'; });
      t += '\n';
    }
    t += '<b>Priority:</b>\n';
    ['P0','P1','P2','P3'].forEach(p => { if (byPriority[p]) t += '  ' + p + ': ' + byPriority[p] + '\n'; });
    t += '\n<b>Category:</b>\n';
    Object.entries(byCategory).sort((a,b) => b[1]-a[1]).forEach(([k,v]) => { t += '  ' + k + ': ' + v + '\n'; });
    t += '\n<b>Status:</b>\n';
    Object.entries(byStatus).forEach(([k,v]) => { t += '  ' + k + ': ' + v + '\n'; });
    res.end(JSON.stringify({ text: t }));
  }
  else { res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' })); }
});

server.listen(PORT, '0.0.0.0', () => {
  const mode = MULTI_PROJECT ? 'multi-project [' + PROJECTS.join(', ') + ']' : 'single-project';
  console.log('Ideas store listening on :' + PORT + ' (' + mode + ')');
});
