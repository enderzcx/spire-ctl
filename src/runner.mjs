import {mkdir,readFile,writeFile,appendFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {actions,inCombat,route,stateId,incomingDamage} from './game.mjs';
import {localPolicy,nextLocalPlay,verifyStableProposal} from './policy.mjs';
import {loadStrategy,strategyApplies,strategyPreference,seenHandoff,noteHandoff,guardSignature,noteGuard} from './strategy.mjs';
import {mechanicalPlan} from './mechanical.mjs';
import {planCandidates} from './planning.mjs';

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

// Every event carries the decision-protocol version it was produced under, so a
// report can split windows instead of averaging two different systems together.
export const PROTOCOL=3;
export function recorder(dir){return async data=>{await mkdir(dir,{recursive:true});await appendFile(join(dir,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),protocol:PROTOCOL,...data})+'\n');};}

// `control` holds the shared halt and lock material; it is the bridge's state
// directory in production and may be pointed elsewhere by tests so one case
// cannot leak a halt into the next.
// `source` records who decided the action. A program-driven progression choice
// (map, reward, event) is labelled by its caller, so a metrics window can tell
// "the agent chose this" apart from "the planner was handed a decision".
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
    // "No settled state transition" is the one outcome that is provably
    // consequence-free: the action was accepted but the game looks exactly the
    // same, so nothing needs replaying and the caller may choose differently.
    // Every other failure stays halted, because the action may have happened.
    if(/No settled state transition/.test(e.message)){
      const settledId=stateId(await game.read());
      if(settledId===expectedId){
        await rm(join(control,'HALTED'));
        await record({event:'no_state_change',source,option,reason:e.message});
        return {action_ms:Math.round(performance.now()-start),no_state_change:true,...envelope(await game.read())};
      }
    }
    await writeFile(join(control,'HALTED'),JSON.stringify({expectedId,option,reason:e.message}));
    await record({event:'halted',source,reason:e.message});throw e;
  }
}

export async function battle(game,decide,{dir,control=dir,max=60,record=recorder(dir),policy=localPolicy}={}){
  if(!Number.isInteger(max)||max<1||max>100)throw Error('max must be 1..100');
  let s=await game.settled(),tokens=0,steps=0;const room=JSON.stringify(s.run);
  const openingStep=steps;
  // A strategy agreed at a previous takeover is loaded once and re-checked on
  // every step against the live state.
  const agreed=await loadStrategy(dir,s);
  for(;steps<max;steps++){
    const env=envelope(s);
    const actedThisTurn=steps>openingStep;
    if(!inCombat(s)||JSON.stringify(s.run)!==room)return {reason:'left_combat',steps,...env};
    // A guard (low HP, lethal-incoming threshold) is the program's own
    // threshold, not a new decision, so an agreed strategy may carry the loop
    // through it. A strategic route always returns to the caller.
    const guardKind=env.route.kind==='planner'&&env.route.strategic===false?env.route.guard:null;
    const carried=agreed&&guardKind&&strategyApplies(agreed,s).ok?strategyPreference(agreed,env.options):null;
    if(env.route.kind==='planner'&&!carried){
      // A repeated guard state does not interrupt again: the same health band and
      // the same enemies were already reported, so the loop keeps its own counsel
      // until something actually changes.
      if(guardKind){
        const signature=guardSignature(s);
        const {repeated}=await noteGuard(dir,guardKind,signature);
        if(repeated){
          await record({event:'guard_repeat',source:'program',guard:guardKind,
            signature,state_type:s.state_type});
          // The same guard state was already reported. The program still has no
          // verified move of its own, so it hands over explicitly and says what
          // would unblock the loop instead of guessing or stalling silently.
          return {reason:`${env.route.reason} (already reported)`,steps,...env,guard:guardKind,
            guard_repeated:true,
            instruction:'This guard state was already reported; return a decision or a strategy with explicit conditions and expiry so the loop can continue'};
        }
        return {reason:env.route.reason,steps,...env,guard:guardKind,
          instruction:'Return a decision, or a strategy with explicit conditions and expiry'};
      }
      return {reason:env.route.reason,steps,...env};
    }
    if(env.route.kind==='wait')throw Error('Unexpected busy state');
    if(tokens>=100000)return {reason:'token_budget',steps,...env};
    const start=performance.now();let option=env.route.option,source='deterministic',local=null;
    // The agreed strategy outranks the fast model while it still applies: that is
    // what keeps a decided fight running without a round trip per card.
    if(!option&&carried){option=carried.option;source='local';
      local={kind:'strategy',reason:`Strategy ${agreed.strategy_id}: ${carried.preference.why??carried.preference.match}`,
        evidence:{strategy_id:agreed.strategy_id,conditions:agreed.conditions.length,
          expiry:agreed.expires_on?.length??0}};}
    if(!option&&env.route.kind==='jev'){
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
      // A previously agreed strategy keeps the loop running without another
      // round trip, but only while its explicit conditions still hold and only
      // against options this state actually advertises.
      if(!option){
        // A model call needs a real question. One playable card plus "end turn",
        // or an empty hand, is not a choice: asking anyway costs 0.6-1.2s and
        // buys nothing, and the local rules above already refuse to guess.
        const candidates=env.options.filter(o=>o.command.action!=='use_potion');
        const playable=candidates.filter(o=>o.command.action==='play_card');
        const hasPotion=env.options.some(o=>o.command.action==='use_potion');
        if(playable.length<=1&&!hasPotion){
          const only=playable[0]??env.options.find(o=>o.command.action==='end_turn');
          if(!only)return {reason:'no_legal_action',steps,...env};
          option=only;source='local';
          local={kind:'sole_action',reason:`No choice to make: ${playable.length?`the only playable card (${only.label.slice(0,40)})`:'nothing playable'}`,
            evidence:{playable_cards:playable.length}};
        }
      }
      if(!option){
        const candidates=env.options.filter(o=>o.command.action!=='use_potion');
        const shortlist=decision?.kind==='shortlist'?decision:null;
        // Short-plan mode is opt-in so single-step and planned decisions can be
        // compared on the same board: SPIRE_CANDIDATES=1 builds a bounded set of
        // verified prefixes and the adapter chooses among them.
        const plans=process.env.SPIRE_CANDIDATES==='1'?planCandidates(s,candidates):null;
        const d=await decide(s,candidates,shortlist,{candidates:plans,strategy:agreed});
        tokens+=d.usage?.input_tokens??0;
        // Requests actually sent to the fast model, including the narrowed
        // retry and the stability probe, so a per-turn request count is real.
        await record({event:'ask',source:'jev',state_id:env.state_id,
          requests:d.requests??1,narrowed:d.answer?.narrowed??false,stable:d.answer?.stable??false,
          confidence:d.answer?.confidence??null,playable_cards:candidates.filter(o=>o.command.action==='play_card').length});
        // Hoist the shortlist provenance so the log shows, without reading the
        // model answer, whether a narrowed menu produced this decision.
        await record({event:'decision',source:'jev',state_id:env.state_id,...d,
          playable_cards:candidates.filter(o=>o.command.action==='play_card').length,
          shortlist_reason:d.answer?.shortlist_reason??null,narrowed:d.answer?.narrowed??false});
        if(d.low_confidence_candidate){
          // A candidate line the model was not sure about. Acting on it would be
          // the program overruling an unsure answer, and substituting the
          // program's own preferred card would be worse: the packet goes back
          // with the independent judgments attached as evidence.
          return {reason:d.no_surviving_candidate?'Potential lethal incoming damage':'low_confidence_candidate',
            proposal:d,steps,...env,
            instruction:'Return a decision, or a strategy with explicit conditions and expiry'};
        }else if(d.answer.confidence<.5){
          // The cutoff is unchanged. A low-confidence answer is only a handoff
          // when the program has no defensible move of its own:
          //   1. a fully-determined local play (guard / confirmed lethal /
          //      the only legal card),
          //   2. the same answer twice with the proposal verified as safe.
          const stable=d.answer.stable&&d.answer.second_confidence<.5&&policy
            ?verifyStableProposal(s,env.options,d.option):null;
          if(stable?.ok){
            option=d.option;source='local';
            local={kind:'jev_stable',reason:`Fast model repeated the same choice at ${d.answer.confidence.toFixed(2)}; ${stable.reason}`,
              evidence:{confidence:d.answer.confidence,second:d.answer.second_confidence}};
          }else{
            // The fast model's answer could not be used and the program has no
            // verified substitute. Substituting a card the program happens to
            // prefer would be the program making the tactical choice, so the
            // decision goes back instead of being quietly replaced. If this
            // exact state was already handed over, asking again cannot help:
            // the packet is marked as a repeat so the caller supplies a
            // strategy or a decision instead of another sample.
            const prior=await seenHandoff(dir,env.state_id);
            const reason=prior?'repeated_state':'low_confidence';
            await noteHandoff(dir,env.state_id,reason);
            await record({event:'takeover',source:'planner',reason,state_id:env.state_id,
              repeat_count:(prior?.count??0)+1,confidence:d.answer?.confidence??null,
              stable_rejection:stable?.reason??'no stable proposal'});
            return {reason,proposal:d,steps,...env,repeat_count:(prior?.count??0)+1,
              instruction:'Return a decision, or a strategy with explicit conditions and expiry',
              stable_rejection:stable?.reason??'no stable proposal'};
          }
        }else{
          option=d.option;source='jev';
        }
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

// Mechanical progress: claim what is free, click what is fixed, stop at the
// first screen that actually needs a decision. No model is asked, and nothing
// risky is guessed - if a step is not clearly mechanical this returns with the
// live envelope so a caller can decide.
export async function advance(game,{dir,control=dir,max=20,record=recorder(dir)}={}){
  if(!Number.isInteger(max)||max<1||max>50)throw Error('max must be 1..50');
  let s=await game.settled(),steps=0;
  for(;steps<max;steps++){
    const options=actions(s),plan=mechanicalPlan(s,options);
    if(!plan)return {reason:'needs_decision',steps,...envelope(s)};
    const option=plan.options[0];
    const next=await execute(game,stateId(s),option.id,{dir,control,record,source:'mechanical'});
    await record({event:'mechanical_step',source:'mechanical',reason:plan.reason,
      action:option.command.action,state_type:s.state_type});
    s=next.state;
    if(inCombat(s))return {reason:'combat_started',steps:steps+1,...envelope(s)};
  }
  return {reason:'step_budget',steps,...envelope(s)};
}
