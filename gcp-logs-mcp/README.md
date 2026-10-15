# gcp-logs-mcp

Read-only MCP server exposing one tool, `read_gcp_logs`, backed by `gcloud logging read`.

## Run
```
npm install
npm start            # prints a NEW api key every start
ngrok http 8765      # in another terminal; Ctrl-C it when done
claude mcp add --transport http gcp-logs https://<ngrok-host>/mcp \
  --header "Authorization: Bearer <key>"
```

## Safeguards
- API key is random per process start and rotates every 10 min (`KEY_TTL_MINUTES`); each new key is printed to the log and the old one is revoked immediately. Never persisted.
- Only `gcloud logging read` is ever executed (execFile, no shell; filter passed after `--`).
- Binds 127.0.0.1 only; ngrok is the only way in.
- Limit capped at 500 entries, 200KB output, 30s timeout, default window 1h.
- Optional `ALLOWED_PROJECTS=proj-a,proj-b` restricts the `project` parameter.

Requires `gcloud auth login` on the host; queries run with your credentials.
