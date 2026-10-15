---
name: monitor
description: Monitor GKE logs (via `gcloud logging`) for Scalekit's Full Stack Auth (FSA) and SSO login flows — session creation, SAML/OIDC authorize+callback, token exchange — after a recent `scalekit` PR release. Invoked as `/monitor [feature] [--env staging|production] [--since <duration>] [--tail]`. Defaults to production (pass `--env staging` to target staging instead). With no feature, watches the full login/token-exchange surface; naming a feature (sso, fsa, saml, oidc, m2m, passwordless, scim, token) scopes the log filter to just that flow.
---

# /monitor

```
/monitor [feature] [--env staging|production] [--since <duration>] [--tail]
```

Default `feature`: none → full monitor across all FSA + SSO + token-exchange flows.
Default `--env`: **`production`** (`sk-production-3bc1`) — that's where real login/token
regressions from a release actually show up. Only use staging (`sk-staging-dedc`) when the
developer says so (`--env staging` or mentions "staging"). Every call here is read-only
(`gcloud logging read|tail`), so no extra confirmation gate is needed before querying
production — just always pass `--project` explicitly rather than relying on the local
`gcloud` default.
Default `--since`: the merge time of the most recent `scalekit` PR touching the resolved
feature's code paths (found in step 2), falling back to `1h` if no such PR merged in the
last 7 days.
`--tail` switches step 4 from a one-shot `gcloud logging read` to a live
`gcloud logging tail` stream (Ctrl-C to stop).

This skill is **read-only**: it only issues `gcloud logging read|tail`, `gh pr list|view`,
and `git log`. It never writes to or mutates GCP, GitHub, or the cluster.

## Ground rules

- **Never print raw `token`, `id_token`, `access_token`, `refresh_token`, `password`, or
  OTP/magic-link values** from log payloads. These are auth logs and routinely carry
  sensitive material. Surface only IDs (`session_id`, `auth_request_id`, `connection_id`,
  `organization_id`, `environment_id` — note the backend is inconsistent between
  `environment_id` and `environmentId`, check both), HTTP status, error codes/messages, and
  counts.
- If `gcloud` isn't authenticated or lacks access to the target project, say so and stop.
  Don't run `gcloud auth login` on the developer's behalf without asking first.
- Production is the default target, not an opt-in — don't pause to ask permission before
  reading production logs. Just announce which project you're querying in the report.
- This skill reports; it doesn't act. It never opens a PR, rolls back a deploy, restarts a
  pod, or pages anyone — hand the verdict to the developer.

## 0. Locate the backend repo

Resolve the `scalekit` Go backend checkout relative to wherever this skill is invoked from:
try `../scalekit`, then `./scalekit`, then walk upward for a directory named `scalekit`
containing `go.mod` and `internal/oidc/`. Stop and ask if none is found — step 1 and 2 read
from it.

## 1. Resolve scope — feature → code paths → log keywords

| feature arg | code paths (in `scalekit/`) | log keyword hints |
|---|---|---|
| `sso` / `saml` / `oidc` | `internal/sp/sso.go`, `internal/sp/sso_session.go`, `internal/sp/step_organization_sso.go`, `internal/sp/redirect_handler.go`, `internal/sp/oidc_rp_client.go`, `internal/sp/oauth/*.go`, `internal/sp/post_auth.go`, `internal/sp/directory_auth.go` | `sso`, `saml`, `oidc`, `/sso/`, `/oauth/authorize` |
| `fsa` | `internal/oidc/op.go`, `internal/oidc/op_handler_service.go`, `internal/oidc/oauth_authorize_interceptor.go`, `internal/oidc/storage.go`, `internal/session/session.go`, `servers/session_server.go` | `/oauth/authorize`, `/oauth/token`, `session_id`, `hosted login` |
| `token` / `token-exchange` | `internal/token/token.go`, `internal/token/claims.go`, `internal/oidc/storage.go` (token endpoint path), `servers/tokencleanup_server.go` | `/oauth/token`, `token_exchange`, `grant_type` |
| `m2m` | `internal/oidc` client_credentials grant paths | `client_credentials`, `m2m` |
| `passwordless` | passwordless paths under `internal/sp`; see `developer-docs/src/content/docs/fsa/guides/passwordless.mdx` for expected behavior | `passwordless`, `otp`, `magic_link` |
| `scim` / `directory` | directory/SCIM service dirs | `scim`, `directory` |
| (none given) | union of all rows above | union of all rows above |

Treat this table as a starting point, not exhaustive: `rg -il <feature>` under
`scalekit/internal/` first and fold in anything new before building the filter in step 3.

## 2. Find the recent release(s) to anchor "since"

```
gh pr list --repo scalekit-inc/scalekit --state merged --limit 30 \
  --json number,title,mergedAt,files,url
```

Keep only PRs whose `files[].path` intersects the resolved code paths from step 1. Use the
earliest matching `mergedAt` within the lookback window (default last 7 days) as the
`--since` anchor, unless the developer passed `--since` explicitly. Report the matched
PR(s) — number, title, url, mergedAt — before moving on; this is the "recently released
PR" the monitor is watching for regressions from.

If no matching merged PR exists in the window, say so plainly and fall back to the
developer-supplied or default `--since` instead of guessing one.

## 3. Build the gcloud logging filter

Base filter — the backend runs on GKE (Argo Rollout `authentication`), **not** Cloud Run:

```
resource.type="k8s_container"
resource.labels.namespace_name="scalekit"
resource.labels.pod_name=~"authentication-.*"
```

For scoped mode, AND in an OR'd keyword group built from step 1's hints, checked against
both payload shapes (zerolog output lands in one or the other depending on sidecar config):

```
(textPayload=~"(?i)(saml|oidc|/sso/)" OR jsonPayload.message=~"(?i)(saml|oidc|/sso/)")
```

Project: `sk-production-3bc1` (production, default) or `sk-staging-dedc` (only when
`--env staging` was given). Region (`us-west2` everywhere, plus `europe-west3` for
production) is not a log-filter dimension — pods in both regions log to the same project.

## 4. Fetch

One-shot:

```
gcloud logging read '<filter from step 3>' \
  --project=<project> --freshness=<since> \
  --format=json --order=asc
```

Live, when `--tail` was passed:

```
gcloud logging tail '<filter from step 3>' --project=<project>
```

## 5. Analyze and report

From the fetched entries, group by `severity` and extract — without ever printing token
values:

- counts by severity (ERROR/WARNING/INFO), split before vs. after the anchor PR's
  `mergedAt`
- distinct HTTP status codes seen on auth endpoints (401/403/500 especially)
- a handful of representative `auth_request_id`/`session_id` values for ERROR entries, so
  the developer can pull the full trace themselves if needed
- whether the error rate changed materially after the deploy anchor (a rough before/after
  count comparison is enough — this is a monitor, not a full incident-response tool)

Report as:

```
Scope: <feature or "full">            Env: <staging|production>
Anchor PR: #<n> "<title>" merged <timestamp>   <url>
Window: <since> → now

Severity    Before   After
ERROR       <n>      <n>
WARNING     <n>      <n>

Notable errors (after anchor):
  <timestamp>  <status>  auth_request_id=<id>  <short message, no secrets>
  ...

Verdict: <healthy | regressions detected | inconclusive — too few log entries>
```

Stop there once reported.
