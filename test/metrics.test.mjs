import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyzeTurns,turnMetrics,stats,actions,splitRuns,protocols,filterProtocol} from '../src/metrics.mjs';

const T0=Date.parse('2026-09-18T01:00:00.000Z');
const at=offset=>new Date(T0+offset).toISOString();

function dispatch(offset,{round=1,source='planner',command={action:'play_card',card_index:0},label='打击',state_id='s1',floor=10,act=1}={}){
  return {at:at(offset),event:'dispatch',source,state_id,
    option:{id:'0',command,label},before:{state_type:'monster',run:{act,floor},player:{hp:70},battle:{round,turn:'player'}}};
}
function verified(offset,{action_ms=500,round=1,kind='verified',floor=10,act=1}={}){
  return {at:at(offset),event:kind,action_ms,
    option:{id:'0',command:{action:'play_card',card_index:0},label:'打击'},
    after:{state_type:'monster',run:{act,floor},player:{hp:70},battle:{round,turn:'player'}}};
}
function decision(offset,{inference_ms=400,input_tokens=1000,output_tokens=20,confidence=.8}={}){
  return {at:at(offset),event:'decision',source:'jev',inference_ms,usage:{input_tokens,output_tokens},
    answer:{choice:'0',confidence},option:{id:'0'}};
}

test('one turn with a plan, a Jev call and an agent gap',()=>{
  const rows=[
    dispatch(0),
    verified(1000,{action_ms:900}),
    decision(2500,{inference_ms:300}),
    dispatch(3000),
    verified(3700,{action_ms:700}),
    dispatch(5000,{source:'deterministic',command:{action:'end_turn'},label:'End turn'}),
    verified(6000,{action_ms:1000,round:2}),
  ];
  const [turn]=analyzeTurns(rows).turns;
  assert.equal(turn.turn,'1:10:1');
  assert.equal(turn.actions,3);
  assert.equal(turn.actions_by_source.planner,2);
  assert.equal(turn.actions_by_source.deterministic,1);
  assert.equal(turn.cards_by_source.planner,2);
  assert.equal(turn.model_calls,1);
  assert.equal(turn.inference_ms,300);
  assert.equal(turn.input_tokens,1000);
  assert.equal(turn.output_tokens,20);
  assert.equal(turn.action_ms,900+700+1000);
  // Verified timestamps already follow settlement: 1000, 3700 and 6000.
  assert.equal(turn.agent_gap_ms,2000+1300);
  assert.equal(turn.turn_ms,6000);
  assert.equal(turn.complete,true);
  assert.equal(turn.stop,false);
});

test('turn attribution follows the dispatched round, not the verified round',()=>{
  const rows=[dispatch(0,{round:1}),verified(800,{round:2}),
    dispatch(1000,{round:2}),verified(1800,{round:3})];
  const {turns}=analyzeTurns(rows);
  assert.deepEqual(turns.map(t=>t.turn),['1:10:1','1:10:2']);
});

test('a mid-turn stop is attached to the turn that was interrupted',()=>{
  const rows=[dispatch(0),verified(900,{action_ms:800}),
    {at:at(1200),event:'plan_deviation',step:1,expected:{energy:2}},
    dispatch(4000,{round:2}),verified(4700,{round:2})];
  const {turns,stops}=analyzeTurns(rows);
  assert.equal(turns[0].turn,'1:10:1');
  assert.deepEqual(turns[0].interruptions,['plan_deviation']);
  assert.equal(turns[0].stop,true);
  assert.equal(turns[0].agent_gap_ms,0);
  assert.equal(turns[0].tail_gap_ms,3100);
  assert.deepEqual([...stops], [['plan_deviation',1]]);
});

test('only a verified planned step counts as a planned step',()=>{
  const planDispatch=(offset,step)=>({at:at(offset),event:'plan_dispatch',step,
    option:{id:'0',command:{action:'play_card',card_index:step},label:'打击'},
    before:{state_type:'monster',run:{act:1,floor:10},player:{hp:70},battle:{round:3,turn:'player'}}});
  const planVerified=(offset,step)=>({at:at(offset),event:'plan_verified',step,action_ms:600,
    option:{id:'0',command:{action:'play_card',card_index:step},label:'打击'},
    after:{state_type:'monster',run:{act:1,floor:10},player:{hp:70},battle:{round:3,turn:'player'}}});
  const rows=[dispatch(0,{round:3}),verified(1000,{action_ms:900,round:3}),
    planDispatch(1200,0),planVerified(2000,0),
    planDispatch(2100,1),
    dispatch(5000,{source:'deterministic',round:3,command:{action:'end_turn'}})];
  const [turn]=analyzeTurns(rows).turns;
  assert.equal(turn.plan_steps,1);
  assert.equal(turn.actions_by_source.planned,2);
  assert.equal(turn.cards_by_source.planned,2);
});

test('stats reports median and p90 without inventing data',()=>{
  assert.deepEqual(stats([]),{count:0,min_ms:0,median_ms:0,max_ms:0,p90_ms:0});
  const s=stats([400,100,300,200]);
  assert.equal(s.count,4);
  assert.equal(s.min_ms,100);
  assert.equal(s.median_ms,250);
  assert.equal(s.max_ms,400);
  assert.equal(s.p90_ms,400);
});

test('actions() keeps dispatch order and marks unsettled actions',()=>{
  const list=actions([dispatch(0),verified(900),dispatch(1000,{round:2})]);
  assert.deepEqual(list.map(a=>[a.turn,a.settled??false]),[['1:10:1',true],['1:10:2',false]]);
});

test('splitRuns separates a new run inside one log',()=>{
  const rows=[dispatch(0,{act:1,floor:10}),verified(500,{act:1,floor:10}),
    dispatch(20000,{act:1,floor:1}),verified(20500,{act:1,floor:1})];
  const batches=splitRuns(rows);
  assert.equal(batches.length,2);
  assert.deepEqual(batches.map(b=>b.length),[2,2]);
});

test('turnMetrics summarizes batches and keeps planned turns separate',()=>{
  const turn=(base,turnRound,{steps=0}={})=>{
    const rows=[dispatch(base+turnRound*100,{round:turnRound}),verified(base+turnRound*100+800,{action_ms:700,round:turnRound})];
    for(let step=0;step<steps;step++){
      rows.push({at:at(base+turnRound*100+900),event:'plan_dispatch',step,
        option:{id:'0',command:{action:'play_card',card_index:step},label:'打击'},
        before:{state_type:'monster',run:{act:1,floor:10},player:{hp:70},battle:{round:turnRound,turn:'player'}}});
      rows.push({at:at(base+turnRound*100+1400),event:'plan_verified',step,action_ms:450,
        option:{id:'0',command:{action:'play_card',card_index:step},label:'打击'},
        after:{state_type:'monster',run:{act:1,floor:10},player:{hp:70},battle:{round:turnRound,turn:'player'}}});
    }
    return rows;
  };
  const rows=[...turn(0,1),...turn(0,2,{steps:2}),...turn(0,3),...turn(0,4)];
  const report=turnMetrics(rows,2);
  assert.equal(report.runs,1);
  assert.equal(report.batches.length,1);
  const summary=report.batches[0].summary;
  assert.equal(summary.turns_total,4);
  assert.equal(summary.applyable_batches,1);
  assert.equal(summary.applyable_steps,2);
  assert.equal(report.planned_turns.turns,1);
  assert.equal(report.planned_turns.steps,2);
  assert.equal(report.recent.batch,1);
});

test('model inference stats describe single calls, not per-turn sums',()=>{
  const rows=[
    dispatch(0,{round:1}),verified(900,{action_ms:800,round:1}),
    decision(1000,{inference_ms:300}),decision(1100,{inference_ms:500}),
    dispatch(2000,{round:1}),verified(2600,{action_ms:500,round:1}),
    dispatch(3000,{source:'deterministic',command:{action:'end_turn'},round:1}),
  ];
  const [turn]=analyzeTurns(rows).turns;
  assert.deepEqual(turn.inferences_ms,[300,500]);
  assert.equal(turn.inference_ms,800);
  const report=turnMetrics(rows,1);
  assert.equal(report.batches[0].stats.inference.count,2);
  assert.equal(report.batches[0].stats.inference.median_ms,400);
  assert.equal(report.batches[0].summary.jev_calls_within_turns,2);
});

test('reports separate protocol windows and the review counters',()=>{
  const rows=[
    {...dispatch(0,{round:1}),protocol:2}, {...verified(1000,{action_ms:900,round:1}),protocol:2},
    {...dispatch(2000,{round:1}),protocol:3},
    {...verified(3000,{action_ms:900,round:1}),protocol:3},
    {...decision(3100,{inference_ms:200,confidence:.3}),protocol:3},
    {at:at(3150),event:'ask',source:'jev',requests:3,confidence:.3,protocol:3},
    {at:at(3200),event:'takeover',source:'planner',reason:'low_confidence',repeat_count:1,protocol:3},
    {at:at(3300),event:'takeover',source:'planner',reason:'repeated_state',repeat_count:2,protocol:3},
    {at:at(3400),event:'local_decision',source:'local',kind:'strategy',reason:'strategy s1',protocol:3},
  ];
  assert.deepEqual(protocols(rows),[{protocol:3,count:7},{protocol:2,count:2}]);
  const scoped=turnMetrics(filterProtocol(rows,3),1);
  const summary=scoped.batches[0].summary;
  assert.equal(scoped.batches[0].protocol,3);
  assert.equal(summary.jev_requests,3,'requests are counted per model call, not per turn');
  assert.equal(summary.takeovers,2);
  assert.equal(summary.repeated_takeovers,1);
  assert.equal(summary.strategy_steps,1);
  assert.deepEqual(summary.takeover_reasons,[{reason:'low_confidence',count:1},{reason:'repeated_state',count:1}]);
  assert.equal(turnMetrics(filterProtocol(rows,2),1).batches[0].summary.takeovers,0);
});
