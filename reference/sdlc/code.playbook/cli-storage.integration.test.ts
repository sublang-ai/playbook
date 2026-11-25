// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFixtureManifest, readFixtureReplay, writeFixtureFile, writeFixtureReplay } from './test-support/session-persistence.js';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createSessionStore } from './session-store.js';
import { openSessionHost } from './session-host.js';
import { loadLaunchPlan } from './bin/launch-config.js';
import { executionConfigFromPlan } from './bin/run.js';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const cli = fileURLToPath(new URL('./bin/playbook.js', import.meta.url));
// Replace only the external provider adapters. The executable, launcher,
// configuration, real Captain, shared host/store and Git all run unchanged.
const providerSource = `
import { appendFileSync } from 'node:fs';
class FixtureAdapter {
  agent = 'claude-code';
  async isAvailable() { return true; }
  async *run(prompt, options) {
    if (process.env.PLAYBOOK_TEST_PROVIDER_LOG) appendFileSync(process.env.PLAYBOOK_TEST_PROVIDER_LOG, JSON.stringify({prompt,resume:options?.resume})+'\\n');
    const result = prompt.includes('Select exactly one action from the closed set')
      ? JSON.stringify({action:'respond',text:'Portable CLI answer.'}) : 'Portable CLI answer.';
    yield {type:'done',agent:this.agent,timestamp:Date.now(),sessionId:'fixture-provider',payload:{status:'success',result,resumeToken:'fixture-continuation',usage:{toolUses:0},durationMs:1}};
  }
}
export { FixtureAdapter, FixtureAdapter as ClaudeCodeAdapter, FixtureAdapter as CodexAdapter };
`;
async function fixture() {
  const root=await mkdtemp(join(tmpdir(),'playbook-cli-storage-'));roots.push(root);
  const cwd=join(root,'repo');await mkdir(cwd);await exec('git',['init','-q',cwd]);
  const spex=join(root,'spex');await mkdir(spex,{mode:0o700});
  const configPath=join(spex,'playbook.config.yaml');
  await writeFile(configPath,await readFile(new URL('./playbook.config.template.yaml',import.meta.url)));
  const provider=join(root,'provider.mjs');await writeFile(provider,providerSource);
  const {FixtureAdapter}=await import(pathToFileURL(provider).href);
  const loader=join(root,'loader.mjs');await writeFile(loader,`export async function load(url,context,nextLoad){const result=await nextLoad(url,context);const name=url.endsWith('/adapters/claude-code.js')?'ClaudeCodeAdapter':url.endsWith('/adapters/codex.js')?'CodexAdapter':undefined;if(!name)return result;return {...result,source:String(result.source).replace('export class '+name,'class Original'+name)+${JSON.stringify('\n'+providerSource)}};}`);
  const preload=join(root,'preload.mjs');await writeFile(preload,"import {register} from 'node:module';register('./loader.mjs',import.meta.url);\n");
  const store=createSessionStore({sessionsDir:join(spex,'sessions')});
  const plan=await loadLaunchPlan({userConfigPath:configPath});
  const config=executionConfigFromPlan(plan);
  const host=await openSessionHost({store,mode:'new',cwd,config,adapterImports:{claude:async()=>FixtureAdapter,codex:async()=>FixtureAdapter}} as any);
  await host.handleBossTurn('Create an application-owned conversation.');
  const id=host.sessionId;await host.dispose();
  // The CLI seeds its own config here; one credential seeds the template's
  // lineup, the one the application session above ran (playbook-cli-11).
  const env={PATH:process.env.PATH,HOME:join(root,'home'),SPEX_HOME:spex,ANTHROPIC_API_KEY:'fixture',PLAYBOOK_TEST_PROVIDER_LOG:join(root,'provider.jsonl')};
  const invoke=async(args:string[],extra:Record<string,string>={})=>{
    try {const value=await exec(process.execPath,['--import',preload,cli,...args],{cwd,env:{...env,...extra},timeout:30000});return{code:0,...value};}
    catch(cause:any){return{code:cause.code,stdout:cause.stdout??'',stderr:cause.stderr??''};}
  };
  return {root,cwd,spex,store,config,id,invoke,env};
}

describe('real CLI over an application-owned home',()=>{
  it('continues the application session among unsupported earlier records',async()=>{
    const f=await fixture();
    const legacyId=randomUUID();const legacy=await f.store.read(f.id);const legacyPath=join(f.store.sessionsDir,`${legacyId}.json`);
    await writeFile(legacyPath,JSON.stringify({...legacy,sessionId:legacyId}),{mode:0o600});
    const historyId=randomUUID();const sidecar=join(f.store.sessionsDir,`${historyId}.spex.json`);
    await writeFile(sidecar,JSON.stringify({v:1,id:historyId,createdAt:Date.now(),endedAt:Date.now()}),{mode:0o644});
    const result=await f.invoke(['run','--continue','--json','Continue the application conversation.']);
    expect(result.code,result.stderr).toBe(0);expect(JSON.parse(result.stdout)).toEqual({sessionId:f.id,reply:'Portable CLI answer.'});
    expect(result.stderr).toContain(legacyId);expect(result.stderr).toContain('storage schema 6 is unsupported');expect(result.stderr).not.toContain(historyId);
    const resumed=await f.store.read(f.id);expect(resumed.snapshot.sequences.turn).toBe(2);
    const calls=(await readFile(f.env.PLAYBOOK_TEST_PROVIDER_LOG,'utf8')).trim().split('\n').map(line=>JSON.parse(line));expect(calls[0].resume).toBe('fixture-continuation');
    const fresh=await f.invoke(['run','--json','Create another session.']);expect(fresh.code,fresh.stderr).toBe(0);expect(JSON.parse(fresh.stdout).sessionId).not.toBe(f.id);
    const refused=await f.invoke(['run','--session',legacyId,'Cannot resume an earlier format.']);expect(refused.code).toBe(1);expect(refused.stderr).toContain('storage schema 6 is unsupported');
    expect(JSON.parse(await readFile(legacyPath,'utf8')).schemaVersion).toBe(6);
  });
  it('seeds a mixed lineup under both credentials and continues its own session',async()=>{
    // DR-096: both credentials seed the Reviewer on Codex and the rest on
    // Claude; a session started on that seed continues on it.
    const f=await fixture();const both={OPENAI_API_KEY:'fixture'};
    const started=await f.invoke(['run','--json','Start on the mixed seed.'],both);expect(started.code,started.stderr).toBe(0);
    const seeded=await readFile(join(f.spex,'config','playbook.config.yaml'),'utf8');
    const lineup = parse(seeded);
    expect(lineup.players['dev.reviewer']).toMatchObject({ adapter: 'codex', model: 'gpt-6-astra', subagentModel: 'gpt-6.1-sol' });
    expect(lineup.players['dev.coder']).toMatchObject({ adapter: 'claude', model: 'claude-fable-5-2', subagentModel: 'claude-opus-5-5' });
    const id=JSON.parse(started.stdout).sessionId;expect(id).not.toBe(f.id);
    const continued=await f.invoke(['run','--session',id,'--json','Continue on the mixed seed.'],both);
    expect(continued.code,continued.stderr).toBe(0);expect(JSON.parse(continued.stdout)).toEqual({sessionId:id,reply:'Portable CLI answer.'});
    expect((await f.store.read(id)).snapshot.sequences.turn).toBe(2);
    const calls=(await readFile(f.env.PLAYBOOK_TEST_PROVIDER_LOG,'utf8')).trim().split('\n').map(line=>JSON.parse(line));expect(calls.at(-1).resume).toBe('fixture-continuation');
  });
  it('converts the configured directory through the executable without provider work (DR-111)',async()=>{
    const f=await fixture();const target=join(f.root,'override');await mkdir(target,{mode:0o700});
    // A schema-7 monolithic session: the logical manifest whole beside its replay.
    const manifest=await f.store.readManifest(f.id);const id=f.id;
    const replay=await readFixtureReplay(join(f.store.sessionsDir,`${f.id}.records.jsonl`));
    const source=JSON.stringify(manifest);await writeFile(join(target,`${id}.json`),source,{mode:0o644});
    await writeFile(join(target,`${id}.records.jsonl`),replay,{mode:0o644});
    const overlay=join(f.root,'overlay.yaml');await writeFile(overlay,`sessions: ${JSON.stringify(target)}\n`);
    const result=await f.invoke(['sessions','upgrade','--with',overlay]);expect(result.code,`${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(target);expect(result.stdout).toContain(`${id} schema 7: converted`);
    const converted=createSessionStore({sessionsDir:target});expect((await converted.validate(id)).resumable).toBe(true);
    expect(await converted.readManifest(id)).toEqual(manifest);
    expect(await readFile(join(f.root,'.legacy-sessions',id,`${id}.json`),'utf8')).toBe(source);
    await expect(readFile(f.env.PLAYBOOK_TEST_PROVIDER_LOG)).rejects.toMatchObject({code:'ENOENT'});
  });
  it.each(['digest','incomplete','context','path','module'])('rejects %s before either CLI imports registry code',async(kind)=>{
    const f=await fixture();const file=join(f.store.sessionsDir,`${f.id}.json`);const stream=join(f.store.sessionsDir,`${f.id}.replay.json`);
    const manifest=await readFixtureManifest(file);
    if(kind==='digest')manifest.replay.sha256='0'.repeat(64);else if(kind==='incomplete')manifest.replay.incomplete=true;
    else if(kind==='path')manifest.cwd=String.raw`C:\Users\other\repo`;
    else if(kind==='context'){const lines=(await readFixtureReplay(stream,'utf8')).trimEnd().split('\n');const entry=JSON.parse(lines[manifest.contextSeq-1]);entry.record.contextVersion=99;lines[manifest.contextSeq-1]=JSON.stringify(entry);const bytes=lines.join('\n')+'\n';await writeFixtureReplay(stream,bytes);manifest.replay.sha256=createHash('sha256').update(lines.slice(0,manifest.replay.seq).join('\n')+'\n').digest('hex');}
    await writeFixtureFile(file,JSON.stringify(manifest));
    const marker=join(f.root,'imported');const trap=join(f.root,'trap.mjs');await writeFile(trap,`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'imported');throw Error('registry imported before validation');`);
    const overlay=join(f.root,'trap.yaml');await writeFile(overlay,`playbooks:\n  code:\n    from: ${JSON.stringify(trap)}\n`);
    for(const args of [['run','--session',f.id,'--with',overlay,'must refuse'],['--session',f.id,'--with',overlay]]) {
      const result=await f.invoke(args);expect(result.code,result.stderr).toBe(1);expect(result.stderr).toContain({digest:'checkpoint digest does not match',incomplete:'session replay is incomplete',context:'absent or unsupported',path:'not native',module:'from'}[kind]);expect(result.stderr).not.toContain('registry imported before validation');
    }
    await expect(readFile(marker)).rejects.toMatchObject({code:'ENOENT'});await expect(readFile(f.env.PLAYBOOK_TEST_PROVIDER_LOG)).rejects.toMatchObject({code:'ENOENT'});
  });
});
