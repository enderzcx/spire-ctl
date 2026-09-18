#!/usr/bin/env node
import {resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {rm,readFile,access} from 'node:fs/promises';
import {createGame,stateId} from '../src/game.mjs';
import {envelope,withLock,execute,battle} from '../src/runner.mjs';
import {choose} from '../src/jev.mjs';
import {runPlan,projection} from '../src/plan.mjs';

const [command,...args]=process.argv.slice(2),dir=resolve(process.env.SPIRE_RUNTIME_DIR??'.runtime');
const bridgeURL=new URL(process.env.SPIRE_API_URL??'http://127.0.0.1:15526/api/v1/singleplayer');
// Same bridge shares a lock/halt across checkouts and custom log directories.
const control=join(homedir(),'.local','state','spire-jev',`loopback-${bridgeURL.port||80}`);
const game=createGame();
async function main(){
  if(command==='state'){const s=await game.read();return {...envelope(s),planning_state:projection(s)};}
  for(const name of ['HALTED','execution.lock']){
    try{await access(join(dir,name));throw Error('Legacy controller state exists; stop its process and inspect pending actions before migrating');}
    catch(e){if(e.code!=='ENOENT')throw e;}
  }
  if(command==='plan'){
    if(args.length!==1)throw Error('Usage: plan PLAN.json');
    const plan=JSON.parse(await readFile(args[0],'utf8'));
    return withLock(control,()=>runPlan(game,plan,{dir,control}));
  }
  if(command==='act'){
    if(args.length!==2)throw Error('Usage: act STATE_ID OPTION_ID (from state)');
    return withLock(control,()=>execute(game,args[0],args[1],{dir,control}));
  }
  if(command==='battle')return withLock(control,()=>battle(game,choose,{dir,control,max:Number(args[0]??60)}));
  if(command==='clear-halt'){
    if(args.length!==1)throw Error('Read and inspect state, then clear-halt STATE_ID');
    return withLock(control,async()=>{const s=await game.read();if(stateId(s)!==args[0])throw Error('State changed');await rm(join(control,'HALTED'),{force:true});return {cleared:true,...envelope(s)};});
  }
  return {usage:['state','act STATE_ID OPTION_ID','plan PLAN.json','battle [MAX_STEPS]','clear-halt STATE_ID'],note:'Local single-player game required. Read docs/AGENT.md before playing.'};
}
main().then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(JSON.stringify({error:e.message}));process.exitCode=1;});
