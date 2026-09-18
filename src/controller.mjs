import {resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {access,rm} from 'node:fs/promises';
import {createGame,stateId} from './game.mjs';
import {envelope,withLock,execute,battle,advance} from './runner.mjs';
import {runPlan,projection} from './plan.mjs';
import {choose} from './jev.mjs';

// Shared public seam for CLI and harness plugins; no planner vendor dependency.
export function createController({endpoint=process.env.SPIRE_API_URL??'http://127.0.0.1:15526/api/v1/singleplayer',
  runtimeDir=process.env.SPIRE_RUNTIME_DIR??'.runtime',apiKey=process.env.TYPESAFE_API_KEY,
  decide=choose,openGame=null,controlDir=null}={}){
  const dir=resolve(runtimeDir),url=new URL(endpoint);
  createGame(endpoint);
  const control=controlDir??join(homedir(),'.local','state','spire-jev',`loopback-${url.port||80}`);
  const game=signal=>openGame?openGame(signal):createGame(endpoint,fetch,signal);
  async function mutate(signal,fn){
    signal?.throwIfAborted();
    for(const name of ['HALTED','execution.lock']){
      try{await access(join(dir,name));throw Error('Legacy controller state exists; inspect pending actions before migrating');}
      catch(e){if(e.code!=='ENOENT')throw e;}
    }
    return withLock(control,()=>fn(game(signal),{dir,control}));
  }
  return {
    async state({signal}={}){signal?.throwIfAborted();const s=await game(signal).read();return {...envelope(s),planning_state:projection(s)};},
    act:(expected,id,{signal,source='caller'}={})=>mutate(signal,(g,opts)=>execute(g,expected,id,{...opts,source})),
    // The fast-model seam is injectable so the shortlist hand-off can be tested
    // without a provider; production keeps the real adapter.
    battle:(max=60,{signal}={})=>mutate(signal,(g,opts)=>battle(g,(s,o,shortlist,extra={})=>decide(s,o,{apiKey,signal,shortlist,...extra}),{...opts,max})),
    plan:(plan,{signal}={})=>mutate(signal,(g,opts)=>runPlan(g,plan,opts)),
    // Mechanical progress only: free claims, fixed buttons, then stop.
    advance:(max=20,{signal}={})=>mutate(signal,(g,opts)=>advance(g,{...opts,max})),
    clearHalt:(expected,{signal}={})=>mutate(signal,async g=>{
      const s=await g.read();if(stateId(s)!==expected)throw Error('State changed');
      await rm(join(control,'HALTED'),{force:true});return{cleared:true,...envelope(s)};
    })
  };
}
