// Fast tactical model adapter. The program stays in charge of legality and of
// everything that can be computed: this module only turns a state plus the
// advertised options into one of those options.
export async function choose(state,options,{apiKey=process.env.TYPESAFE_API_KEY,fetcher=fetch,signal,
  shortlist=null,criteria:providedCriteria=null}={}) {
  if(!apiKey)throw Error('TYPESAFE_API_KEY is missing');
  if(!options.length)throw Error('No options offered; the caller must not ask for a choice');
  const criteria=providedCriteria??Object.fromEntries(options.map(o=>[o.id,o.label]));
  const p=state.player;
  const input={battle:state.battle,player:{hp:p.hp,max_hp:p.max_hp,block:p.block,energy:p.energy,
    hand:p.hand,status:p.status,orbs:p.orbs,orb_slots:p.orb_slots,relics:p.relics,draw_pile:p.draw_pile,discard_pile:p.discard_pile}};
  const instructions='Choose the best next action to survive and win this Slay the Spire 2 combat. Prioritize guaranteed lethal damage. Account for enemy intents, vulnerable/weak, block, energy, setup and draw. Do not waste energy on redundant defense or end turn with useful cards remaining.';
  const started=performance.now();
  async function ask(menu=criteria){
    const res=await fetcher('https://api.typesafe.ai/v1/systemone',{method:'POST',
      headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},
      body:JSON.stringify({model:'jev-latest',state:input,questions:{next:{type:'choice',instructions,criteria:menu}}}),
      signal:signal?AbortSignal.any([signal,AbortSignal.timeout(8000)]):AbortSignal.timeout(8000)});
    if(!res.ok)throw Error(`Jev returned HTTP ${res.status}; no action sent`);
    const result=await res.json(),answer=result.answers?.next;
    if(!answer||!options.some(o=>o.id===answer.choice)||!Number.isFinite(answer.confidence))throw Error('Invalid Jev decision');
    return {option:options.find(o=>o.id===answer.choice),answer,model:result.model,usage:result.usage};
  }
  const first=await ask(criteria);
  let answer=first;

  // A low-confidence answer over the whole hand is not evidence that the
  // situation needs a planner. When the program can narrow the choice to a few
  // defensible actions, ask again with that smaller menu instead of lowering
  // the bar or escalating. The cutoff is unchanged.
  if(answer.answer.confidence<.5&&shortlist?.options?.length){
    const narrowed=options.filter(option=>shortlist.options.some(o=>o.id===option.id));
    if(narrowed.length&&narrowed.length<options.length){
      const menu=Object.fromEntries(narrowed.map(o=>[o.id,`${o.label} [program: ${shortlist.reason}]`]));
      const retry=await ask(menu);
      if(retry.answer.confidence>=answer.answer.confidence)
        answer={...retry,narrowed:true,shortlist_reason:shortlist.reason};
    }
  }

  // Still below the cutoff: ask once more on the same menu. Two identical
  // answers give the caller a stability signal it can verify; this module never
  // lowers the bar itself and still reports the original low confidence.
  if(answer.answer.confidence<.5){
    const probe=await ask(answer.narrowed
      ? Object.fromEntries(options.filter(o=>shortlist.options.some(s=>s.id===o.id)).map(o=>[o.id,`${o.label} [program: ${shortlist.reason}]`]))
      : criteria);
    answer={...answer,stable:probe.answer.choice===answer.answer.choice,
      second_confidence:probe.answer.confidence,model:probe.model??answer.model};
  }

  return {...answer,inference_ms:Math.round(performance.now()-started),
    retried:Boolean(answer.narrowed),narrowed:Boolean(answer.narrowed),stable:answer.stable??false};
}
