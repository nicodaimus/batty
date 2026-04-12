# batty

> "All those ideas will be lost in time, like tears in rain."

**batty** is a self-hosted AI idea capture pipeline. Send voice or text messages to a Telegram bot, get structured and prioritised ideas back, and wake up to a daily AI-generated digest that tells you what actually matters.

Built with [n8n](https://n8n.io), [Node.js](https://nodejs.org), and the [nicodAImus API](https://nicodaimus.com).

Full setup guide: **[nicodaimus.com/blog/you-are-the-goldmine-build-your-ai-idea-pipeline](https://nicodaimus.com/blog/you-are-the-goldmine-build-your-ai-idea-pipeline)**

---

## Quick start

```bash
git clone https://github.com/nicodaimus/batty.git
cd batty
cp .env.example .env
chmod 600 .env
# Edit .env and fill in your tokens
docker compose up -d
```

Then import `ideas-pipeline.json` into n8n at `http://your-server:5678`.

---

## What's in this repo

| File | Purpose |
|------|---------|
| `ideas-store.js` | Lightweight Node.js server - stores ideas as JSON, handles bot commands |
| `ideas-review.mjs` | Daily + weekly AI review script - sends digest to Telegram |
| `ideas-pipeline.json` | n8n workflow template - import this into n8n |
| `docker-compose.yml` | Full stack (ideas-store + n8n, optional Whisper) |
| `.env.example` | Configuration template |

---

## Requirements

- Docker with Compose plugin
- A [Telegram account](https://telegram.org) and bot token (from [@BotFather](https://t.me/BotFather))
- A [nicodAImus account](https://nicodaimus.com/account/create/) on the alfred plan or higher

---

## Multi-project mode (optional)

By default batty captures everything into a single pipeline. If you track more than one project
and want a single bot to route ideas into each one, set `PROJECTS` in `.env` to a comma-separated
list:

```bash
PROJECTS=web,mobile,ops
PROJECT_web_TODO=./web/TODO.md
PROJECT_mobile_TODO=./mobile/TODO.md
PROJECT_ops_TODO=./ops/TODO.md
```

Then restart the stack:

```bash
docker compose restart ideas-store n8n
```

When enabled:

- **Routing:** the AI detects each idea's project from a `[prefix]` at the start of the message
  or from a project name mention anywhere in the text. Ambiguous messages default to the first
  project in your list. A single message can mix projects - each idea is classified independently.
- **Tagged output:** bot replies prefix every idea with its project: `[web] #12 Add dark mode`.
- **Filters:** `/list mobile`, `/status ops`, `/archive web` scope any browse command to one project.
  `/list` with no arg shows all projects side-by-side.
- **Grouped reports:** the daily and weekly digests include a section per project so each one gets
  its own ROI scores, next-week focus, and stale-idea flags.
- **Backfill:** if you enable multi-project on an existing install, batty auto-assigns every
  pre-existing idea to the first project in your list the next time the ideas-store starts.

Leaving `PROJECTS` unset keeps batty in the classic single-project mode - no breaking changes.

---

## Voice transcription (optional)

Uncomment the `whisper-asr` service in `docker-compose.yml`, then restart:

```bash
docker compose up -d whisper-asr
```

Requires ~1.5 GB of free RAM for the `small` model. See the full guide for details.

---

## License

MIT
