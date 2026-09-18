# Agent operating contract

This CLI is a local single-player game controller. It works with any harness that can execute a command and read JSON. The planner does not need vision or computer-use tools once the game bridge is running.

1. Run `node bin/spire.mjs state`. Read the state, available options and routing reason.
2. In routine combat, run `node bin/spire.mjs battle 60`. It uses Jev, executes verified actions, and returns at a planner decision, an error, or the end of the fight.
3. On a planner decision, consider the deck, enemies, current HP, energy, intents, and long-term plan. Run `node bin/spire.mjs act STATE_ID OPTION_ID` using values from the exact returned state. Do not invent action IDs or reuse an old state after another action. The reply contains a new state and options.
4. Use the same `act` interface for card rewards, map choices and other advertised noncombat actions. Those are planner decisions. Claiming gold or an already-approved reward is a mechanical operation, but always read back indices.
5. Stop at the owner-defined trial boundary. Do not start or abandon a run, delete profiles, overwrite saves, enable cheats, change HP/energy, modify game rules, or publish anything.

## Responsibility split

| Route | Owner | Trigger |
|---|---|---|
| deterministic | program | no playable cards and no urgent potion decision |
| jev | Jev | ready combat, normal HP, recognized intents, no immediate lethal threat |
| planner | calling model | low confidence, low HP, lethal/unknown intent, potion timing, rewards, route, shop, event, card selection |
| wait/halt | program then human/planner | animation, API failure, unchanged/uncertain result, concurrent controller |

Confidence is a distribution statistic, not a calibrated probability of tactical correctness. The initial cutoff 0.5 and HP/potion thresholds are trial policy, not universal guarantees. Inspect transcripts before changing them. A high-confidence answer can still be bad strategy.

## Operational limits

- One executing agent at a time. CLI mutations use a per-user, per-loopback-port shared lock; humans and other apps must not manipulate the board concurrently.
- Each battle invocation stays in one room, executes at most 100 steps, and checks a 100,000-input-token budget between requests. The next individual request can exceed the remaining token budget; this is not a provider billing cap.
- No automatic retries for Jev or game mutations. A lost mutation response may mean an action happened.
- On uncertainty, the shared per-bridge `HALTED` marker persists. Inspect current state first. `clear-halt STATE_ID` clears the local stop only after exact state readback; it does not replay a command.
- Log files and state snapshots are private runtime evidence, excluded from Git. Never read or print API secrets. The TypeSafe client uses the environment. Logs are in `.runtime/`; shared lock and in-flight halt records are in the user's state directory, keyed by the loopback port. Changing log directories does not create another game writer.
- Unsupported screens return no options. Report the gap; do not bypass the CLI with arbitrary HTTP mutations.

## Starting a new harness

Run it from this repository. Give it this document and the owner's bounded game task. Permit the CLI commands above. Jev credentials must be present in the harness environment; configure the planner model in the harness itself. No planner vendor SDK is required by this project.

DeepSeek Harness (DSH) example, using its existing local model configuration:

```sh
node --env-file=.env scripts/dsh.mjs \
  'Inspect the current game and play only the current combat. Stop at rewards or any unsupported state. Report actual commands and outcome.'
```

Harness permission settings are separate from CLI game guards. A textual strategy suggestion is not proof of tool execution. Require CLI event logs plus game-state changes to certify an integration. For deterministic multi-card prefixes, see ROUND-PLAN.md and use `plan` rather than one model call per card.
