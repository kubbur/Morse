// Publish the two tested artifacts of one Dev run using the existing Mac Keychain signer.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { root } from './stage.mjs';

const runId = process.argv[2];
if (process.platform !== 'darwin' || !/^[1-9]\d*$/.test(runId) || process.argv.length !== 3)
  throw Error('Usage on the publishing Mac: node scripts/publish-dev.mjs GITHUB_RUN_ID');
const repo = 'kubbur/Morse', api = 'repos/' + repo;
const gh = (...args) => execFileSync('gh', args, {encoding:'utf8', maxBuffer:8 * 1024 * 1024});
const run = JSON.parse(gh('api', api + '/actions/runs/' + runId));
assert.ok(run.head_repository.full_name === repo && run.head_branch === 'dev' && ['push','workflow_dispatch'].includes(run.event) &&
  run.path === '.github/workflows/build-mac.yml' && run.status === 'completed' && run.conclusion === 'success', 'Expected a successful Dev Mac workflow');
const sha = run.head_sha;
assert.match(sha, /^[a-f0-9]{40}$/);
assert.equal(gh('api', api + '/compare/' + sha + '...dev', '--jq', '.merge_base_commit.sha').trim(), sha, 'Build must be part of dev');
const work = await mkdtemp(join(tmpdir(), 'morse-publish-dev-'));
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
try {
  let version;
  const files = [];
  for (const arch of ['arm64','x64']) {
    const dir = join(work, arch);
    gh('run','download',runId,'--repo',repo,'--name','Morse-mac-' + arch,'--dir',dir);
    const report = JSON.parse(await readFile(join(dir,'darwin-build.json'),'utf8'));
    assert.match(report.version, /^\d+\.\d+\.\d+-dev\.[1-9]\d*$/);
    assert.equal(report.version.split('-dev.')[1], String(run.run_number));
    version ??= report.version;
    assert.equal(report.version, version);
    const name = 'Morse-' + version + '-mac-' + arch + '.zip';
    const build = report.builds.find(row => row.architecture === arch);
    assert.equal(build?.file, name);
    const file = join(work,name);
    await rename(join(dir,name),file);
    assert.equal(await digest(file),build.sha256);
    files.push(file, join(work,'appcast-mac-' + arch + '.xml'));
  }
  const buildDir = join(root,'build');
  await mkdir(buildDir,{recursive:true});
  // Sign using the publishing Mac. CI only receives a public key.
  const helper = join(buildDir,'MorseReleaseKey');
  try { await access(helper,constants.X_OK); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    execFileSync('xcrun',['swiftc','-O',join(root,'scripts/sparkle-key.swift'),'-o',helper]);
  }
  execFileSync(process.execPath,[join(root,'scripts/appcast.mjs'),'--keychain','--dev-version',version,work],{stdio:'inherit'});

  const tag = 'morse-v' + version;
  const tagRef = spawnSync('gh',['api',api + '/git/ref/tags/' + tag,'--jq','.object.sha'],{encoding:'utf8'});
  if (!tagRef.status) assert.equal(tagRef.stdout.trim(),sha,'Existing Dev tag points to another commit');
  else if (!tagRef.stderr?.includes('404')) throw Error(tagRef.stderr || 'Could not verify Dev tag');
  const fields = 'databaseId,isDraft,isPrerelease,targetCommitish';
  const view = ['release','view',tag,'--repo',repo,'--json',fields];
  const existing = spawnSync('gh',view,{encoding:'utf8'});
  if (existing.status) {
    if (!/release not found|HTTP 404/i.test(existing.stderr)) throw Error(existing.stderr || 'Could not inspect Dev release');
    gh('release','create',tag,'--repo',repo,'--draft','--prerelease','--latest=false','--target',sha,'--title','Morse ' + version,
      '--notes','Dev build from ' + sha + '. Built and tested on Apple Silicon and Intel. https://github.com/' + repo + '/actions/runs/' + runId);
  }
  const release = JSON.parse(gh(...view));
  assert.ok(release.isPrerelease && release.targetCommitish === sha, 'Release must be a Dev prerelease for this commit');
  const assets = () => JSON.parse(gh('api',api + '/releases/' + release.databaseId + '/assets?per_page=100'));
  const before = assets(), hashes = new Map();
  for (const file of files) {
    const name = basename(file), hash = 'sha256:' + await digest(file);
    hashes.set(name,hash);
    const match = before.find(asset => asset.name === name);
    if (match) assert.equal(match.digest,hash,'Existing asset differs: ' + name);
    else {
      assert.ok(release.isDraft, 'A published build cannot be amended');
      gh('release','upload',tag,file,'--repo',repo);
    }
  }
  const uploaded = assets();
  for (const [name,hash] of hashes) assert.equal(uploaded.find(asset => asset.name === name)?.digest,hash,name);
  if (release.isDraft) gh('release','edit',tag,'--repo',repo,'--draft=false','--prerelease','--latest=false');
  const result = JSON.parse(gh(...view));
  assert.ok(!result.isDraft && result.isPrerelease);
  console.log('https://github.com/' + repo + '/releases/tag/' + tag);
} finally {
  await rm(work, {recursive:true, force:true});
}
