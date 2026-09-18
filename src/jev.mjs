// Thin Jev transport: one request, validate, account. Failures still count.
import {buildInput,NEXT_ACTION_INSTRUCTIONS} from './input.mjs';
import {CANDIDATE_INSTRUCTIONS} from './planning.mjs';

function validConfidence(value){
  return Number.isFinite(value)&&value>=0&&value<=1;
}

function fail(message,requests,usage={unavailable:true}){
  const error=Error(message);
  error.requests=requests;
  error.usage=usage;
  throw error;
}

export async function choose(state,options,{apiKey=process.env.TYPESAFE_API_KEY,fetcher=fetch,signal,
  shortlist=null,effects={},providedInput=null,candidates=null,strategy=null}={}){
  if(!apiKey)throw Error('TYPESAFE_API_KEY is missing');
  if(!options.length)throw Error('No options offered; the caller must not ask for a choice');
  const input=providedInput??buildInput(state,options,{store:effects,policy:strategy??null});
  if(candidates?.length)input.candidates=candidates;
  if(shortlist)input.program_notes=shortlist.reason??null;
  const started=performance.now();
  const planned=Array.isArray(candidates)&&candidates.length>=2;
  const criteria=planned
    ?Object.fromEntries(candidates.map(candidate=>[
      candidate.id,
      `${candidate.title} | ${candidate.kind??'line'} | verified ${candidate.verified} | cost ${candidate.energy} | damage ${candidate.damage} | block ${candidate.block} | kills ${candidate.kills} | survives: ${candidate.survives}`
    ]))
    :Object.fromEntries(input.options.map(option=>[option.id,option.label]));
  const questions=planned
    ?{plan:{type:'choice',instructions:CANDIDATE_INSTRUCTIONS,criteria}}
    :{next:{type:'choice',instructions:NEXT_ACTION_INSTRUCTIONS,criteria}};
  let requests=0;
  let res;
  try{
    requests+=1;
    res=await fetcher('https://api.typesafe.ai/v1/systemone',{method:'POST',
      headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},
      body:JSON.stringify({model:'jev-latest',state:input,questions}),
      signal:signal?AbortSignal.any([signal,AbortSignal.timeout(8000)]):AbortSignal.timeout(8000)});
  }catch(error){
    fail(error.message||'Jev request failed',requests);
  }
  if(!res.ok)fail(`Jev returned HTTP ${res.status}; no action sent`,requests);
  const result=await res.json();
  const usage=result.usage&&Number.isFinite(Number(result.usage.input_tokens))
    ?{input_tokens:Number(result.usage.input_tokens??0),output_tokens:Number(result.usage.output_tokens??0)}
    :{unavailable:true};
  const key=planned?'plan':'next';
  const answer=result.answers?.[key];
  if(!answer||!validConfidence(answer.confidence))fail('Invalid Jev decision',requests,usage);
  const meta={model:result.model,usage,requests,inference_ms:Math.round(performance.now()-started),
    retried:false,narrowed:false,stable:false,planned};
  if(planned){
    const candidate=candidates.find(entry=>entry.id===answer.choice);
    if(!candidate)fail('Invalid Jev decision',requests,usage);
    const option=options.find(entry=>entry.id===(candidate.option_id??candidate.steps?.[0]?.option_id));
    return {option:option??null,answer,candidate,...meta};
  }
  if(!options.some(option=>option.id===answer.choice))fail('Invalid Jev decision',requests,usage);
  return {option:options.find(option=>option.id===answer.choice),answer,...meta};
}
