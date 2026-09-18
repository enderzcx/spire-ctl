# One plan, multiple verified cards

`node bin/spire.mjs state` includes `planning_state`, a projection of strategically relevant fields. A planner may choose a deterministic prefix of the current hand and write a plan file in `.runtime/`:

```json
{
  "state_id": "COPY_FROM_STATE",
  "steps": [
    {"card_index": 2, "expect": {"energy": 2, "block": 5}},
    {"card_index": 0, "expect": {"energy": 1, "block": 10}}
  ]
}
```

This illustrative example assumes two one-energy Defends, starting at three energy and zero block. Use the real card values and state. Run:

```sh
node bin/spire.mjs plan .runtime/turn.json
```

`card_index` always refers to the **original hand in the initial snapshot**. The executor remaps indices after each card. Each card may appear only once. For an enemy target, add `target_combat_id` using the observed numeric combat ID, not the shifting entity-name suffix.

For each step, `expect` patches the previous planning projection. Every unspecified field must stay unchanged. By default the played card is removed from the hand and discard count increases by one. Override `discard` / `exhaust` for exhausting cards, and `hand` for known cost changes, preserving the exact remaining IDs/order. Expected enemy HP/block/status changes require supplying the whole `enemies` array from the projection with those fields updated. This is a prediction supplied by the planner, not an internal game simulator.

The executor waits until **all expected effects** are observed consistently before sending the next action. Card movement alone is not completion. Unexpected damage, card changes, status effects or an unrecognized result stop the sequence with a persistent no-replay halt. Drawing or generating cards cannot be included in a plan; end the prefix before that step, then use a single action and replan from the new information. Card-selection overlays and combat end return control immediately.

This removes model calls between cards, not game animation. End-turn remains a separate action after the plan; a plan cannot cross rounds. At most ten original-hand cards are allowed. The same single-writer lock and stale-state check apply.

Offline tests cover two-card execution with shifting indices, delayed damage, unexpected draws, repeated-card rejection, stale plans and turn/draw boundaries. Real plan execution is tracked separately in VALIDATION.md.

Plans require a bridge reporting both `action_running: false` and `action_queue_empty: true`. Old bridges are rejected before dispatch. Shared lock and in-flight halt state are kept under the user state directory, keyed by loopback port, independently of the log directory.
