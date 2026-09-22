import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

// node-semver only lets a prerelease satisfy a range when some comparator sits
// on that exact major.minor.patch tuple AND carries a prerelease tag. A range
// that merely "looks broad" therefore rejects every prerelease build of the
// host, and the user meets an ERESOLVE instead of a plugin. The range must have
// an explicit prerelease branch for the tuples people actually run.
test('the harness peer range admits prereleases of the versions in use',async()=>{
  const pkg=JSON.parse(await readFile(join(fileURLToPath(new URL('..',import.meta.url)),'package.json'),'utf8'));
  const range=pkg.peerDependencies['@deepseek-ai/dsh-tools'];
  assert.match(range,/rc/,'a range with no prerelease comparator excludes every prerelease host');
  assert.ok(pkg.peerDependenciesMeta['@deepseek-ai/dsh-tools'].optional,
    'a harness without DSH must still be able to install the CLI');
});
