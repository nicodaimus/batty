const http = require('http');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
const PORT = parseInt(process.env.PORT || '9321', 10);
const OFFSET_FILE = path.join(DATA_DIR, 'telegram_offset.txt');
const IDEAS_FILE = path.join(DATA_DIR, 'ideas.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(OFFSET_FILE)) fs.writeFileSync(OFFSET_FILE, '0');
if (!fs.existsSync(IDEAS_FILE)) fs.writeFileSync(IDEAS_FILE, '[]');

function readIdeas() { return JSON.parse(fs.readFileSync(IDEAS_FILE, 'utf8')); }
function writeIdeas(ideas) { fs.writeFileSync(IDEAS_FILE, JSON.stringify(ideas, null, 2)); }
function readBody(req) {
  return new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
}
function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

const ARCHIVED_STATUSES = ['done', 'rejected'];
function isActive(idea) { return !ARCHIVED_STATUSES.includes(idea.status); }
function isArchived(idea) { return ARCHIVED_STATUSES.includes(idea.status); }

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/offset' && req.method === 'GET') {
    res.end(JSON.stringify({ offset: fs.readFileSync(OFFSET_FILE, 'utf8').trim() }));
  }
  else if (url.pathname === '/offset' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    fs.writeFileSync(OFFSET_FILE, body.offset);
    res.end(JSON.stringify({ ok: true }));
  }
  else if (url.pathname === '/ideas' && req.method === 'GET') {
    res.end(JSON.stringify(readIdeas()));
  }
  else if (url.pathname === '/ideas' && req.method === 'POST') {
    const newIdeas = JSON.parse(await readBody(req));
    const existing = readIdeas();
    const nextId = existing.length > 0 ? Math.max(...existing.map(i => i.id || 0)) + 1 : 1;
    const withIds = newIdeas.map((idea, idx) => ({ id: nextId + idx, ...idea }));
    existing.push(...withIds);
    writeIdeas(existing);
    const chat_id = withIds[0]?.chat_id;
    const titles = withIds.map(i => {
      const pri = i.priority || '?';
      return '<b>' + esc(i.title) + '</b> [' + pri + ']\n<i>' + esc(i.description) + '</i>';
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
    const ideas = readIdeas();
    const idea = ideas.find(i => i.id === id);
    if (!idea) { res.statusCode = 404; res.end(JSON.stringify({ ok: false, error: 'Idea #' + id + ' not found' })); }
    else { Object.assign(idea, updates); writeIdeas(ideas); res.end(JSON.stringify({ ok: true, updated: idea })); }
  }
  else if (url.pathname === '/ideas/list' && req.method === 'GET') {
    const allActive = readIdeas().filter(isActive);
    if (allActive.length === 0) { res.end(JSON.stringify({ text: 'No active ideas. Send a voice or text message to capture one!' })); return; }
    const showAll = url.searchParams.get('all') === 'true';
    const limit = 10;
    const ideas = showAll ? allActive : allActive.slice(0, limit);
    const lines = ideas.map(i => {
      const pri = i.priority ? i.priority.split('-')[0] : '?';
      return '\u25cb <b>#' + i.id + '</b> [' + pri + '] ' + esc(i.title);
    });
    let text = lines.join('\n');
    if (!showAll && allActive.length > limit) {
      text += '\n\n<i>Showing ' + limit + ' of ' + allActive.length + ' active ideas. Use /list all to see all.</i>';
    } else {
      text += '\n\n<i>' + allActive.length + ' active idea' + (allActive.length !== 1 ? 's' : '') + '</i>';
    }
    res.end(JSON.stringify({ text }));
  }
  else if (url.pathname === '/ideas/archive' && req.method === 'GET') {
    const allArchived = readIdeas().filter(isArchived);
    if (allArchived.length === 0) { res.end(JSON.stringify({ text: 'No archived ideas yet.' })); return; }
    const showAll = url.searchParams.get('all') === 'true';
    const page = parseInt(url.searchParams.get('page') || '1');
    const perPage = 10;
    const lines = (showAll ? allArchived : allArchived.slice((page - 1) * perPage, page * perPage)).map(i => {
      const st = i.status === 'done' ? '\u2705' : '\u274c';
      return st + ' <b>#' + i.id + '</b> ' + esc(i.title);
    });
    let text = '\ud83d\udce6 <b>Archived Ideas</b>\n\n' + lines.join('\n');
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
    const ideas = readIdeas().filter(isActive);
    const byCategory = {}, byPriority = {}, byStatus = {};
    ideas.forEach(i => {
      byCategory[i.category] = (byCategory[i.category] || 0) + 1;
      const pri = i.priority ? i.priority.split('-')[0] : 'unset';
      byPriority[pri] = (byPriority[pri] || 0) + 1;
      byStatus[i.status || 'new'] = (byStatus[i.status || 'new'] || 0) + 1;
    });
    const allIdeas = readIdeas();
    const archivedCount = allIdeas.filter(isArchived).length;
    let t = '\ud83d\udcca <b>Ideas Dashboard</b>\n\nActive: ' + ideas.length + ' | Archived: ' + archivedCount + '\n\n';
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

server.listen(PORT, '0.0.0.0', () => console.log('Ideas store listening on :' + PORT));
