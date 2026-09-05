// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, writeFile, mkdir, readdir, rm, stat, symlink, link, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createSessionStore, openSessionStore, projectCaptainSessionStructure, validateSessionManifest, validateSessionContext } from './session-store.js';
import { discardSessionUncertain } from './session-host.js';
import { createReplayRecordObserver } from './bin/replay-observer.js';
const captainRuntimeId = '80000000-0000-4000-8000-000000000001';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, {recursive:true,force:true}))); });
async function fixture() {
 const root = await mkdtemp(join(tmpdir(), 'portable-session-')); roots.push(root);
 const store = createSessionStore({sessionsDir:join(root,'sessions')});
 const id = randomUUID(); const lease = await store.acquire(id);
 await lease.initializeSettledWithPredecessor(freshBoundary() as any);
 return { root, store, id, lease, file:join(store.sessionsDir, `${id}.json`), stream:join(store.sessionsDir,`${id}.records.jsonl`) };
}
function executionProjection(
  options: {
    captainModel?: string;
    playerModel?: string;
    playerId?: string;
  } = {},
) {
  const playerId = options.playerId ?? 'dev.coder';
  return {
    schemaVersion: 2,
    captain: {
      adapter: 'claude',
      model:
        options.captainModel === undefined
          ? { kind: 'provider-default' }
          : { kind: 'value', value: options.captainModel },
      effort: { kind: 'provider-default' },
      permissions: { mode: 'auto' },
    },
    players: [
      {
        id: playerId,
        adapter: 'codex',
        model:
          options.playerModel === undefined
            ? { kind: 'provider-default' }
            : { kind: 'value', value: options.playerModel },
        effort: { kind: 'value', value: 'high' },
        permissions: { fileWrite: 'ask' },
      },
    ],
    catalog: {
      code: {
        id: 'code',
        from: '@sublang/playbook/code/registry',
        manifestCommand: 'code',
        command: 'code',
        intent: 'Implement a requested change.',
        artifactSchema: 3,
        requiredRoleIds: ['coder'],
        concurrentRoleSets: [],
        roles: {
          coder: {
            playerId,
            model:
              options.playerModel === undefined
                ? { kind: 'provider-default' }
                : { kind: 'value', value: options.playerModel },
            effort: { kind: 'value', value: 'high' },
          },
        },
        options: {},
      },
    },
  };
}


function parkedState(stateId = 'routing') {
  return {
    value: stateId,
    activeStateIds: [stateId],
    tags: ['playbook.parked'],
    status: 'active',
    quiescent: true,
    stateId,
  };
}


function effectLedger() {
  return {
    schemaVersion: 1,
    revision: 0,
    boundaries: [],
    logicalOperations: [],
  };
}


function runtimeSnapshot(playbookId = 'captain', turn = 0) {
  const state = parkedState();
  return {
    schemaVersion: 4,
    playbookId,
    machine: { value: state.value, status: state.status },
    roleResumeTokens: {},
    sequences: {
      trace: 0,
      turn,
      judgeCall: 0,
      playerCall: 0,
      playbookCall: 0,
      captainCall: 0,
    },
    state,
    pendingBossQuestions: [],
    effectLedger: effectLedger(),
  };
}


function shellSnapshot(
  execution = executionProjection(),
  turn = 0,
  token = `captain-token-${turn}`,
) {
  const structural = projectCaptainSessionStructure(execution);
  const journal = Array.from({ length: turn }, (_, index) => ({
    seq: index + 1,
    turnId: index + 1,
    kind: 'boss',
    payload: `turn-${index + 1}`,
  }));
  return {
    schemaVersion: 4,
    captain: {
      sessionId: captainRuntimeId,
      runtime: runtimeSnapshot('captain', turn),
      agent: structural.captain,
      conversation:
        turn === 0
          ? { kind: 'unopened' }
          : { kind: 'pinned', token },
    },
    playerSessions: Object.fromEntries(
      structural.players.map(({ id, ...agent }: any) => [id, agent]),
    ),
    issuedSessionIds: [captainRuntimeId],
    sequences: { turn, journal: journal.length },
    journal,
    effectLedger: effectLedger(),
    ...(turn === 0
      ? {}
      : { lastAction: 'respond', lastSettlementStatus: 'ok' }),
    mode: 'chat',
  };
}


function freshBoundary(execution = executionProjection()) {
  return {
    cwd: process.cwd(),
    structuralProjection: projectCaptainSessionStructure(execution),
    executionProjection: execution,
    snapshot: shellSnapshot(execution),
  };
}


describe('shared portable session lifecycle', () => {
 it('writes exact schema7 checkpoints over byte-identical replay and context', async () => {
  const {store,id,lease,file,stream}=await fixture();
  await lease.append({type:'captain_reply',timestamp:1,text:'hello'});
  const prior=await lease.read(); const attemptId=randomUUID();
  await lease.beginTurn({input:'next',attemptId,attemptedExecutionProjection:prior!.lastAppliedExecutionProjection});
  const manifest=JSON.parse(await readFile(file,'utf8'));
  expect(manifest.schemaVersion).toBe(7);
  expect(manifest.replay.sha256).toBe(createHash('sha256').update(await readFile(stream)).digest('hex'));
  const history=await store.readHistory(id);
  expect(history.entries[0].record.type).toBe('session_context');
  expect(history.entries[1].record.contextSeq).toBe(1);
  expect(manifest.contextSeq).toBe(1);
  expect((await store.validate(id)).resumable).toBe(true);
  expect(()=>validateSessionManifest({...manifest,extra:true})).toThrow();
  await lease.release();
 });
 it('keeps valid opaque kinds and stops at damage without modifying history',async()=>{
  const {store,id,lease,stream}=await fixture(); await lease.release();
  const before=await readFile(stream,'utf8');
  await writeFile(stream,before+JSON.stringify({v:1,seq:2,record:{opaque:true}})+'\n'+JSON.stringify({v:1,seq:3,record:{type:'future'}})+'\n'+'{bad}\n',{mode:0o600});
  const bytes=await readFile(stream);
  const history=await store.readHistory(id);
  expect(history.lastReadableSeq).toBe(3);expect(history.damage?.seq).toBe(4);
  expect(await readFile(stream)).toEqual(bytes);
  expect((await store.validate(id)).resumable).toBe(false);
 });
 it('detects changed bytes even when sequence boundaries are identical',async()=>{
  const {store,id,lease,stream}=await fixture();await lease.release();
  const bytes=await readFile(stream,'utf8'); await writeFile(stream,bytes.replace('session_context','session_contexu'));
  const report=await store.validate(id);expect(report.resumable).toBe(false);expect(report.reasons.some(r=>r.includes('digest'))).toBe(true);
 });
 it('projects tokens out of recovery and consumes exact-checkpoint hints durably',async()=>{
  const {store,id,lease,file}=await fixture();const attemptId=randomUUID();
  await lease.beginTurn({input:'turn',attemptId,attemptedExecutionProjection:executionProjection()});
  lease.acknowledgeHint('captain','captain-live');lease.acknowledgeHint('dev.coder','player-live');
  const snapshot:any=shellSnapshot(executionProjection(),1,'captain-live');snapshot.playerSessions['dev.coder'].resumeToken='player-live';
  await lease.settle({attemptId,snapshot,unresolvedEffects:[]});
  const bytes=await readFile(file,'utf8');expect(bytes).not.toContain('captain-live');expect(bytes).not.toContain('player-live');
  const hints=await lease.consumeHints();expect(hints.captain).toEqual({kind:'pinned',token:'captain-live'});expect(hints.players['dev.coder']).toBe('player-live');
  expect((await lease.consumeHints()).players).toEqual({});
  await lease.release();
  expect((await store.read(id)).snapshot.captain.conversation).toEqual({kind:'needsSeeding'});
 });
 it('retains unused player hints while retiring a called participant without acknowledgement',async()=>{
  const {store,id,lease,file}=await fixture();let attemptId=randomUUID();
  await lease.beginTurn({input:'first',attemptId,attemptedExecutionProjection:executionProjection()});
  lease.acknowledgeHint('captain','captain-before');lease.acknowledgeHint('dev.coder','player-unchanged');
  await lease.settle({attemptId,snapshot:shellSnapshot(executionProjection(),1),unresolvedEffects:[]});await lease.release();
  const next=await store.acquire(id);await next.consumeHints();next.clearHint('captain');
  attemptId=randomUUID();await next.beginTurn({input:'status',attemptId,attemptedExecutionProjection:executionProjection()});
  await next.settle({attemptId,snapshot:shellSnapshot(executionProjection(),2),unresolvedEffects:[]});await next.release();
  const hints=JSON.parse(await readFile(join(store.sessionsDir,`${id}.hints.json`),'utf8'));
  expect(hints.players).toEqual({'dev.coder':'player-unchanged'});expect(hints).not.toHaveProperty('captain');
  expect(hints.checkpointSha256).toBe(createHash('sha256').update(await readFile(file)).digest('hex'));
  expect(await readFile(file,'utf8')).not.toContain('player-unchanged');
 });
 it('observes live, dead and unprovable leases without acquiring or rewriting files',async()=>{
  const {store,id,lease,file}=await fixture();const ownerPath=join(store.sessionsDir,`.${id}.lock`,'owner.json');
  const before=await readFile(ownerPath);const manifest=await readFile(file);const names=await readdir(store.sessionsDir);
  expect(await store.readLeaseState(id)).toBe('active');
  const dead=createSessionStore({sessionsDir:store.sessionsDir,probeProcess(){throw Object.assign(new Error('dead'),{code:'ESRCH'});}});
  expect(await dead.readLeaseState(id)).toBe('idle');
  const denied=createSessionStore({sessionsDir:store.sessionsDir,probeProcess(){throw Object.assign(new Error('denied'),{code:'EPERM'});}});
  expect(await denied.readLeaseState(id)).toBe('unknown');
  expect(await createSessionStore({sessionsDir:store.sessionsDir,hostname:'another-host'}).readLeaseState(id)).toBe('unknown');
  expect(await readFile(ownerPath)).toEqual(before);expect(await readFile(file)).toEqual(manifest);expect(await readdir(store.sessionsDir)).toEqual(names);
  await lease.release();expect(await store.readLeaseState(id)).toBe('idle');
 });
 it('reports an incomplete lease as unknown without repairing it',async()=>{
  const {store,id,lease}=await fixture();await lease.release();const lock=join(store.sessionsDir,`.${id}.lock`);
  await mkdir(lock,{mode:0o700});expect(await store.readLeaseState(id)).toBe('unknown');expect(await readdir(lock)).toEqual([]);
  await writeFile(join(lock,'owner.json'),'{',{mode:0o600});expect(await store.readLeaseState(id)).toBe('unknown');expect(await readFile(join(lock,'owner.json'),'utf8')).toBe('{');
 });
 it('ignores mismatched hints without damaging portable recovery',async()=>{
  const {store,id,lease}=await fixture();const hintPath=join(store.sessionsDir,`${id}.hints.json`);
  await writeFile(hintPath,JSON.stringify({v:1,sessionId:id,checkpointSha256:'0'.repeat(64),players:{'dev.coder':'stale'}}),{mode:0o600});
  expect((await lease.consumeHints()).players).toEqual({});expect((await store.validate(id)).resumable).toBe(true);await lease.release();
 });
 it('offers module-free discard and retains the settled baseline',async()=>{
  const {store,id,lease}=await fixture();const prior=await lease.read();await lease.beginTurn({input:'interrupted',attemptId:randomUUID(),attemptedExecutionProjection:executionProjection()});await lease.release();
  const discarded=await discardSessionUncertain(store,id);expect(discarded?.state).toBe('settled');expect(discarded?.snapshot).toEqual(prior?.snapshot);
 });
 it('deletes all active session files and retains lease guards',async()=>{
  const {store,id,lease,file,stream}=await fixture();await lease.release();
  await writeFile(join(store.sessionsDir,`${id}.hints.json`),'{}',{mode:0o600});
  await store.delete(id);await store.delete(id);
  await expect(readFile(file)).rejects.toMatchObject({code:'ENOENT'});await expect(readFile(stream)).rejects.toMatchObject({code:'ENOENT'});
  expect((await readdir(store.sessionsDir)).some(name=>name.startsWith(`.${id}.lock.retired.`))).toBe(true);
 });
 it('management leases protect unsupported and absent sessions without reading or rewriting them',async()=>{
  const {store,id,lease,file,stream}=await fixture();await lease.release();
  await writeFile(file,'{"schemaVersion":99}');await writeFile(stream,'opaque unsafe history');const bytes=await readFile(stream);
  const management=await store.acquireManagement(id);await expect(store.acquireManagement(id)).rejects.toMatchObject({code:'PLAYBOOK_SESSION_LEASE_ACTIVE'});await management.release();
  expect(await readFile(stream)).toEqual(bytes);await store.delete(id);
  const missing=await store.acquireManagement(randomUUID());await missing.release();
 });
 it('tightens a real Git checkout created under umask022 without changing bytes',async()=>{
  const {store,id,lease,root,file,stream}=await fixture();await lease.release();
  execFileSync('git',['init','-q',root]);execFileSync('git',['-C',root,'add','sessions/'+id+'.json','sessions/'+id+'.records.jsonl']);
  execFileSync('git',['-C',root,'-c','commit.gpgsign=false','-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture']);
  const before=[await readFile(file),await readFile(stream)];await rm(file);await rm(stream);
  execFileSync('sh',['-c','umask 022; git checkout -- sessions'],{cwd:root});await chmod(store.sessionsDir,0o755);
  expect((await stat(file)).mode&0o777).toBe(0o644);expect((await openSessionStore(store.sessionsDir).list()).sessions).toHaveLength(1);
  expect((await stat(store.sessionsDir)).mode&0o777).toBe(0o700);expect((await stat(file)).mode&0o777).toBe(0o600);expect([await readFile(file),await readFile(stream)]).toEqual(before);
 });
 it.each(['symlink','hardlink','owner-bits'])('refuses unsafe permission preparation: %s',async(kind)=>{
  const {store,lease,file,root}=await fixture();await lease.release();
  if(kind==='owner-bits') await chmod(file,0o400);
  else {const other=join(root,'outside');await writeFile(other,'{}',{mode:0o600});await rm(file);if(kind==='symlink')await symlink(other,file);else await link(other,file);}
  await expect(store.prepare()).rejects.toThrow(/unsafe/);
 });
 it('migrates validated schema6 through retained exact inputs and is idempotent',async()=>{
  const {store,id,lease,file,stream,root}=await fixture();const legacy=await lease.read();await lease.release();
  const source=JSON.stringify(legacy);await writeFile(file,source);await rm(stream);
  const migrated=await store.migrate(id);expect(migrated.manifest.schemaVersion).toBe(7);expect(migrated.manifest.state).toBe('settled');
  expect(await readFile(join(root,'local','migrations',id,'inputs','0'),'utf8')).toBe(source);
  expect((await store.migrate(id)).migrated).toBe(false);expect((await store.validate(id)).resumable).toBe(true);
 });
 it('migrates desktop sidecars as history only without inventing recovery',async()=>{
  const root=await mkdtemp(join(tmpdir(),'desktop-migrate-'));roots.push(root);const store=createSessionStore({sessionsDir:join(root,'sessions')});await mkdir(store.sessionsDir,{mode:0o700});const id=randomUUID();
  const sidecar=join(store.sessionsDir,`${id}.spex.json`);const source=JSON.stringify({v:1,id,projectId:randomUUID(),createdAt:1,endedAt:2,live:false,players:[],initialVisible:[]});await writeFile(sidecar,source,{mode:0o600});
  const result=await store.migrate(id,{sourcePath:sidecar,cwd:process.cwd()});expect(result.manifest.state).toBe('history-only');expect((await store.validate(id)).resumable).toBe(false);await expect(readFile(sidecar)).rejects.toMatchObject({code:'ENOENT'});
 });
 it('refuses changed paths without changing checkpoints or history',async()=>{
  const {store,id,lease,file}=await fixture();await lease.release();const before=await readFile(file);const validation=await store.validate(id,{cwd:'/different/path'});expect(validation.resumable).toBe(false);expect(validation.reasons.some(r=>r.includes('relocation'))).toBe(true);expect(await readFile(file)).toEqual(before);
 });
 it('validates graph identities, context versions, and cycles',async()=>{
  const {store,id,lease}=await fixture();const context:any=structuredClone((await store.readHistory(id)).entries[0].record);
  context.graphs[0].graph={initial:'a',nodes:[{id:'a',kind:'state',tags:[]},{id:'b',kind:'final',tags:[]}],edges:[{id:'ab',from:'a',to:'b',event:''}]};expect(validateSessionContext(context)).toEqual(context);
  context.graphs[0].graph.nodes[0].parent='a';expect(()=>validateSessionContext(context)).toThrow(/cyclic/);context.contextVersion=2;expect(()=>validateSessionContext(context)).toThrow();await lease.release();
 });
 it('recovers a migration interrupted between replay and manifest publication', async () => {
  const {store,id,lease,file,stream,root}=await fixture();
  const legacy=await lease.read();await lease.release();
  const original=JSON.stringify(legacy);await writeFile(file,original);const originalReplay=await readFile(stream);
  let fail=true;
  const interrupted=createSessionStore({sessionsDir:store.sessionsDir,fsOps:{async rename(from,to){if(fail&&to===file){fail=false;throw new Error('manifest publication interrupted');}return rename(from,to);}}});
  await expect(interrupted.migrate(id)).rejects.toThrow('manifest publication interrupted');
  expect(await readFile(file,'utf8')).toBe(original);
  expect(await readFile(join(root,'local','migrations',id,'inputs','1'))).toEqual(originalReplay);
  const stagedReplay=await readFile(stream);
  await store.migrate(id);
  expect(await readFile(stream)).toEqual(stagedReplay);
  expect((await store.validate(id)).resumable).toBe(true);
 });
 it('refuses divergent migration output and preserves malformed source bytes',async()=>{
  const {store,id,lease,file,stream}=await fixture();const legacy=await lease.read();await lease.release();await writeFile(file,JSON.stringify(legacy));
  const interrupted=createSessionStore({sessionsDir:store.sessionsDir,fsOps:{async rename(from,to){if(to===file)throw new Error('stop publication');return rename(from,to);}}});
  await expect(interrupted.migrate(id)).rejects.toThrow('stop publication');
  const changed=Buffer.from('divergent replay\n');await writeFile(stream,changed);
  await expect(store.migrate(id)).rejects.toThrow('diverged');expect(await readFile(stream)).toEqual(changed);
  const malformed='{"schemaVersion":6,"broken":true}';await writeFile(file,malformed);
  await expect(store.migrate(id)).rejects.toThrow();expect(await readFile(file,'utf8')).toBe(malformed);
 });
 it('retains damaged legacy replay verbatim while publishing readable history only',async()=>{
  const {store,id,lease,file,stream,root}=await fixture();const legacy=await lease.read();await lease.release();await writeFile(file,JSON.stringify(legacy));
  const prefix=await readFile(stream);const damaged=Buffer.concat([prefix,Buffer.from([0xff,0x0a])]);await writeFile(stream,damaged);
  const migrated=await store.migrate(id);expect(migrated.manifest.state).toBe('history-only');expect(migrated.manifest.replay.incomplete).toBe(true);
  expect(await readFile(join(root,'local','migrations',id,'inputs','1'))).toEqual(damaged);
  expect(await readFile(stream)).toEqual(prefix);
 });
 it('keeps the manifest until interrupted deletion can finish',async()=>{
  const {store,id,lease,file,stream}=await fixture();await lease.release();const hint=join(store.sessionsDir,`${id}.hints.json`);await writeFile(hint,'{}',{mode:0o600});
  const interrupted=createSessionStore({sessionsDir:store.sessionsDir,fsOps:{async unlink(path){if(path===hint)throw new Error('hint removal interrupted');return unlink(path);}}});
  await expect(interrupted.delete(id)).rejects.toThrow('hint removal interrupted');
  expect(await readFile(file)).toBeDefined();await expect(readFile(stream)).rejects.toMatchObject({code:'ENOENT'});expect((await store.validate(id)).integrityValid).toBe(false);
  await store.delete(id);await expect(readFile(file)).rejects.toMatchObject({code:'ENOENT'});
 });
 it('preserves incompleteness across leases and retains ownership when its save fails',async()=>{
  const {store,id,lease,file}=await fixture();await lease.release();let fail=false;
  const failing=createSessionStore({sessionsDir:store.sessionsDir,fsOps:{async rename(from,to){if(fail&&to===file)throw new Error('incomplete save failed');return rename(from,to);}}});
  const writer=await failing.acquire(id);const cyclic:any={};cyclic.self=cyclic;await expect(writer.append(cyclic)).rejects.toThrow("JSON cycle");fail=true;
  await expect(writer.release()).rejects.toThrow('incomplete save failed');await expect(store.acquireManagement(id)).rejects.toMatchObject({code:'PLAYBOOK_SESSION_LEASE_ACTIVE'});
  fail=false;await writer.release();expect(JSON.parse(await readFile(file,'utf8')).replay.incomplete).toBe(true);
  const next=await store.acquire(id);await expect(next.assertContinuable()).rejects.toThrow('incomplete');await next.release();expect((await store.readManifest(id)).replay.incomplete).toBe(true);
 });
 it('keeps unsupported context history readable and refuses a mismatched supported context',async()=>{
  const {store,id,lease,file,stream}=await fixture();await lease.release();
  const manifest=JSON.parse(await readFile(file,'utf8'));const entry=JSON.parse(await readFile(stream,'utf8'));
  const publish=async()=>{const bytes=JSON.stringify(entry)+'\n';await writeFile(stream,bytes);manifest.replay.sha256=createHash('sha256').update(bytes).digest('hex');await writeFile(file,JSON.stringify(manifest));};
  entry.record.contextVersion=99;await publish();const future=await store.validate(id);expect(future.integrityValid).toBe(true);expect(future.resumable).toBe(false);expect(future.history.entries).toHaveLength(1);
  entry.record.contextVersion=1;entry.record.captainId=randomUUID();await publish();const mismatch=await store.validate(id);expect(mismatch.integrityValid).toBe(false);expect(mismatch.reasons).toContain('required session context differs from checkpoint recovery');
 });

 it('projects a validated legacy journal without creating replay authority',async()=>{
  const {store,id,lease,file,stream}=await fixture();const legacy:any=structuredClone(await lease.read());await lease.release();
  legacy.snapshot=shellSnapshot(executionProjection(),2);
  legacy.snapshot.journal=[{seq:1,turnId:1,kind:'boss',payload:'first'},{seq:2,turnId:1,kind:'reply',payload:'first reply'},{seq:3,turnId:2,kind:'boss',payload:'second'},{seq:4,turnId:2,kind:'reply',payload:'second reply'}];legacy.snapshot.sequences.journal=4;
  const bytes=JSON.stringify(legacy);await writeFile(file,bytes);await rm(stream);
  const history=await store.readHistory(id);expect(history.synthetic).toBe(true);expect(history.missing).toBe(true);expect(history.entries.map(e=>e.record.type)).toEqual(['turn_started','captain_reply','turn_finished','turn_started','captain_reply','turn_finished']);
  expect(await readFile(file,'utf8')).toBe(bytes);await expect(readFile(stream)).rejects.toMatchObject({code:'ENOENT'});expect((await store.validate(id)).resumable).toBe(false);
 });

 it('presents legacy journal-only records without granting recovery',async()=>{
  const {store,id,lease,file,stream}=await fixture();await lease.release();const legacy={schemaVersion:3,kind:'captain-session',sessionId:id,updatedAt:new Date(0).toISOString(),snapshot:{journal:[{turnId:1,kind:'boss',payload:'old request'},{turnId:1,kind:'reply',payload:'old reply'},{turnId:'invalid',kind:'boss',payload:'skip'}]}};
  await writeFile(file,JSON.stringify(legacy));await rm(stream);const history=await store.readHistory(id);expect(history.synthetic).toBe(true);expect(history.entries).toHaveLength(3);await expect(store.read(id)).rejects.toThrow();
 });
 it('temporarily refuses an unfinished replay tail without saving damage',async()=>{
  const {store,id,lease,file,stream}=await fixture();await lease.release();const before=await readFile(file);const entry=JSON.stringify({v:1,seq:2,record:{opaque:true}});await writeFile(stream,(await readFile(stream,'utf8'))+entry);
  const pending=await store.validate(id);expect(pending.integrityValid).toBe(true);expect(pending.resumable).toBe(false);expect(pending.history.pendingTail).toBe(true);expect(await readFile(file)).toEqual(before);
  await writeFile(stream,(await readFile(stream,'utf8'))+'\n');expect((await store.validate(id)).resumable).toBe(true);expect(await readFile(file)).toEqual(before);
 });

 it('delivers internal replay records without gaps or callback deadlock',async()=>{
  const {lease}=await fixture();const delivered:any[]=[];
  const channel=createReplayRecordObserver({lease,onIncomplete:()=>{},onStored:async(entry:any)=>{delivered.push(entry);if(entry.record.type==='continuity_reset')await lease.append({type:'host_notice',timestamp:2});}});
  await lease.append({type:'continuity_reset',timestamp:1,participantId:'captain',reason:'missing_hint'});
  await channel.observer.onRecord({type:'captain_reply',timestamp:2,text:'fresh reply'});
  await channel.flushStoredRecords();
  expect(delivered.map(entry=>entry.seq)).toEqual([2,3,4]);expect(delivered.map(entry=>entry.record.type)).toEqual(['continuity_reset','captain_reply','host_notice']);await lease.release();
 });

 it('keeps migrated journal history visible and retains opaque entries',async()=>{
  const root=await mkdtemp(join(tmpdir(),'desktop-journal-migration-'));roots.push(root);const store=createSessionStore({sessionsDir:join(root,'sessions')});await mkdir(store.sessionsDir,{mode:0o700});const id=randomUUID();const sidecar=join(store.sessionsDir,`${id}.spex.json`);
  const journal=[{seq:1,turnId:1,kind:'boss',payload:'historic request'},{seq:2,turnId:1,kind:'reply',payload:'historic reply'},{seq:3,turnId:1,kind:'action',payload:{details:'original action'}}];
  await writeFile(sidecar,JSON.stringify({v:1,id,projectId:randomUUID(),createdAt:1,endedAt:2,live:false,players:[],initialVisible:[],snapshot:{v:1,shell:{journal}}}),{mode:0o600});
  await store.migrate(id,{sourcePath:sidecar,cwd:process.cwd()});const history=await store.readHistory(id);expect(history.entries.slice(0,3).map(e=>e.record.type)).toEqual(['turn_started','captain_reply','turn_finished']);expect(history.entries.filter(e=>e.record.type==='legacy_journal').map(e=>e.record.entry)).toEqual(journal);expect((await store.readManifest(id)).state).toBe('history-only');
 });

 it('replays saved graph and configuration with the project module absent',async()=>{
  const root=await mkdtemp(join(tmpdir(),'portable-graph-history-'));roots.push(root);const store=createSessionStore({sessionsDir:join(root,'sessions')});const id=randomUUID();const execution=executionProjection();execution.catalog.code.from='file:///unavailable/project/code.registry.mjs';
  const lease=await store.acquire(id);await lease.initializeSettledWithPredecessor(freshBoundary(execution) as any);
  const context:any=structuredClone((await store.readHistory(id)).entries[0].record);context.graphs[0].graph={initial:'start',nodes:[{id:'start',kind:'state',tags:['working'],role:'coder'},{id:'done',kind:'final',tags:[]}],edges:[{id:'finish',from:'start',to:'done',event:'DONE'}]};
  const contextSeq=await lease.recordContext(context);await lease.beginTurn({input:'show graph',attemptId:randomUUID(),attemptedExecutionProjection:execution});await lease.append({type:'state_entered',timestamp:3,stateId:'start'});await lease.release();
  const history=await store.readHistory(id);expect(history.entries.find(entry=>entry.seq===contextSeq)?.record).toEqual(context);expect(history.entries.at(-1)?.record.contextSeq).toBe(contextSeq);expect((await store.validate(id)).resumable).toBe(true);
 });

});
