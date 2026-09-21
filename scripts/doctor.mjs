// Diagnose a machine before blaming the game.
//
// Installing the mod is the one step a plugin cannot do for you: the files go
// into the game's own bundle, the game must be closed, and the path differs per
// platform and per Steam library. That is also where a new user gets stuck, so
// it is worth a command that reports exactly what it found instead of a README
// that assumes it.
//
// Default run is read-only. `--install-mod` copies the two mod files after
// verifying them against the package's own SHA256SUMS, and refuses while the
// game is running. It never touches saves.
import {readFile,copyFile,mkdir,access} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';

const GAME_DIR_NAME='Slay the Spire 2';
const MAC_MOD_SUBPATH=join('SlayTheSpire2.app','Contents','MacOS','mods');
const MOD_FILES=['STS2_MCP.dll','STS2_MCP.json'];

const exists=async path=>{try{await access(path);return true;}catch{return false;}};

// Steam keeps one list of library roots; the game can live in any of them.
export function steamLibraries(home=homedir()){
  return [
    join(home,'Library','Application Support','Steam'),      // macOS
    join(home,'.steam','steam'),                             // Linux
    join(home,'.local','share','Steam'),
    'C:\\Program Files (x86)\\Steam'                          // Windows
  ];
}

export function parseLibraryFolders(vdf){
  // The file is Valve's own KV format; only the "path" values matter here.
  const paths=[];
  const re=/"path"\s*"([^"]+)"/g;
  let match;
  while((match=re.exec(vdf)))paths.push(match[1]);
  return paths;
}

export async function gameDirCandidates({home=homedir(),env=process.env}={}){
  const roots=[];
  if(env.STS2_GAME_DIR)roots.push(env.STS2_GAME_DIR);
  for(const library of steamLibraries(home)){
    roots.push(join(library,'steamapps','common',GAME_DIR_NAME));
    try{
      const vdf=await readFile(join(library,'steamapps','libraryfolders.vdf'),'utf8');
      for(const extra of parseLibraryFolders(vdf))
        roots.push(join(extra,'steamapps','common',GAME_DIR_NAME));
    }catch(error){if(error.code!=='ENOENT')throw error;}
  }
  return [...new Set(roots)];
}

export function modDirFor(gameDir){
  if(process.platform==='darwin')return join(gameDir,MAC_MOD_SUBPATH);
  return join(gameDir,'mods');
}

export async function hashFile(path){
  const {createHash}=await import('node:crypto');
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

export async function findGameDir(candidates){
  for(const candidate of candidates)if(await exists(candidate))return candidate;
  return null;
}

// The package ships SHA256SUMS; a mod that does not match it is not the mod we
// tested, so the install stops rather than quietly replacing it.
export async function readChecksums(packageDir){
  let text;
  try{
    text=await readFile(join(packageDir,'SHA256SUMS'),'utf8');
  }catch(error){
    if(error.code==='ENOENT')
      throw Error(`No SHA256SUMS in ${packageDir}; the mod cannot be verified, so it will not be installed`);
    throw error;
  }
  const sums={};
  for(const line of text.split('\n')){
    const match=line.trim().match(/^([0-9a-f]{64})\s+(.+)$/);
    if(match)sums[match[2].trim()]=match[1];
  }
  return sums;
}

export async function bridgeProbe(endpoint='http://127.0.0.1:15526/api/v1/singleplayer',{timeoutMs=3000}={}){
  const base=new URL(endpoint);
  const root=`${base.protocol}//${base.host}/`;
  try{
    const response=await fetch(root,{signal:AbortSignal.timeout(timeoutMs)});
    const body=await response.json().catch(()=>null);
    return {reachable:response.ok,status:response.status,message:body?.message??null};
  }catch(error){
    return {reachable:false,status:null,message:null,error:error.name==='TimeoutError'?'timeout':error.message};
  }
}

export function gameLooksRunning(processList){
  return /SlayTheSpire2|Slay the Spire 2/i.test(processList);
}

export async function diagnose({home=homedir(),env=process.env,endpoint}={}){
  const problems=[],notes=[];
  const nodeOk=Number(process.versions.node.split('.')[0])>=22;
  if(!nodeOk)problems.push(`Node ${process.versions.node} is older than 22`);

  const candidates=await gameDirCandidates({home,env});
  const gameDir=await findGameDir(candidates);
  const modDir=gameDir?modDirFor(gameDir):null;
  const modState={};
  if(modDir){
    for(const file of MOD_FILES)modState[file]=await exists(join(modDir,file));
  }
  const installed=modDir?MOD_FILES.every(file=>modState[file]):false;
  if(!gameDir)problems.push('No Slay the Spire 2 install found; set STS2_GAME_DIR to point at it');
  else if(!installed)problems.push(`The mod is not installed in ${modDir}`);

  const bridge=await bridgeProbe(endpoint);

  return {
    node:{version:process.versions.node,ok:nodeOk},
    platform:`${process.platform}-${process.arch}`,
    game:{found:Boolean(gameDir),directory:gameDir,mod_directory:modDir,files:modState,installed,searched:candidates},
    bridge,
    problems,notes,
    next_steps:problems.length?[
      gameDir?null:'Set STS2_GAME_DIR, or install the game through Steam first',
      installed?null:'Download the release from https://github.com/enderzcx/sts2-bridge/releases and run: spirectl doctor --install-mod <package-dir>',
      bridge.reachable?null:'Start the game; the mod serves the bridge once the game is running'
    ].filter(Boolean):[]
  };
}

export async function installMod(packageDir,{home=homedir(),env=process.env,yes=false,listProcesses=null}={}){
  if(!yes)throw Error('Refusing to write into the game without --yes; run once without it to see the plan');
  const sums=await readChecksums(packageDir);
  const plan=[];
  for(const file of MOD_FILES){
    const source=join(packageDir,file);
    if(!await exists(source))throw Error(`Package is missing ${file}`);
    const digest=await hashFile(source);
    const expected=sums[file];
    if(expected&&expected!==digest)
      throw Error(`${file} does not match SHA256SUMS (expected ${expected}, got ${digest})`);
    plan.push({file,source,sha256:digest,verified:Boolean(expected)});
  }
  if(listProcesses){
    const running=await listProcesses();
    if(gameLooksRunning(running))
      throw Error('Slay the Spire 2 is running; close it before installing the mod');
  }
  const gameDir=await findGameDir(await gameDirCandidates({home,env}));
  if(!gameDir)throw Error('No Slay the Spire 2 install found; set STS2_GAME_DIR');
  const modDir=modDirFor(gameDir);
  await mkdir(modDir,{recursive:true});
  const written=[];
  for(const entry of plan){
    const target=join(modDir,entry.file);
    const before=await exists(target)?await hashFile(target):null;
    await copyFile(entry.source,target);
    written.push({...entry,target,previous_sha256:before});
  }
  return {game_directory:gameDir,mod_directory:modDir,written,
    note:'Saves were not touched. Launch the game, then run: spirectl state'};
}

async function main(){
  const args=process.argv.slice(2);
  const flag=name=>{const i=args.indexOf(name);return i>=0?args[i+1]??true:null;};
  if(args.includes('--install-mod')){
    const packageDir=flag('--install-mod');
    if(typeof packageDir!=='string')throw Error('--install-mod needs a package directory');
    const {execFile}=await import('node:child_process');
    const listProcesses=()=>new Promise(resolve=>execFile('ps',['-ax'],(error,stdout)=>resolve(stdout??'')));
    return installMod(packageDir,{yes:args.includes('--yes'),listProcesses});
  }
  return diagnose({endpoint:process.env.SPIRE_API_URL});
}

if(import.meta.url===`file://${process.argv[1]}`){
  main().then(r=>console.log(JSON.stringify(r,null,2)))
    .catch(e=>{console.error(JSON.stringify({error:e.message}));process.exitCode=1;});
}
