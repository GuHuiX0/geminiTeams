# HTTP API

The default address is `http://127.0.0.1:7331`. JSON requests and responses use camelCase. `POST /tasks` returns `202` immediately; work continues in the runtime. Errors are `{ "error": "message" }`: invalid requests use 400, missing entities 404, conflicting lifecycle operations 409, and missing configured bearer credentials 401.

Set `LIVING_TOKEN` to require `Authorization: Bearer …`. A token is required when binding to a non-loopback host. The service is a single-user API; it has no accounts, tenancy, TLS termination, or browser UI. Browser `Origin` requests are rejected. Use a trusted reverse proxy if deploying beyond the local machine.

| Method | Route | Body / behavior |
| --- | --- | --- |
| GET | `/health` | Runtime status and limits |
| GET | `/tasks` | Task snapshots |
| POST | `/tasks` | Create a task (example below) |
| GET | `/tasks/:id` | Task, artifacts, jobs, and memory |
| POST | `/tasks/:id/pause` | `{}` |
| POST | `/tasks/:id/resume` | `{ "extraCalls": 10 }` (optional) |
| POST | `/tasks/:id/steer` | `{ "intent": "complete revised intent" }` |
| POST | `/tasks/:id/cancel` | `{}` |
| POST | `/tasks/:id/memory` | `{ "key": "constraint", "value": "text", "source": "user" }` |
| POST | `/tasks/:id/subscriptions` | `{ "source": "files", "subject": "project/*", "type": "changed" }` |
| DELETE | `/subscriptions/:id` | Remove a subscription |
| POST | `/tasks/:id/timers` | `{ "dueAt": 1793116800000, "intervalMs": 3600000 }` (interval optional) |
| DELETE | `/timers/:id` | Remove a timer |
| POST | `/ingest` | Inbound event (example below) |
| POST | `/jobs/:id/reconcile` | `{ "result": "externally observed outcome" }` |
| GET | `/events?taskId=…&after=…` | SSE, all tasks if taskId omitted |

## Create a task

```json
{
  "intent": "Compare possible architectures for a personal research runtime",
  "policy": "deep",
  "priority": 5,
  "maxCalls": 30,
  "maxParallel": 3,
  "maxDurationMs": 1800000,
  "allowedTools": []
}
```

Only `intent` is required. Policy defaults to `focused`. Priority ranges from 1–10; maxParallel from 1–32 and is also capped by server configuration. MaxCalls ranges from 1–1000. Task deadlines range from 100 ms to one day for each active period.

## Ingest an event

```json
{
  "id": "external-unique-id",
  "source": "files",
  "subject": "project/notes.md",
  "type": "changed",
  "payload": { "revision": 3 },
  "originTaskId": "optional-task-that-produced-this-change",
  "causation": []
}
```

`id` is optional; omit it only if producer retries should count as distinct events. A response is `{ "accepted": true, "routed": 1 }`. A duplicate returns accepted=false. Unmatched or self-caused events can be accepted but routed=0. JSON request bodies and inbound event envelopes are limited to 64 KiB.

## Replay progress

```bash
curl -N 'http://127.0.0.1:7331/events?taskId=TASK_ID&after=0'
# Reconnect after the last processed sequence:
curl -N -H 'Last-Event-ID: 123' 'http://127.0.0.1:7331/events?taskId=TASK_ID'
```

Each event has an integer sequence cursor. The header takes precedence over the `after` query parameter. Replay returns events strictly after that cursor, then follows live events.

```text
id: 42
event: artifact.published
data: {"seq":42,"taskId":"…","kind":"artifact.published","data":{"artifact":{"id":"…","body":"…"},"attention":"passive"},"createdAt":1793116800000}
```

SSE sends heartbeats every 15 seconds. A slow client exceeding 1 MiB of pending response data is disconnected; reconnect with its last processed ID. Reconnect logic is the client's responsibility. The CLI prints the raw stream; it does not automatically reconnect. Event sequences are global, so gaps in a task-filtered stream are normal.
