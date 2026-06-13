# Telemachus Swarm Dashboard

A live web dashboard for [Telemachus](https://github.com/Everaldtah/telemachus) agent **swarms** — it renders one terminal screen per subagent, showing each subagent's role and a live stream of the CLI commands and tool calls it runs. Responsive from 1 up to 20 subagent panels.

## How it works

```
Telemachus bot (in a Daytona sandbox)
  └─ runs a swarm, appends events to ~/swarm/<session>.jsonl
        ▲ read server-side (Daytona toolbox API)
        │
Vercel  ├─ /api/state   serverless function — returns new events since a cursor
        └─ /            static dashboard — polls /api/state, renders a terminal grid
```

The browser only ever talks to this site (same-origin); the serverless function reads the
session log from the sandbox using a server-side `DAYTONA_API_KEY`. No data is stored here.

Open `/?s=<session>` — Telemachus DMs you that link when you start a swarm with
`/swarm <task>` (or "use agent swarm …").

## Environment variables (set in Vercel project settings)

| Var | Description |
|-----|-------------|
| `DAYTONA_API_KEY` | Daytona API key for the account running the Telemachus host sandbox. |
| `DAYTONA_API_URL` | Daytona API base (default `https://app.daytona.io/api`). |

## Deploy

```
npx vercel deploy --prod
```

No build step, no dependencies — a static page plus one Node serverless function.
