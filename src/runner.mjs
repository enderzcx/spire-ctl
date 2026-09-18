import {mkdir,readFile,writeFile,appendFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {actions,inCombat,route,stateId,incomingDamage} from './game.mjs';
import {localPolicy,guardOption,nextLocalPlay} from './policy.mjs';

export function envelope(state){
  const options=actions(state),incoming=inCombat(state)?incomingDamage(state):null;
  const attackGap=incoming===null?null:Math.max(0,incoming-(state.player?.block??0));
  return {state_id:stateId(state),route:route(state,options),options,state,
    tactical_facts:inCombat(state)?{displayed_attack_damage:incoming,block_needed_for_displayed_attacks:attackGap,
      note:'Current displayed attacks only; excludes future card effects and end-turn triggers.'}:undefined};
}

export async function withLock(dir,fn){
  await mkdir(dir,{recursive:true});const lock=join(dir,'execution.lock');
  try{await mkdir(lock);}catch(e){if(e.code==='EEXIST')throw Error('Another controller owns execution; do not run two agents at once');throw e;}
  try{return await fn();}finally{await rm(lock,{recursive:true});}
}

export function recorder(dir){return async data=>{await mkdir(dir,{recursive:true});await appendFile(join(dir,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),...data})+'\n');};}

export async function execute(game,expectedId,optionId,{dir,control=dir,record=recorder(dir),source='planner'}={}){
  try{await readFile(join(control,'HALTED'));throw Error('Previous action outcome unknown: inspect game and clear the halt explicitly');}catch(e){if(e.code!=='ENOENT')throw e;}
  const before=await game.read();
  if(stateId(before)!==expectedId)throw Error('Stale state: refresh before choosing an action');
  const option=actions(before).find(o=>o.id===String(optionId));
  if(!option)throw Error('Action not advertised by this state');
  await record({event:'dispatch',source,state_id:expectedId,option,before});
  await writeFile(join(control,'HALTED'),JSON.stringify({reason:'in_flight',expectedId,option}),{flag:'wx'});
  const start=performance.now();
  try{
    const receipt=await game.send(option.command);
    const after=await game.settled(expectedId);
    const action_ms=Math.round(performance.now()-start);
    await record({event:'verified',source,option,receipt,after,action_ms});
    await rm(join(control,'HALTED'));
    return {action_ms,...envelope(after)};
  }catch(e){
    await writeFile(join(control,'HALTED'),JSON.stringify({expectedId,option,reason:e.message}));
    await record({event:'halted',source,reason:e.message});throw e;
  }
}

export async function battle(game,decide,{dir,control=dir,max=60,record=recorder(dir),policy=localPolicy}={}){
  if(!Number.isInteger(max)||max<1||max>100)throw Error('max must be 1..100');
  let s=await game.settled(),tokens=0,steps=0;const room=JSON.stringify(s.run);
  const openingStep=steps;
  for(;steps<max;steps++){
    const env=envelope(s);
    const actedThisTurn=steps>openingStep;
    if(!inCombat(s)||JSON.stringify(s.run)!==room)return {reason:'left_combat',steps,...env};
    if(env.route.kind==='planner')return {reason:env.route.reason,steps,...env};
    if(env.route.kind==='wait')throw Error('Unexpected busy state');
    if(tokens>=100000)return {reason:'token_budget',steps,...env};
    const start=performance.now();let option=env.route.option,source='deterministic',local=null;
    if(env.route.kind==='jev'){
      // The program decides only what the arithmetic already settled: an exact
      // lethal line, or the only play that survives displayed lethal damage.
      // Displayed lethal damage that this hand cannot block is a real planner
      // decision, not a fast-model guess.
      const decision=policy?policy(s,env.options):null;
      if(decision?.kind==='escalate')return {reason:decision.reason,steps,...env,local_evidence:decision.evidence};
      // `kill` proposes an ordered line, `play`/`guard` a single action, and
      // `resolve` continues a turn the program is already running. All of them
      // are program-settled, so no model call is needed for them.
      const localOption=['play','guard'].includes(decision?.kind)?decision.option:
        decision?.kind==='kill'?decision.options?.[0]??null:null;
      if(localOption){option=localOption;source='local';local=decision;}
      // Nothing forced a decision and the turn is not over: keep playing moves
      // that are pure arithmetic (a known number on a known target) instead of
      // paying a model round trip per card. A guard above still wins.
      if(!option&&decision?.kind==='decline'){
        const next=nextLocalPlay(s,env.options);
        if(next){option=next.option;source='local';local=next;}
        else{
          // Nothing locally playable and no model needed: the turn is safe to
          // close, so pay no round trip for an action the rules already fix.
          const close=env.options.find(o=>o.command.action==='end_turn');
          const attacks=incomingDamage(s);
          // Only close a turn the program is already running. The opening
          // decision of a turn still reaches a model, so the shortcut never
          // replaces strategy with silence.
          if(close&&actedThisTurn&&attacks!==null&&attacks-s.player.block<s.player.hp){
            option=close;source='local';
            local={kind:'end_turn',reason:'No local play and no threat; close the turn',
              evidence:{incoming:attacks,block:s.player.block,hp:s.player.hp}};
          }
        }
      }
      if(!option){
        const candidates=env.options.filter(o=>o.command.action!=='use_potion');
        const shortlist=decision?.kind==='shortlist'?decision:null;
        const d=await decide(s,candidates,shortlist);
        tokens+=d.usage?.input_tokens??0;
        // Hoist the shortlist provenance so the log shows, without reading the
        // model answer, whether a narrowed menu produced this decision.
        await record({event:'decision',source:'jev',state_id:env.state_id,...d,
          shortlist_reason:d.answer?.shortlist_reason??null,narrowed:d.answer?.narrowed??false});
        if(d.answer.confidence<.5){
          // The cutoff is unchanged. A low-confidence answer is only a handoff
          // when the program has no fully-determined move of its own: a guard
          // that covers the whole displayed attack, or a self-contained play
          // the fast model is likely missing (it cannot see end-of-turn expiry).
          const fallback=policy?guardOption(s,env.options)??nextLocalPlay(s,env.options):null;
          if(!fallback)return {reason:'low_confidence',proposal:d,steps,...env};
          option=fallback.option;source='local';local={...fallback,low_confidence:d.answer.confidence};
        }else{
          option=d.option;source='jev';
        }
        option=d.option;source='jev';
      }
    }
    if(local)await record({event:'local_decision',source:'local',state_id:env.state_id,
      kind:local.kind,reason:local.reason,evidence:local.evidence,option,
      line:local.kind==='kill'?(local.options??[]).map(o=>o.label):undefined});
    const next=await execute(game,env.state_id,option.id,{dir,control,record,source});
    await record({event:'cycle',source,total_ms:Math.round(performance.now()-start),action_ms:next.action_ms});
    s=next.state;
  }
  return {reason:'step_budget',steps,...envelope(s)};
}
