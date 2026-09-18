import {test} from 'node:test';
import assert from 'node:assert/strict';
import {summarize} from '../scripts/summarize.mjs';
test('summary distinguishes legacy observations, plans, model calls and strategic actions',()=>{
  const r=summarize([
    {event:'decision',source:'jev',answer:{confidence:.8},inference_ms:300,usage:{input_tokens:20,output_tokens:5}},
    {event:'dispatch',before:{battle:{},run:{act:1,floor:3}}},
    {event:'verified',source:'jev',option:{command:{action:'play_card'}}},
    {event:'plan_verified',action_ms:600},
    {event:'plan_verified',action_ms:800},
    {event:'verified',source:'planner',option:{command:{action:'select_card_reward'}}}
  ]);
  assert.equal(r.actions.jev_cards,1);assert.equal(r.actions.planned_cards,2);assert.equal(r.actions.progression,1);
  assert.equal(r.bridge_observations.legacy_combat,1);assert.equal(r.timing.planned_card.median_ms,700);assert.equal(r.model_calls,1);
});
