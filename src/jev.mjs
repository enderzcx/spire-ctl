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
    const questions={plan:{type:'choice',instructions:CANDIDATE_INSTRUCTIONS,criteria:candidateCriteria},
      ...candidateQuestions(candidates)};
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
    if(!picked?.candidate)throw Error('No candidate satisfies the survival constraint');
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
