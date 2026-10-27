# Project guidance

- Keep the runtime general-purpose and latency-first. Simple requests should not acquire a mandatory planning round trip.
- Use Node 24+ and the official @google/genai SDK. Keep hidden model retries disabled; the runtime owns call accounting.
- Persist task transitions, resulting jobs, artifacts, and events atomically. Preserve the revision fence on result acceptance.
- No implicit desktop observation. External event subscriptions and tool permissions are explicit.
- Never auto-retry uncertain writes. Checkpoint sibling jobs when pausing. Resource names must be canonical.
- Changes to lifecycle, scheduling, recovery, and side-effect behavior should have behavioral tests. Run npm run check.
- Offline demos and fake providers must label outputs clearly. Do not report mocked model tests as live inference verification.
- Keep docs aligned with actual guarantees. This is one scheduler per local SQLite database, not distributed exactly-once execution.
