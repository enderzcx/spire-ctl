// Fast tactical model adapter. The program stays in charge of legality and of
// everything that can be computed: this module only turns a state plus the
// advertised options into one of those options.
import {buildInput,NEXT_ACTION_INSTRUCTIONS} from './input.mjs';
import {chooseCandidate,candidateQuestions,CANDIDATE_INSTRUCTIONS} from './planning.mjs';

export async function choose(state,options,{apiKey=process.env.TYPESAFE_API_KEY,fetcher=fetch,signal,
  shortlist=null,criteria:providedCriteria=null,effects={},providedInput=null,candidates=null,strategy=null}={}) {
  if(!apiKey)throw Error('TYPESAFE_API_KEY is missing');
  if(!options.length)throw Error('No options offered; the caller must not ask for a choice');
  // A filtered, English, semantically-labelled state: jev-1.13 reads literal
  // conditions and English better than dense Chinese numeric text, and the
  // documentation warns that irrelevant detail harms the judgment. The game UI
  // is untouched; this is only what the question needs.
  const input=providedInput??buildInput(state,options,{store:effects});
  // Criteria come from the filtered projection, not from the raw options, so the
  // request never carries an executable command surface.
  const criteria=providedCriteria??Object.fromEntries(input.options.map(option=>[option.id,option.label]));
  const instructions=NEXT_ACTION_INSTRUCTIONS;
  const started=performance.now();
  async function ask(menu=criteria){
    const res=await fetcher('https://api.typesafe.ai/v1/systemone',{method:'POST',
      headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},
      // `state` carries the game projection plus the advertised options (with
      // their computed numbers). All questions in the request see this one state.
      body:JSON.stringify({model:'jev-latest',state:input,questions:{next:{type:'choice',instructions,criteria:menu}}}),
      signal:signal?AbortSignal.any([signal,AbortSignal.timeout(8000)]):AbortSignal.timeout(8000)});
    if(!res.ok)throw Error(`Jev returned HTTP ${res.status}; no action sent`);
    const result=await res.json(),answer=result.answers?.next;
    if(!answer||!options.some(o=>o.id===answer.choice)||!Number.isFinite(answer.confidence))throw Error('Invalid Jev decision');
    return {option:options.find(o=>o.id===answer.choice),answer,model:result.model,usage:result.usage};
  }
  let requests=0;
  // Every request of this decision is billed, so usage is accumulated rather
  // than overwritten: the narrowed retry and the stability probe both cost.
  const usage={input_tokens:0,output_tokens:0};
  const askCounted=async menu=>{
    requests++;
    const result=await ask(menu);
    usage.input_tokens+=Number(result.usage?.input_tokens??0);
    usage.output_tokens+=Number(result.usage?.output_tokens??0);
    return result;
  };
  // Short-plan mode: one request asks the model to pick a candidate line and, in
  // the same batch, judges each candidate on a single independent dimension. The
  // program combines those answers and enforces survival itself; a model score
  // never overrides a hard constraint.
  if(candidates?.length>=2){
    const candidateCriteria=Object.fromEntries(candidates.map(candidate=>[
      candidate.id,
      `${candidate.title} | cost ${candidate.energy} energy | damage ${candidate.damage} | block ${candidate.block} | kills ${candidate.kills} | survives displayed attack: ${candidate.survives}`
    ]));
    // The safety question is only meaningful when the program's own arithmetic
    // says some line dies. On a turn every candidate survives, survival is not a
    // question to ask - it is already proven - so only the ranking question goes.
    const anyDies=candidates.some(candidate=>candidate.survives===false);
    const questions={plan:{type:'choice',instructions:CANDIDATE_INSTRUCTIONS,criteria:candidateCriteria},
      ...(anyDies?candidateQuestions(candidates):{})};
    const res=await fetcher('https://api.typesafe.ai/v1/systemone',{method:'POST',
      headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},
      body:JSON.stringify({model:'jev-latest',state:{...input,strategy:strategy??input.strategy},questions}),
      signal:signal?AbortSignal.any([signal,AbortSignal.timeout(8000)]):AbortSignal.timeout(8000)});
    if(!res.ok)throw Error(`Jev returned HTTP ${res.status}; no action sent`);
    const result=await res.json(),plan=result.answers?.plan;
    if(!plan||!candidates.some(candidate=>candidate.id===plan.choice))
      throw Error('Invalid candidate decision');
    const judgments={};
    for(const key of Object.keys(result.answers??{}))
      if(key!=='plan')judgments[key]=result.answers[key]?.noul;
    const picked=chooseCandidate(candidates,{choice:plan.choice},strategy??null);
    if(!picked?.candidate){
      // The program's own survival constraint eliminates every line. That is a
      // real planner decision, not a malformed answer, so it is reported rather
      // than thrown and certainly not overridden.
      return {option:null,answer:{...plan,nouls:judgments},
        candidate:null,no_surviving_candidate:true,
        usage:{input_tokens:Number(result.usage?.input_tokens??0),output_tokens:Number(result.usage?.output_tokens??0)},
        requests:1,inference_ms:Math.round(performance.now()-started),
        retried:false,narrowed:false,stable:false,planned:true,low_confidence_candidate:true};
    }
    // The same cutoff applies to a candidate answer as to a single-card answer.
    // If the model is not sure which line to take, the program reports that
    // instead of silently acting on an unsure choice; the independent judgments
    // are attached so the caller can escalate with evidence.
    // The threshold scales with the stakes, as the provider's own guidance
    // requires: a turn where the program proved every line survives is a
    // low-stakes ranking question, while a lethal turn, a low-HP position or an
    // unverified card is not. Safety never depends on this number - the survival
    // constraint above and the legality checks stay in code.
    const gate=Number(process.env.SPIRE_PLAN_MIN_CONFIDENCE??(anyDies?0.5:0.25));
    if(plan.confidence<gate){
      // One narrowed retry: the two most valuable lines only. A higher
      // confidence on a smaller menu is a better judgment, not a lowered bar,
      // so the retry still has to clear the same gate.
      const top=[...candidates].sort((a,b)=>b.damage-a.damage||b.block-a.block).slice(0,2);
      // On a turn where the program proved every line survives, an unsure answer
      // is usually "which style" rather than "is this safe". Ask that question
      // literally - attack line or defense line - and offer an explicit
      // "unclear" option so the model can still say it does not know instead of
      // being forced to guess.
      if(!anyDies&&top.length>1){
        const offense=[...top].sort((a,b)=>b.damage-a.damage)[0];
        const defense=[...top].sort((a,b)=>b.block-a.block)[0];
        if(offense.id!==defense.id){
          const binary={offense:`attack line: ${offense.title} | damage ${offense.damage} | block ${offense.block}`,
            defense:`defense line: ${defense.title} | damage ${defense.damage} | block ${defense.block}`,
            unclear:'neither line is better than the other with what is known'};
          const res2=await fetcher('https://api.typesafe.ai/v1/systemone',{method:'POST',
            headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},
            body:JSON.stringify({model:'jev-latest',state:input,questions:{style:{
              type:'choice',
              instructions:'Pick the line style to play this turn. "offense" means the listed attack line; "defense" means the listed block line. Choose "unclear" when the two lines are equally good or the state does not say which is better.',
              criteria:binary}}}),
            signal:signal?AbortSignal.any([signal,AbortSignal.timeout(8000)]):AbortSignal.timeout(8000)});
          if(res2.ok){
            const r2=await res2.json(),style=r2.answers?.style;
            const chosen=style?.choice==='offense'?offense:style?.choice==='defense'?defense:null;
            if(chosen){
              const step=chosen.steps[0];
              const styleOption=options.find(candidate=>candidate.id===step.option_id);
              if(styleOption)return {option:styleOption,answer:{...style,confidence:style.confidence??null,nouls:{}},
                candidate:{id:chosen.id,title:chosen.title,why:`style question: ${style.choice}`,
                  steps:chosen.steps.length,energy:chosen.energy,damage:chosen.damage},
                usage:{input_tokens:Number(result.usage?.input_tokens??0)+Number(r2.usage?.input_tokens??0),
                  output_tokens:Number(result.usage?.output_tokens??0)+Number(r2.usage?.output_tokens??0)},
                requests:2,inference_ms:Math.round(performance.now()-started),
                retried:true,narrowed:true,stable:false,planned:true};
            }
          }
        }
      }
      if(top.length>1&&candidates.length>top.length){
        const narrowCriteria=Object.fromEntries(top.map(candidate=>[candidate.id,candidateCriteria[candidate.id]]));
        const narrowQuestions={plan:{type:'choice',instructions:CANDIDATE_INSTRUCTIONS,criteria:narrowCriteria},
          ...(anyDies?candidateQuestions(top):{})};
        const retry=await fetcher('https://api.typesafe.ai/v1/systemone',{method:'POST',
          headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},
          body:JSON.stringify({model:'jev-latest',state:input,questions:narrowQuestions}),
          signal:signal?AbortSignal.any([signal,AbortSignal.timeout(8000)]):AbortSignal.timeout(8000)});
        if(retry.ok){
          const retryResult=await retry.json(),retryPlan=retryResult.answers?.plan;
          if(retryPlan&&top.some(candidate=>candidate.id===retryPlan.choice)&&retryPlan.confidence>=gate){
            const retryPick=chooseCandidate(top,{choice:retryPlan.choice},strategy??null);
            const step=retryPick?.candidate?.steps?.[0];
            const retryOption=step?options.find(candidate=>candidate.id===step.option_id):null;
            if(retryOption)return {option:retryOption,answer:{...retryPlan,nouls:{}},
              candidate:{id:retryPick.candidate.id,title:retryPick.candidate.title,why:`narrowed retry: ${retryPick.why}`,
                steps:retryPick.candidate.steps.length,energy:retryPick.candidate.energy,damage:retryPick.candidate.damage},
              usage:{input_tokens:Number(result.usage?.input_tokens??0)+Number(retryResult.usage?.input_tokens??0),
                output_tokens:Number(result.usage?.output_tokens??0)+Number(retryResult.usage?.output_tokens??0)},
              requests:2,inference_ms:Math.round(performance.now()-started),
              retried:true,narrowed:true,stable:false,planned:true};
          }
        }
      }
      return {option:null,
      answer:{...plan,nouls:judgments},
      candidate:{id:picked.candidate.id,title:picked.candidate.title,why:picked.why,
        steps:picked.candidate.steps.length,energy:picked.candidate.energy,damage:picked.candidate.damage,
        survives:picked.candidate.survives},
      usage:{input_tokens:Number(result.usage?.input_tokens??0),output_tokens:Number(result.usage?.output_tokens??0)},
      requests:1,inference_ms:Math.round(performance.now()-started),
      retried:false,narrowed:false,stable:false,planned:true,low_confidence_candidate:true};
    }
    const firstStep=picked.candidate.steps[0];
    const option=options.find(candidate=>candidate.id===firstStep.option_id);
    if(!option)throw Error('Candidate step is not an advertised option');
    return {option,answer:{...plan,nouls:judgments},
      candidate:{id:picked.candidate.id,title:picked.candidate.title,why:picked.why,
        steps:picked.candidate.steps.length,energy:picked.candidate.energy,damage:picked.candidate.damage},
      usage:{input_tokens:Number(result.usage?.input_tokens??0),output_tokens:Number(result.usage?.output_tokens??0)},
      requests:1,inference_ms:Math.round(performance.now()-started),
      retried:false,narrowed:false,stable:false,planned:true};
  }

  const first=await askCounted(criteria);
  let answer=first;

  // A low-confidence answer over the whole hand is not evidence that the
  // situation needs a planner. When the program can narrow the choice to a few
  // defensible actions, ask again with that smaller menu instead of lowering
  // the bar or escalating. The cutoff is unchanged.
  if(answer.answer.confidence<.5&&shortlist?.options?.length){
    const narrowed=options.filter(option=>shortlist.options.some(o=>o.id===option.id));
    if(narrowed.length&&narrowed.length<options.length){
      const menu=Object.fromEntries(narrowed.map(o=>[o.id,`${o.label} [program: ${shortlist.reason}]`]));
      const retry=await askCounted(menu);
      if(retry.answer.confidence>=answer.answer.confidence)
        answer={...retry,narrowed:true,shortlist_reason:shortlist.reason};
    }
  }

  // Still below the cutoff: ask once more on the same menu. Two identical
  // answers give the caller a stability signal it can verify; this module never
  // lowers the bar itself and still reports the original low confidence.
  if(answer.answer.confidence<.5){
    const probe=await askCounted(answer.narrowed
      ? Object.fromEntries(options.filter(o=>shortlist.options.some(s=>s.id===o.id)).map(o=>[o.id,`${o.label} [program: ${shortlist.reason}]`]))
      : criteria);
    answer={...answer,stable:probe.answer.choice===answer.answer.choice,
      second_confidence:probe.answer.confidence,model:probe.model??answer.model};
  }

  return {...answer,requests,usage,inference_ms:Math.round(performance.now()-started),
    retried:Boolean(answer.narrowed),narrowed:Boolean(answer.narrowed),stable:answer.stable??false};
}
