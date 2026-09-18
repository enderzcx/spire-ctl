#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

export function summarize(rows){
  const out={model_calls:0,input_tokens:0,output_tokens:0,decisions_by_confidence:{below_half:0,at_least_half:0},
    actions:{jev_cards:0,planner_cards:0,planned_cards:0,deterministic_end_turns:0,planner_end_turns:0,planner_potions:0,planner_selections:0,progression:0},
    bridge_observations:{queue_aware_combat:0,legacy_combat:0},stops:0,observed_rooms:[],timing:{}};
  const inference=[],plans=[],cycles=[];const rooms=new Set();let before=null;
  for(const row of rows){
    if(row.event==='decision'&&row.source==='jev'){
      out.model_calls++;out.input_tokens+=row.usage?.input_tokens??0;out.output_tokens+=row.usage?.output_tokens??0;
      if(Number.isFinite(row.inference_ms))inference.push(row.inference_ms);
      out.decisions_by_confidence[row.answer.confidence<.5?'below_half':'at_least_half']++;
    }
    if(row.event==='dispatch')before=row.before;
    if(row.event==='verified'){
      const action=row.option?.command?.action;
      if(action==='play_card')out.actions[row.source==='jev'?'jev_cards':'planner_cards']++;
      else if(action==='use_potion')out.actions.planner_potions++;
      else if(action==='end_turn'&&row.source==='deterministic')out.actions.deterministic_end_turns++;
      else if(action==='end_turn')out.actions.planner_end_turns++;
      else if(['select_card','combat_select_card','confirm_selection','combat_confirm_selection'].includes(action))out.actions.planner_selections++;
      else out.actions.progression++;
      if(before?.battle)out.bridge_observations[typeof before.battle.action_running==='boolean'?'queue_aware_combat':'legacy_combat']++;
      if(before?.run)rooms.add(`${before.run.act}:${before.run.floor}`);
      before=null;
    }
    if(row.event==='plan_verified'){out.actions.planned_cards++;plans.push(row.action_ms);}
    if(row.event==='cycle'&&row.source==='jev')cycles.push(row.total_ms);
    if(['halted','plan_deviation'].includes(row.event))out.stops++;
  }
  const stats=xs=>{xs=[...xs].sort((a,b)=>a-b);return xs.length?{count:xs.length,min_ms:xs[0],median_ms:(xs[Math.floor((xs.length-1)/2)]+xs[Math.floor(xs.length/2)])/2,max_ms:xs.at(-1)}:{count:0};};
  out.timing={jev_inference:stats(inference),jev_cycle:stats(cycles),planned_card:stats(plans)};
  out.observed_rooms=[...rooms];return out;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const file=process.argv[2]??'.runtime/events.jsonl';
  const rows=(await readFile(file,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  console.log(JSON.stringify(summarize(rows),null,2));
}
