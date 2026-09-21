import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseLibraryFolders,gameDirCandidates,modDirFor,readChecksums,installMod,gameLooksRunning} from '../scripts/doctor.mjs';

const temp=async fn=>{const dir=await mkdtemp(join(tmpdir(),'doctor-'));try{return await fn(dir);}catch(e){throw e;}};

test('Steam library paths are read from Valve\'s own list',()=>{
  const vdf=`"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t"/Users/x/Library/Application Support/Steam"\n\t}\n\t"1"\n\t{\n\t\t"path"\t"/Volumes/External/SteamLibrary"\n\t}\n}`;
  assert.deepEqual(parseLibraryFolders(vdf),['/Users/x/Library/Application Support/Steam','/Volumes/External/SteamLibrary']);
  assert.deepEqual(parseLibraryFolders('nothing here'),[]);
});

test('the game is looked for in every library, and STS2_GAME_DIR wins',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'steam-'));
  const library=join(dir,'Library','Application Support','Steam','steamapps');
  await mkdir(library,{recursive:true});
  await writeFile(join(library,'libraryfolders.vdf'),'"path"\t"/Volumes/Other/SteamLibrary"');
  const candidates=await gameDirCandidates({home:dir,env:{STS2_GAME_DIR:'/games/Spire'}});
  assert.equal(candidates[0],'/games/Spire','an explicit directory is tried first');
  assert.ok(candidates.some(c=>c==='/Volumes/Other/SteamLibrary/steamapps/common/Slay the Spire 2'),
    'a secondary Steam library is included');
  assert.ok(candidates.some(c=>c.includes(join('steamapps','common','Slay the Spire 2'))));
});

test('the mod directory differs per platform but is derived from the game dir',()=>{
  const dir=modDirFor('/games/Spire');
  if(process.platform==='darwin')assert.match(dir,/SlayTheSpire2\.app\/Contents\/MacOS\/mods$/);
  else assert.match(dir,/\/mods$/);
});

test('a package whose file does not match its own checksum is refused',async()=>{
  await temp(async dir=>{
    const pkg=join(dir,'pkg');await mkdir(pkg,{recursive:true});
    await writeFile(join(pkg,'STS2_MCP.dll'),'not the dll');
    await writeFile(join(pkg,'STS2_MCP.json'),'{}');
    await writeFile(join(pkg,'SHA256SUMS'),'0'.repeat(64)+'  STS2_MCP.dll\n');
    const sums=await readChecksums(pkg);
    assert.equal(sums['STS2_MCP.dll'],'0'.repeat(64));
    const game=join(dir,'game');await mkdir(join(game,'SlayTheSpire2.app','Contents','MacOS','mods'),{recursive:true});
    await assert.rejects(
      ()=>installMod(pkg,{env:{STS2_GAME_DIR:game},yes:true}),
      /does not match SHA256SUMS/,'a tampered file never reaches the game');
  });
});

test('installing refuses without confirmation, and while the game is running',async()=>{
  await temp(async dir=>{
    const pkg=join(dir,'pkg');await mkdir(pkg,{recursive:true});
    await writeFile(join(pkg,'STS2_MCP.dll'),'dll');
    await writeFile(join(pkg,'STS2_MCP.json'),'{}');
    await writeFile(join(pkg,'SHA256SUMS'),'');
    const game=join(dir,'game');
    await mkdir(join(game,'SlayTheSpire2.app','Contents','MacOS','mods'),{recursive:true});
    await assert.rejects(()=>installMod(pkg,{env:{STS2_GAME_DIR:game}}),/without --yes/);
    await assert.rejects(
      ()=>installMod(pkg,{env:{STS2_GAME_DIR:game},yes:true,listProcesses:async()=>'/Applications/SlayTheSpire2.app/Contents/MacOS/Slay the Spire 2'}),
      /close it before installing/);
    const result=await installMod(pkg,{env:{STS2_GAME_DIR:game},yes:true,listProcesses:async()=>''});
    assert.equal(result.written.length,2);
    assert.equal(await readFile(join(result.mod_directory,'STS2_MCP.json'),'utf8'),'{}');
  });
});

test('the running-game check matches the process names the platforms actually use',()=>{
  assert.ok(gameLooksRunning('/Applications/SlayTheSpire2.app/Contents/MacOS/Slay the Spire 2'));
  assert.ok(gameLooksRunning('Slay the Spire 2.exe'));
  assert.equal(gameLooksRunning('/usr/sbin/cupsd\n/usr/bin/ssh'),false);
});

test('a package without checksums is refused rather than trusted',async()=>{
  await temp(async dir=>{
    const pkg=join(dir,'pkg');await mkdir(pkg,{recursive:true});
    await writeFile(join(pkg,'STS2_MCP.dll'),'dll');
    await writeFile(join(pkg,'STS2_MCP.json'),'{}');
    await assert.rejects(()=>readChecksums(pkg),/cannot be verified/);
  });
});
