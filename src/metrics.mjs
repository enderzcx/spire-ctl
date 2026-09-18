// Turn-level observability derived from the private event log. Read-only.
// Nothing here creates another game writer: it only reads JSONL rows.
//
// Event facts this module relies on, verified against .runtime/events.jsonl:
//   - `dispatch` carries `before` (the state the action was chosen from) and a
//     `source`. `verified`/`plan_verified` carry `after` and `action_ms`.
//   - `cycle` only exists for actions executed inside a `battle` loop, so it
//     covers fewer than half of real actions. Turn accounting must therefore be
//     driven by dispatch -> verified pairs, not by cycles.
//   - `battle.round` is the round of the state that was read, and it increments
//     when the turn is left. An `end_turn` dispatched at round N is verified at
//     round N+1, so actions are attributed to the round of their dispatch.
//   - `decision` rows record the Jev model call and its latency/usage. A
//     planner decision leaves no such row, so planner calls are not countable
//     from this log; that number must come from the calling harness.
//
// Timing vocabulary (an estimate of observed wall time, not a simulation):
//   action_ms    = bridge round trip until the settlement probe agrees. This is
//                  game animation and settlement, not model time.
//   agent_gap_ms = previous action settled to next dispatch inside one turn.
//   turn_ms      = first dispatch of the turn to the dispatch of the action that
//                  ended it (or to the last settled action of a turn that was
//                  left by something else, e.g. death).

const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const isNum=value=>Number.isFinite(value);
const roundOf=state=>isNum(state?.battle?.round)?state.battle.round:null;

function atMs(row){
  const parsed=Date.parse(row?.at??'');
  return Number.isFinite(parsed)?parsed:null;
}

// `battle.round` does not restart between combats: real logs continue one
// fight's counter into the next, so a bare round number merges separate turns.
// A turn is keyed by act, floor and round together, and an in-turn step (plan
// dispatch/verify or a model call) keeps the key of the sequence it belongs to.
export function turnKey(state){
  const round=roundOf(state);
  if(round===null)return 'unknown';
  const run=state?.run??{};
  return `${isNum(run.act)?run.act:'?'}:${isNum(run.floor)?run.floor:'?'}:${round}`;
}

export function stats(values){
  const sorted=values.filter(isNum).sort((a,b)=>a-b);
  if(!sorted.length)return {count:0,min_ms:0,median_ms:0,max_ms:0,p90_ms:0};
  const lower=Math.floor((sorted.length-1)/2),upper=Math.floor(sorted.length/2);
  return {count:sorted.length,min_ms:sorted[0],median_ms:(sorted[lower]+sorted[upper])/2,
    max_ms:sorted.at(-1),p90_ms:sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.9))]};
}

export function groupBy(array,key){
  const out=new Map();
  for(const item of array){
    const bucket=key(item),list=out.get(bucket);
    if(list)list.push(item);else out.set(bucket,[item]);
  }
  return out;
}

function newTurn(key){
  return {turn:key,start_ms:null,end_ms:null,as_of_ms:null,
    complete:false,actions:0,cards_by_source:{jev:0,planner:0,planned:0},
    actions_by_source:{jev:0,planner:0,deterministic:0,planned:0},other_actions:0,
    model_calls:0,model_requests:0,strategy_steps:0,takeovers:0,repeated_takeovers:0,
    inference_ms:0,inferences_ms:[],input_tokens:0,output_tokens:0,
    action_ms:0,agent_gap_ms:0,tail_gap_ms:0,plan_steps:0,
    interruptions:[]};
}

function reasonOf(row){
  const reason=row?.reason??row?.event;
  return typeof reason==='string'?reason.trim():String(reason??'unknown');
}

// Rows from several runs can share one log. Split only on an explicit protocol
// boundary so a resumed run is never silently merged with the previous one.
// The review requires same-version windows: events are stamped with the
// decision protocol they were produced under, so reports never average two
// different systems together.
export function protocols(rows){
  const seen=new Map();
  for(const row of rows){
    if(!isObject(row))continue;
    const key=row.protocol??'unversioned';
    seen.set(key,(seen.get(key)??0)+1);
  }
  return [...seen.entries()].map(([protocol,count])=>({protocol,count})).sort((a,b)=>b.count-a.count);
}

export function filterProtocol(rows,protocol){
  if(protocol===undefined||protocol===null)return rows;
  return rows.filter(row=>isObject(row)&&(row.protocol??'unversioned')===protocol);
}

export function splitRuns(rows){
  const boundaries=[];
  let cursor=-1;
  for(let index=0;index<rows.length;index++){
    const row=rows[index];
    if(!isObject(row))continue;
    const run=row.before?.run??row.after?.run;
    if(!isNum(run?.floor))continue;
    if(cursor<0){boundaries.push(index);cursor=index;continue;}
    const priorRun=rows[cursor].before?.run??rows[cursor].after?.run;
    if(run.act<priorRun.act||(run.act===priorRun.act&&run.floor<priorRun.floor)){boundaries.push(index);cursor=index;}
    else cursor=index;
  }
  if(!boundaries.length)return [rows];
  return boundaries.map((start,position)=>rows.slice(start,boundaries[position+1]??rows.length));
}

// Every action observed in the log, in dispatch order, with the turn it belongs
// to. `planned` is true only for a plan step that reached plan_verified.
export function actions(rows){
  const out=[];
  let current=null;
  for(const row of rows){
    if(!isObject(row))continue;
    const at=atMs(row);
    if(row.event==='dispatch'||row.event==='plan_dispatch'){
      const planned=row.event==='plan_dispatch';
      const command=row.option?.command??{};
      const turn=planned?current?.turn:turnKey(row.before);
      const record={event:row.event,planned,source:planned?'planned':(row.source??'planner'),
        action:command.action??'unknown',at_ms:at,round:roundOf(row.before),turn:turn??'unknown',
        label:row.option?.label??'',card_index:command.card_index,ended_turn:command.action==='end_turn',
        plan_step:isNum(row.step)?row.step:null,action_ms:null};
      out.push(record);current=record;
      continue;
    }
    if(!current)continue;
    if(row.event==='verified'||row.event==='plan_verified'){
      current.action_ms=isNum(row.action_ms)?row.action_ms:null;
      // `at` is recorded right after the mutation round trip, before the
      // settlement probe finishes, so the observed settle moment is at+action_ms.
      const verifiedAt=atMs(row);
      current.settled_at=verifiedAt!==null&&isNum(row.action_ms)?verifiedAt+row.action_ms:verifiedAt;
      current.after_round=roundOf(row.after);
      current.settled=true;
      current.plan_verified=row.event==='plan_verified';
      continue;
    }
    if(row.event==='plan_deviation'||row.event==='plan_invalidated_before_action'||row.event==='halted'){
      current.failed=true;current.failure=reasonOf(row);
    }
  }
  return out;
}

export function analyzeTurns(rows){
  const list=actions(rows);
  const byId=new Map();
  const turns=[];
  const stops=new Map();
  const takeovers=new Map();
  let modelCalls=0,inferenceMs=0,inputTokens=0,outputTokens=0;

  const turnFor=(key)=>{
    if(!byId.has(key)){const turn=newTurn(key);byId.set(key,turn);turns.push(turn);}
    return byId.get(key);
  };
  // Turn ownership is decided by each action's own dispatch round, so a gap that
  // spans a hand-off lands on the turn that was interrupted, not on the next one.
  for(const record of list){
    const turn=turnFor(record.turn);
    turn.actions++;
    turn.actions_by_source[record.source]=(turn.actions_by_source[record.source]??0)+1;
    if(record.action==='play_card')turn.cards_by_source[record.source]=(turn.cards_by_source[record.source]??0)+1;
    if(!['play_card','use_potion','end_turn'].includes(record.action))turn.other_actions++;
    if(record.plan_verified===true)turn.plan_steps++;
    if(isNum(record.action_ms))turn.action_ms+=record.action_ms;
  }

  // Gaps between actions, attributed to the turn of the action that follows and
  // skipped when it belongs to a different turn or starts before the first one.
  // The last action of a turn has no successor inside the turn, so its wait is
  // recorded as tail_gap_ms: the observed hand-off cost to whoever acted next.
  let previous=null;
  for(const record of list){
    const turn=turnFor(record.turn);
    const at=record.at_ms;
    if(at!==null&&(turn.start_ms===null||at<turn.start_ms))turn.start_ms=at;
    if(previous){
      if(previous.turn===record.turn&&at!==null&&previous.settled_ms!==null)
        turn.agent_gap_ms+=Math.max(0,at-previous.settled_ms);
      else if(at!==null&&previous.settled_ms!==null){
        const prior=turnFor(previous.turn);
        prior.tail_gap_ms+=Math.max(0,at-previous.settled_ms);
      }
    }
    const settled=record.settled_at??(at!==null&&isNum(record.action_ms)?at+record.action_ms:null);
    if(settled!==null&&(turn.end_ms===null||settled>turn.end_ms))turn.end_ms=settled;
    previous={turn:record.turn,settled_ms:settled};
  }

  for(const row of rows){
    if(!isObject(row)||!['halted','plan_deviation'].includes(row.event))continue;
    const reason=reasonOf(row);
    const owner=[...byId.values()].find(turn=>turn.start_ms!==null&&turn.end_ms!==null&&atMs(row)>=turn.start_ms&&atMs(row)<=turn.end_ms)
      ??turns.at(-1);
    if(!owner)continue;
    if(!owner.interruptions.includes(reason))owner.interruptions.push(reason);
    stops.set(reason,(stops.get(reason)??0)+1);
  }

  for(const row of rows){
    if(!isObject(row)||row.event!=='decision'||row.source!=='jev')continue;
    modelCalls++;
    const inference=isNum(row.inference_ms)?row.inference_ms:0;
    inferenceMs+=inference;
    const input=isNum(row.usage?.input_tokens)?row.usage.input_tokens:0,output=isNum(row.usage?.output_tokens)?row.usage.output_tokens:0;
    inputTokens+=input;outputTokens+=output;
    const at=atMs(row);
    const owner=[...byId.values()].find(turn=>turn.start_ms!==null&&turn.end_ms!==null&&at!==null&&at>=turn.start_ms&&at<=turn.end_ms)
      ??turns.at(-1);
    if(!owner)continue;
    owner.model_calls++;owner.inference_ms+=inference;owner.inferences_ms.push(inference);
    owner.input_tokens+=input;owner.output_tokens+=output;
    if(at!==null)owner.as_of_ms=Math.max(owner.as_of_ms??at,at);
  }

  // Requests actually sent to the fast model (including narrowed retries and the
  // stability probe), takeovers handed back to the planner with their reasons,
  // and steps executed under an agreed strategy. These are the counters the
  // review requires so a speed claim is not just a share of local cards.
  for(const row of rows){
    if(!isObject(row))continue;
    const kind=row.event;
    if(kind!=='ask'&&kind!=='takeover'&&!(kind==='local_decision'&&row.kind==='strategy'))continue;
    const at=atMs(row);
    const owner=[...byId.values()].find(turn=>turn.start_ms!==null&&turn.end_ms!==null&&at!==null&&at>=turn.start_ms&&at<=turn.end_ms)
      ??turns.at(-1);
    if(!owner)continue;
    if(kind==='ask'){owner.model_requests+=Number(row.requests??1);continue;}
    if(kind==='takeover'){
      owner.takeovers++;
      if(row.reason==='repeated_state')owner.repeated_takeovers++;
      const reason=String(row.reason??'takeover');
      const entry=takeovers.get(reason)??{reason,count:0};
      entry.count++;takeovers.set(reason,entry);
      continue;
    }
    owner.strategy_steps++;
  }

  for(const turn of turns){
    if(turn.start_ms!==null&&turn.end_ms!==null&&turn.end_ms>turn.start_ms)
      turn.turn_ms=Math.max(0,turn.end_ms-turn.start_ms);
    else if(Number.isFinite(turn.action_ms))turn.turn_ms=turn.action_ms;
    turn.complete=turn.end_ms!==null;
    turn.stop=!!turn.interruptions.length;
  }

  return {turns,actions:list,stops,takeovers:[...takeovers.values()].sort((a,b)=>b.count-a.count),
    calls:{jev:modelCalls},
    usage:{inference_ms:Math.round(inferenceMs),input_tokens:inputTokens,output_tokens:outputTokens}};
}

export function turnMetrics(rows,batch=3){
  const runs=splitRuns(rows);
  const summaries=runs.map((runRows,position)=>{
    const {turns,stops,takeovers,calls,usage}=analyzeTurns(runRows);
    const last=turns.at(-1);
    // The dominant protocol of the rows in this batch, so a window label never
    // depends on which row happened to come first.
    const counts=new Map();
    for(const row of runRows){
      if(!isObject(row))continue;
      const key=row.protocol??'unversioned';
      counts.set(key,(counts.get(key)??0)+1);
    }
    const protocol=[...counts.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0]??'unversioned';
    return {batch:position+1,protocol,turns,
      summary:{turns_total:turns.length,turns_complete:turns.filter(t=>t.complete).length,
        jev_calls_within_turns:turns.reduce((total,t)=>total+t.model_calls,0),
        jev_requests:turns.reduce((total,t)=>total+t.model_requests,0),
        strategy_steps:turns.reduce((total,t)=>total+t.strategy_steps,0),
        takeovers:turns.reduce((total,t)=>total+t.takeovers,0),
        repeated_takeovers:turns.reduce((total,t)=>total+t.repeated_takeovers,0),
        takeover_reasons:takeovers,
        actions:turns.reduce((total,t)=>total+t.actions,0),
        cards:turns.reduce((total,t)=>total+t.cards_by_source.jev+t.cards_by_source.planner+t.cards_by_source.planned,0),
        jev_calls:calls.jev,inference_ms:usage.inference_ms,
        input_tokens:usage.input_tokens,output_tokens:usage.output_tokens,
        applyable_batches:turns.filter(t=>t.plan_steps>0).length,
        applyable_steps:turns.reduce((total,t)=>total+t.plan_steps,0),
        stops:[...stops.entries()].map(([reason,count])=>({reason,count})).sort((a,b)=>b.count-a.count),
        last_turn:last?{turn:last.turn,complete:last.complete,stop:last.stop,
          interruptions:last.interruptions,actions:last.actions,
          cards:last.cards_by_source,plan_steps:last.plan_steps,turn_ms:last.turn_ms??null,
          action_ms:last.action_ms,agent_gap_ms:last.agent_gap_ms}:null},
      stats:{turn:stats(turns.map(t=>t.turn_ms??0).filter(isNum)),
        action:stats(turns.map(t=>t.action_ms)),agent_gap:stats(turns.map(t=>t.agent_gap_ms)),
        inference:stats(turns.flatMap(t=>t.inferences_ms))}};
  });
  const withPlans=summaries.filter(s=>s.summary.applyable_steps>0);
  const tail=summaries.slice(-batch);
  return {runs:summaries.length,batches:tail,
    recent:{batch:tail.length,
      turn:stats(tail.flatMap(s=>s.stats.turn.count?s.turns.map(t=>t.turn_ms??0).filter(isNum):[])),
      inference:stats(tail.flatMap(s=>s.turns.flatMap(t=>t.inferences_ms)))},
    planned_turns:withPlans.length?{
      turns:withPlans.reduce((total,s)=>total+s.turns.filter(t=>t.plan_steps>0).length,0),
      steps:withPlans.reduce((total,s)=>total+s.summary.applyable_steps,0),
      turn:stats(withPlans.flatMap(s=>s.turns.filter(t=>t.plan_steps>0).map(t=>t.turn_ms??0).filter(isNum))),
      agent_gap:stats(withPlans.flatMap(s=>s.turns.filter(t=>t.plan_steps>0).map(t=>t.agent_gap_ms)))}:null};
}
