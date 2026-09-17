# Triage router

A Pollinations **code agent** that picks a model per request and answers as that model.
It routes on three signals, all read live at request time:

| Signal | Source | Used for |
| --- | --- | --- |
| Task tier | the request itself (length, code, tools, images, reasoning words) | picking which pool to draw from |
| Model health | `GET /models/status?minutes=30` (rollup rows) | moving traffic off a model that is degrading |
| Price | `GET /v1/models` (`promptTextTokens` + `completionTextTokens`) | picking the cheapest model that clears the tier |
| API shape | the request (Responses vs Chat Completions) | skipping models that cannot serve that endpoint |

Callable model: **`xiaotian1171/triage-router`**

## How a request is routed

1. **Classify the tier.**
   - `deep` — long input (>2400 chars), or a reasoning-shaped ask with code/tools: *"review this and refactor it, compare the trade-offs"*.
   - `balanced` — images (needs a vision-capable model), tool lists, or ordinary medium requests.
   - `fast` — short plain requests (under 320 chars, no code, no tools, no images).
2. **Score every pool member.** `score = price × penalty`, where `penalty` turns the last
   30 minutes of health into a multiplier on the advertised price:

   ```
   penalty = (1 + 6·5xxRate) · (1 + 3·rescueRate) · latencyFactor · slowTail · throughput
   ```

   `latencyFactor` follows p95 above 45s, `slowTail` reacts when fewer than half of
   requests returned 2xx, `throughput` reacts below 10 tok/s. Models with fewer than
   5 requests in the window are treated as unproven (penalty 1, noted as `no recent traffic`).
   A model with `penalty ≥ 6` is marked **degraded** and only used if its whole pool is degraded.
3. **Pick.** `deep` takes the strongest healthy model (price is the capability proxy);
   `fast` and `balanced` take the cheapest healthy model that fits. Pool members that are
   missing from the live catalog, cannot serve the endpoint the caller used, cannot take
   images for an image request, or have too small a context window are skipped and named in
   the reason. `amazon/nova-micro-v1` is a worked example of the endpoint gate: it is the
   cheapest model in the fast pool but is only listed under `/v1/chat/completions`, so
   Responses calls go to `openai/gpt-oss-20b` and Chat Completions calls get nova-micro.
4. **Escalate.** A 429 or 5xx from the chosen model re-runs the pick one tier up
   (`fast → balanced → deep`) and reports the escalation.

## Reading the decision

Every answer carries headers, so one call shows both the answer and the reasoning:

| Header | Meaning |
| --- | --- |
| `x-router-model` | model that produced the answer |
| `x-router-tier` | `fast` / `balanced` / `deep` |
| `x-router-why` | one-sentence reason, including skipped candidates |
| `x-router-pool` | every candidate with its score in 1e-9 pollen/token and its health note |
| `x-router-degraded` | candidates excluded for poor health |
| `x-router-escalated-to` | set when a failed tier was escalated |

```bash
curl -sD - -o /dev/null https://gen.pollinations.ai/v1/responses \
  -H "Authorization: Bearer $POLLINATIONS_KEY" -H "content-type: application/json" \
  -d '{"model":"xiaotian1171/triage-router","input":"Name three colours, one word each."}'
# x-router-tier: fast
# x-router-model: openai/gpt-oss-20b
# x-router-why: cheapest healthy model at fast tier; 100% ok, p95 27s, 62 tok/s; ~7 input tokens; skipped amazon/nova-micro-v1 (no /v1/responses)
```

A JSON answer also carries the same trace in its body, so a caller that never sees
response headers can still check the routing:

```json
{
  "model": "openai/gpt-oss-20b",
  "output": [ "..." ],
  "router": {
    "model": "openai/gpt-oss-20b",
    "tier": "fast",
    "why": "cheapest healthy model at fast tier; 100% ok, p95 27s, 62 tok/s; ~7 input tokens; skipped amazon/nova-micro-v1 (no /v1/responses)",
    "pool": "(every candidate with its score and health note)"
  }
}
```

Streamed answers are passed through untouched and only get headers. The agent also logs
the decision as one JSON line, so the choice stays on record when a gateway caches the
answer and drops per-response headers.

## Design choice: curated pools, live decisions

`POOLS` holds a handful of hand-exercised models per tier. Everything *within* a pool is
decided live — price, health, vision support, context, degradation — but caller traffic is
never sent to an untested long-tail model. Pools are the part a human vouches for; the
routing decision is the part the agent makes. Swapping a pool entry is a one-line change.

## Deploy

1. Fork this repository.
2. In [My Models](https://enter.pollinations.ai/my-models), choose **Add Agent → Code agent** and enter your fork's URL.
3. Edit `agent.ts`, push, then use **Sync** in the dashboard (or the workflow below).

`npx @pollinations/cli agents sync <agent-id>` deploys the newest default-branch revision.

For automatic sync after a push, enable GitHub Actions and set the repository **variable**
`POLLINATIONS_SYNC_URL` to `https://gen.pollinations.ai/account/agents/YOUR_AGENT_ID/sync`.

## Test

```bash
node --test agent.test.ts
```

The tests drive the agent with a fake `pollinations` helper: eight cases cover tier selection,
endpoint-aware selection, vision filtering, degradation avoidance, escalation and
request pass-through.

[Agent guide](https://github.com/pollinations/pollinations/blob/main/BUILD_YOUR_OWN_AGENT.md) · [More examples](https://github.com/orgs/pollinations/repositories?q=topic%3Apollinations-code-agent-example)
