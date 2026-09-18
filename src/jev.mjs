// Thin Jev transport: one request, validate, account. No tactical fallback,
// no stability probe, no menu shrinking. The caller owns whether to act.
import {buildInput,NEXT_ACTION_INSTRUCTIONS} from './input.mjs';
import {CANDIDATE_INSTRUCTIONS} from './planning.mjs';

function validConfidence(value){
  return Number.isFinite(value)&&value>=0&&value<=1;
}

function accumulate(usage,extra){
  usage.input_tokens+=Number(extra?.input_tokens??0);
  usage.output_tokens+=Number(extra?.output_tokens??0);
}

export async function choose(state,options,{apiKey=process.env.TYPESAFE_API_KEY,fetcher=fetch,signal,
  shortlist=null,effects={},providedInput=null,candidates=null,strategy=null}={}){
  if(!apiKey)throw Error('TYPESAFE_API_KEY is missing');
  if(!options.length)throw Error('No options offered; the caller must not ask for a choice');
  const input=providedInput??buildInput(state,options,{store:effects,policy:strategy??null});
  if(candidates?.length)input.candidates=candidates;
  if(shortlist)input.program_notes=shortlist.reason??null;
  const usage={input_tokens:0,output_tokens:0};
  const started=performance.now();
  const planned=Array.isArray(candidates)&&candidates.length>=2;
  const criteria=planned
    ?Object.fromEntries(candidates.map(candidate=>[
      candidate.id,
      `${candidate.title} | cards ${candidate.steps.map(step=>step.card?.name??step.card_index).join(' then ')} | cost ${candidate.energy} energy | damage ${candidate.damage} | block ${candidate.block} | kills ${candidate.kills} | survives displayed attack: ${candidate.survives}`
    ]))
    :Object.fromEntries(input.options.map(option=>[option.id,option.label]));
  const questions=planned
    ?{plan:{type:'choice',instructions:CANDIDATE_INSTRUCTIONS,criteria}}
    :{next:{type:'choice',instructions:NEXT_ACTION_INSTRUCTIONS,criteria}};
  const res=await fetcher('https://api.typesafe.ai/v1/systemone',{method:'POST',
    headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},
    body:JSON.stringify({model:'jev-latest',state:input,questions}),
    signal:signal?AbortSignal.any([signal,AbortSignal.timeout(8000)]):AbortSignal.timeout(8000)});
  if(!res.ok)throw Error(`Jev returned HTTP ${res.status}; no action sent`);
  const result=await res.json();
  accumulate(usage,result.usage);
  const key=planned?'plan':'next';
  const answer=result.answers?.[key];
  if(!answer||!validConfidence(answer.confidence))throw Error('Invalid Jev decision');
  if(planned){
    const candidate=candidates.find(entry=>entry.id===answer.choice);
    if(!candidate)throw Error('Invalid Jev decision');
    const first=candidate.steps[0];
    const option=options.find(entry=>entry.id===first.option_id);
    if(!option)throw Error('Candidate step is not an advertised option');
    return {
      option,answer,candidate,model:result.model,usage,requests:1,
      inference_ms:Math.round(performance.now()-started),
      retried:false,narrowed:false,stable:false,planned:true
    };
  }
  if(!options.some(option=>option.id===answer.choice))throw Error('Invalid Jev decision');
  return {
    option:options.find(option=>option.id===answer.choice),answer,model:result.model,usage,requests:1,
    inference_ms:Math.round(performance.now()-started),
    retried:false,narrowed:false,stable:false,planned:false
  };
}
