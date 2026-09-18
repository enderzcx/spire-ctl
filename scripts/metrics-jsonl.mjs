#!/usr/bin/env node
// Turn-level metrics report. Read-only; never touches the game.
//
//   node scripts/metrics-jsonl.mjs .runtime/events.jsonl --turns 6
//   node scripts/metrics-jsonl.mjs .runtime/events.jsonl --batch 2 --compact
import {readFile} from 'node:fs/promises';
import {turnMetrics,protocols,filterProtocol} from '../src/metrics.mjs';

function parseArgs(argv){
  const options={file:argv[0]??'.runtime/events.jsonl',turns:5,batch:3,compact:false,protocol:null};
  for(let index=1;index<argv.length;index++){
    const flag=argv[index];
    if(flag==='--compact')options.compact=true;
    else if(flag==='--turns')options.turns=Number(argv[++index]);
    else if(flag==='--batch')options.batch=Number(argv[++index]);
    else if(flag==='--protocol')options.protocol=argv[++index]==='all'?null:Number(argv[++index]);
    else if(!flag.startsWith('--')&&options.file==='.runtime/events.jsonl')options.file=flag;
  }
  return options;
}

const ms=value=>Number.isFinite(value)?`${Math.round(value)}ms`:'-';
const perTurn=value=>Number.isFinite(value)?`${Math.round(value)}ms/turn`:'-';

function table(report,limit){
  const lines=[`runs=${report.runs}`];
  for(const batch of report.batches){
    const summary=batch.summary;
    lines.push('');
    lines.push(`run ${batch.batch} (protocol ${batch.protocol}): turns=${summary.turns_total} actions=${summary.actions} cards=${summary.cards} planned_turns=${summary.applyable_batches} planned_steps=${summary.applyable_steps}`);
    lines.push(`  model: jev_calls=${summary.jev_calls} jev_requests=${summary.jev_requests} | takeovers=${summary.takeovers} (repeated_state=${summary.repeated_takeovers}) | strategy_steps=${summary.strategy_steps}`);
    if(summary.takeover_reasons.length)lines.push(`  takeover reasons: ${summary.takeover_reasons.map(r=>`${r.reason}×${r.count}`).join(', ')}`);
    lines.push(`  turn_ms ${ms(batch.stats.turn.median_ms)} median / ${ms(batch.stats.turn.max_ms)} max | action_ms ${ms(batch.stats.action.median_ms)} median | agent_gap ${ms(batch.stats.agent_gap.median_ms)} median / ${ms(batch.stats.agent_gap.max_ms)} max`);
    if(summary.stops.length)lines.push(`  stops: ${summary.stops.map(s=>`${s.reason}×${s.count}`).join(', ')}`);
    const shown=batch.turns.slice(-limit);
    lines.push(`  turn  acts  cards(jev/planner/planned)  plan  model  turn_ms  action_ms  gap_ms  stop`);
    for(const turn of shown){
      const cards=`${turn.cards_by_source.jev}/${turn.cards_by_source.planner}/${turn.cards_by_source.planned}`;
      lines.push(`  ${String(turn.turn).padStart(4)}  ${String(turn.actions).padStart(4)}  ${cards.padStart(23)}  ${String(turn.plan_steps).padStart(4)}  ${String(turn.model_calls).padStart(5)}  ${String(Math.round(turn.turn_ms??0)).padStart(7)}  ${String(Math.round(turn.action_ms)).padStart(9)}  ${String(Math.round(turn.agent_gap_ms)).padStart(6)}  ${turn.interruptions.join('|')||'-'}`);
    }
    if(batch.turns.length>shown.length)lines.push(`  (${batch.turns.length-shown.length} earlier turns omitted)`);
  }
  if(report.planned_turns){
    lines.push('');
    lines.push(`planned turns so far: ${report.planned_turns.turns} turns, ${report.planned_turns.steps} steps, median turn ${ms(report.planned_turns.turn.median_ms)}, median agent gap ${ms(report.planned_turns.agent_gap.median_ms)}`);
    lines.push(`recent ${report.recent.batch} run(s): median turn ${ms(report.recent.turn.median_ms)} (${report.recent.turn.count} turns), median Jev inference ${ms(report.recent.inference.median_ms)}`);
    lines.push(`note: planner model calls are not recorded in this log; only Jev calls are counted`);
  }
  return lines.join('\n');
}

const options=parseArgs(process.argv.slice(2));
const rows=(await readFile(options.file,'utf8')).trim().split('\n').filter(Boolean)
  .map((line,index)=>{try{return JSON.parse(line);}catch{return {event:'unparsed',index};}});
const available=protocols(rows);
const scoped=filterProtocol(rows,options.protocol);
const report=turnMetrics(scoped,options.batch);
if(available.length>1||options.protocol!==null)
  console.log(`protocols present: ${available.map(p=>`${p.protocol}(${p.count})`).join(', ')}${options.protocol===null?' — reporting all':` — reporting ${options.protocol}`}`);
if(options.compact){
  console.log(JSON.stringify({runs:report.runs,batches:report.batches.map(b=>({batch:b.batch,summary:b.summary,stats:b.stats})),
    recent:report.recent,planned_turns:report.planned_turns},null,2));
}else{
  console.log(table(report,options.turns));
}
