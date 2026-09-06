// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, writeFile, mkdir, readdir, rm, stat, symlink, link, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createSessionStore, openSessionStore, projectCaptainSessionStructure, validateSessionManifest, validateSessionContext } from './session-store.js';
import { discardSessionUncertain, openSessionHost } from './session-host.js';
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
async function legacyDefaultFixture() {
 const source=await fixture();await source.lease.append({type:'legacy_notice',timestamp:7,text:'complete replay survives cutover'});
 const record=await source.lease.read();await source.lease.release();
 const sourceBytes=JSON.stringify(record);await writeFile(source.file,sourceBytes);
 const replayBytes=await readFile(source.stream);const xdg=join(source.root,'xdg');const sourceDir=join(xdg,'playbook','sessions');
 await mkdir(dirname(sourceDir),{recursive:true});await rename(source.store.sessionsDir,sourceDir);
 const home=join(source.root,'home');const sessionsDir=join(home,'.spex','sessions');
 const options={sessionsDir,env:{XDG_STATE_HOME:xdg},homeDir:home};
 return {...source,sourceDir,sourcePath:join(sourceDir,`${source.id}.json`),sourceReplay:join(sourceDir,`${source.id}.records.jsonl`),sourceBytes,replayBytes,options,target:createSessionStore(options)};
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
 it.each(['captain_event', 'player_event'])('removes provider identities from %s before replay delivery and checkpointing', async (type) => {
  const {store,id,lease,file,stream}=await fixture();
  const delivered:any[]=[];
  const channel=createReplayRecordObserver({lease,onStored:async(entry:any)=>{delivered.push(entry);}});
  const event={type:'provider:raw',agent:'codex',timestamp:1,sessionId:'secret-provider-normalized',payload:{
   session_id:'secret-provider-snake',sessionID:'secret-provider-acronym',threadId:'secret-provider-thread',thread_id:'secret-provider-thread-snake',
   conversationId:'secret-provider-conversation',conversation_id:'secret-provider-conversation-snake',
   session:{id:'secret-provider-session-object',status:'idle'},thread:{id:'secret-provider-thread-object'},conversation:{id:'secret-provider-conversation-object'},
   metadata:[{sessionId:'secret-provider-nested'}],
   input:{sessionId:'business-session',thread:{id:'business-thread'}},output:{conversationId:'business-conversation'},
   toolUseId:'logical-tool',resume:false,
  }};
  await channel.observer.onRecord({type,timestamp:1,playerId:'dev.coder',event});
  const trace={type:'captain_telemetry',timestamp:2,topic:'playbook.trace',payload:{sessionId:'logical-session',rootSessionId:'logical-root',parentSessionId:'logical-parent',callId:'logical-call',payload:{resume:false}}};
  await channel.observer.onRecord(trace);
  // Direct normalized events can also appear in stored observed payloads.
  await channel.observer.onRecord({type:'opaque_history',timestamp:3,observed:event});
  const prior=await lease.read();
  await lease.beginTurn({input:'next',attemptId:randomUUID(),attemptedExecutionProjection:prior!.lastAppliedExecutionProjection});
  await lease.release();
  const bytes=await readFile(stream,'utf8');const manifest=JSON.parse(await readFile(file,'utf8'));
  expect(bytes).not.toContain('secret-provider-');
  expect(manifest.replay.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  const history=await store.readHistory(id);
  expect(delivered).toEqual(history.entries.slice(1));
  expect(history.entries[1]!.record.event).toEqual({type:'provider:raw',agent:'codex',timestamp:1,payload:{
   session:{status:'idle'},thread:{},conversation:{},metadata:[{}],input:{sessionId:'business-session',thread:{id:'business-thread'}},
   output:{conversationId:'business-conversation'},toolUseId:'logical-tool',resume:false,
  }});
  expect(history.entries[2]!.record).toMatchObject(trace);
  expect(history.entries[3]!.record.observed).toEqual(history.entries[1]!.record.event);
  expect(event.sessionId).toBe('secret-provider-normalized');
  expect((await store.validate(id)).integrityValid).toBe(true);
 });
 it.each(['captain_event','player_event'])('removes native OpenCode permission identities from %s while preserving tool inputs',async(type)=>{
  const {store,id,lease,stream}=await fixture();const delivered:any[]=[];
  const channel=createReplayRecordObserver({lease,onStored:async(entry:any)=>{delivered.push(entry);}});
  const payload={requestId:'permission-request',nativeSessionId:'secret-native-session',permission:'edit',patterns:['fixture.txt'],toolUseId:'logical-tool',decision:'once',automated:true,input:{nativeSessionId:'business-session',sessionID:'business-record'}};
  await channel.observer.onRecord({type,timestamp:1,playerId:'dev.coder',event:{type:'opencode:permission_decision',agent:'opencode',timestamp:1,sessionId:'secret-normalized-session',payload}});
  const prior=await lease.read();await lease.beginTurn({input:'next',attemptId:randomUUID(),attemptedExecutionProjection:prior!.lastAppliedExecutionProjection});await lease.release();
  const history=await store.readHistory(id);expect(delivered).toEqual(history.entries.slice(1));
  const {nativeSessionId,...retained}=payload;expect(history.entries[1]!.record.event.payload).toEqual(retained);
  expect(await readFile(stream,'utf8')).not.toContain('secret-');
  expect((await store.validate(id)).integrityValid).toBe(true);
 });
 it('refuses provider identities in an existing portable replay without changing its bytes',async()=>{
  const {store,id,lease,file,stream}=await fixture();await lease.release();
  const original=await readFile(stream);const record={type:'captain_event',timestamp:1,event:{type:'init',agent:'claude-code',timestamp:1,sessionId:'secret-provider-existing',payload:{}}};
  const bytes=Buffer.concat([original,Buffer.from(`${JSON.stringify({v:1,seq:2,record})}\n`)]);
  await writeFile(stream,bytes);const manifest=JSON.parse(await readFile(file,'utf8'));
  manifest.replay={seq:2,sha256:createHash('sha256').update(bytes).digest('hex'),incomplete:false};
  await writeFile(file,JSON.stringify(manifest));const manifestBytes=await readFile(file);
  const result=await store.validate(id);
  expect(result).toMatchObject({integrityValid:false,resumable:false});
  expect(result.reasons).toContain('session replay contains provider continuation fields');
  expect(result.history.entries[1]!.record).toEqual(record);
  expect(await readFile(stream)).toEqual(bytes);expect(await readFile(file)).toEqual(manifestBytes);
 });
 it('sanitizes legacy provider events while retaining original replay and clean line bytes',async()=>{
  const {root,store,id,lease,file,stream}=await fixture();const legacy=await lease.read();await lease.release();
  await writeFile(file,JSON.stringify(legacy));
  const original=Buffer.concat([await readFile(stream),Buffer.from(' {"seq":2,"v":1,"record":{"type":"player_event","event":{"session_id":"secret-provider-legacy","payload":{"nativeSessionId":"secret-provider-native","thread":{"id":"secret-provider-thread"}},"type":"init"}}}\n {"seq":3,"v":1,"record":{"type":"future","sessionId":"logical-history"}}\n')]);
  await writeFile(stream,original);
  const result=await store.migrate(id);expect(result.migrated).toBe(true);
  const migrated=await readFile(stream,'utf8');expect(migrated).not.toContain('secret-provider-');
  expect(migrated).toContain(' {"seq":3,"v":1,"record":{"type":"future","sessionId":"logical-history"}}\n');
  expect(await readFile(join(root,'local','migrations',id,'inputs','1'))).toEqual(original);
  expect((await store.validate(id)).integrityValid).toBe(true);
  expect((await store.readHistory(id)).entries[1]!.record).toEqual({type:'player_event',event:{payload:{thread:{}},type:'init'}});
 });
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
 it('keeps later presentation outside the saved replay checkpoint',async()=>{
  const {store,id,lease,file,stream}=await fixture();const checkpointBytes=await readFile(file);const prefix=await readFile(stream);
  const checkpoint=JSON.parse(checkpointBytes.toString()).replay;
  await lease.append({type:'captain_telemetry',timestamp:1,topic:'playbook.trace',payload:{type:'session.disposed',sessionId:captainRuntimeId}});
  await lease.release();const history=await store.readHistory(id);const bytes=await readFile(stream);
  expect(history.lastReadableSeq).toBe(checkpoint.seq+1);
  expect(bytes.subarray(0,prefix.length)).toEqual(prefix);
  expect(createHash('sha256').update(prefix).digest('hex')).toBe(checkpoint.sha256);
  expect(createHash('sha256').update(bytes).digest('hex')).not.toBe(checkpoint.sha256);
  expect(await readFile(file)).toEqual(checkpointBytes);
  expect(await store.validate(id)).toMatchObject({integrityValid:true,resumable:true});
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
 it('keeps unknown manifests inspectable without interpreting or rewriting recovery',async()=>{
  const {store,id,lease,file,stream}=await fixture();await lease.release();
  const unknown={schemaVersion:99,sessionId:id,recovery:{future:true}};
  const bytes=JSON.stringify(unknown);await writeFile(file,bytes);const replayBytes=await readFile(stream);
  const validation=await store.validate(id);
  expect(validation.manifest).toEqual(unknown);expect(validation.resumable).toBe(false);
  expect(validation.reasons).toEqual(['unsupported session schema 99']);
  expect(validation.history.entries.length).toBeGreaterThan(0);
  expect(await readFile(file,'utf8')).toBe(bytes);expect(await readFile(stream)).toEqual(replayBytes);
  await unlink(stream);const missing=await store.validate(id);
  expect(missing.manifest).toEqual(unknown);expect(missing.integrityValid).toBe(false);expect(missing.resumable).toBe(false);
  expect(missing.reasons).toContain('unsupported session schema 99');
  expect(await readFile(file,'utf8')).toBe(bytes);await store.delete(id);
  await expect(readFile(file)).rejects.toMatchObject({code:'ENOENT'});
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
 it('moves the former default with its complete replay and retained original bytes',async()=>{
  const f=await legacyDefaultFixture();const report=await f.target.migrateLegacyDefault();
  expect(report).toEqual({sourceDir:f.sourceDir,migrated:[f.id],skipped:[]});
  const manifest=await f.target.readManifest(f.id);expect(manifest.schemaVersion).toBe(7);
  expect((await f.target.validate(f.id)).resumable).toBe(true);
  const replay=await readFile(join(f.target.sessionsDir,`${f.id}.records.jsonl`));expect(replay.subarray(0,f.replayBytes.length)).toEqual(f.replayBytes);
  const inputs=join(dirname(f.target.sessionsDir),'local','migrations',f.id,'inputs');
  expect(await readFile(join(inputs,'0'),'utf8')).toBe(f.sourceBytes);expect(await readFile(join(inputs,'1'))).toEqual(f.replayBytes);
  await expect(readFile(f.sourcePath)).rejects.toMatchObject({code:'ENOENT'});await expect(readFile(f.sourceReplay)).rejects.toMatchObject({code:'ENOENT'});
  const targetBytes=await readFile(join(f.target.sessionsDir,`${f.id}.json`));
  expect((await f.target.migrateLegacyDefault()).migrated).toEqual([]);expect(await readFile(join(f.target.sessionsDir,`${f.id}.json`))).toEqual(targetBytes);
  expect((await f.target.migrate(f.id,{sourcePath:f.sourcePath})).migrated).toBe(false);expect(await readFile(join(f.target.sessionsDir,`${f.id}.json`))).toEqual(targetBytes);
 });
 it('retains old-default inputs when source ownership or the destination blocks migration',async()=>{
  const f=await legacyDefaultFixture();const source=createSessionStore({sessionsDir:f.sourceDir});const sourceLease=await source.acquireManagement(f.id);
  await expect(f.target.migrateLegacyDefault()).rejects.toThrow('ownership is active');await sourceLease.release();
  const destinationLease=await f.target.acquireManagement(f.id);await expect(f.target.migrateLegacyDefault()).rejects.toMatchObject({code:'PLAYBOOK_SESSION_LEASE_ACTIVE'});await destinationLease.release();
  const destination=join(f.target.sessionsDir,`${f.id}.json`);await writeFile(destination,'unrelated destination',{mode:0o600});
  await expect(f.target.migrateLegacyDefault()).rejects.toThrow('destination manifest diverged');
  expect(await readFile(destination,'utf8')).toBe('unrelated destination');expect(await readFile(f.sourcePath,'utf8')).toBe(f.sourceBytes);expect(await readFile(f.sourceReplay)).toEqual(f.replayBytes);
 });
 it.each(['destination-publication','source-cleanup'])('retries a cross-directory migration interrupted during %s',async(phase)=>{
  const f=await legacyDefaultFixture();let fail=true;const destination=join(f.target.sessionsDir,`${f.id}.json`);
  const target=createSessionStore({...f.options,fsOps:{async rename(from,to){if(phase==='destination-publication'&&fail&&to===destination){fail=false;throw new Error('publication interrupted');}return rename(from,to);},async unlink(path){if(phase==='source-cleanup'&&fail&&path===f.sourcePath){fail=false;throw new Error('cleanup interrupted');}return unlink(path);}}});
  await expect(target.migrateLegacyDefault()).rejects.toThrow(/interrupted/);expect(await readFile(f.sourcePath,'utf8')).toBe(f.sourceBytes);
  const report=await f.target.migrateLegacyDefault();expect(report.migrated).toEqual([f.id]);expect((await f.target.validate(f.id)).resumable).toBe(true);
  const replay=await readFile(join(f.target.sessionsDir,`${f.id}.records.jsonl`));expect(replay.subarray(0,f.replayBytes.length)).toEqual(f.replayBytes);
  await expect(readFile(f.sourcePath)).rejects.toMatchObject({code:'ENOENT'});
 });
 it('reports unsupported old-default inputs unchanged and leaves absent defaults absent',async()=>{
  const f=await legacyDefaultFixture();const id=randomUUID();const path=join(f.sourceDir,`${id}.json`);const bytes=JSON.stringify({schemaVersion:99,sessionId:id});await writeFile(path,bytes,{mode:0o600});
  const result=await f.target.migrateLegacyDefault();expect(result.migrated).toEqual([f.id]);expect(result.skipped).toEqual([{sessionId:id,reason:'unsupported legacy schema 99'}]);expect(await readFile(path,'utf8')).toBe(bytes);
  const missing=join(f.root,'missing-home');const other=createSessionStore({homeDir:missing,env:{}});expect((await other.migrateLegacyDefault()).migrated).toEqual([]);await expect(stat(missing)).rejects.toMatchObject({code:'ENOENT'});
 });
 it('reads foreign-platform checkpoints as intact history and refuses native continuation',async()=>{
  const {store,id,lease,file,stream}=await fixture();await lease.release();const base=JSON.parse(await readFile(file,'utf8'));const replay=await readFile(stream);
  for(const cwd of ['/another/device/project',String.raw`C:\Users\owner\project`,String.raw`\\server\share\project`]){
   await writeFile(file,JSON.stringify({...base,cwd}));const validation=await store.validate(id,{cwd:process.cwd()});expect(validation.integrityValid).toBe(true);expect(validation.resumable).toBe(false);expect((await store.readSummary(id)).cwd).toBe(cwd);expect(await readFile(stream)).toEqual(replay);
  }
  for(const cwd of ['relative',String.raw`C:relative`,String.raw`\rooted`,String.raw`C:\a\..\b`,'/a/../b'])expect(()=>validateSessionManifest({...base,cwd})).toThrow('identity');
 });
 it('migrates desktop sidecars as history only without inventing recovery',async()=>{
  const root=await mkdtemp(join(tmpdir(),'desktop-migrate-'));roots.push(root);const store=createSessionStore({sessionsDir:join(root,'sessions')});await mkdir(store.sessionsDir,{mode:0o700});const id=randomUUID();
  const sidecar=join(store.sessionsDir,`${id}.spex.json`);const source=JSON.stringify({v:1,id,projectId:randomUUID(),createdAt:1,endedAt:2,live:false,players:[],initialVisible:[]});await writeFile(sidecar,source,{mode:0o600});
  const result=await store.migrate(id,{sourcePath:sidecar,cwd:process.cwd()});expect(result.manifest.state).toBe('history-only');expect((await store.validate(id)).resumable).toBe(false);await expect(readFile(sidecar)).rejects.toMatchObject({code:'ENOENT'});
 });
 it.each([false, true])('tightens legacy desktop inputs before migration (external=%s)',async(external)=>{
  const root=await mkdtemp(join(tmpdir(),'desktop-modes-'));roots.push(root);
  const target=join(root,'target');const sourceDir=external?join(root,'source'):target;
  await mkdir(sourceDir,{mode:0o755});const store=createSessionStore({sessionsDir:target});const id=randomUUID();
  const sidecar=join(sourceDir,`${id}.spex.json`);const stream=join(sourceDir,`${id}.records.jsonl`);
  const source=JSON.stringify({v:1,session:{id,projectId:randomUUID(),createdAt:1,endedAt:2,live:false,players:[],initialVisible:[]}});
  const replay=JSON.stringify({v:1,seq:1,record:{type:'captain_reply',timestamp:2,text:'desktop history'}})+'\n';
  await writeFile(sidecar,source,{mode:0o644});await writeFile(stream,replay,{mode:0o644});await chmod(sourceDir,0o755);
  const result=await store.migrate(id,{sourcePath:sidecar,cwd:process.cwd()});expect(result.manifest.state).toBe('history-only');
  expect((await stat(sourceDir)).mode&0o777).toBe(0o700);expect((await stat(join(target,`${id}.json`))).mode&0o777).toBe(0o600);
  expect(await readFile(join(root,'local','migrations',id,'inputs','0'),'utf8')).toBe(source);
  expect(await readFile(join(root,'local','migrations',id,'inputs','1'),'utf8')).toBe(replay);
  expect(await readFile(join(target,`${id}.records.jsonl`),'utf8')).toBe(replay);
 });
 it.each(['symlink','hardlink','owner-read-only'])('refuses unsafe %s desktop migration sources',async(kind)=>{
  const root=await mkdtemp(join(tmpdir(),'desktop-unsafe-'));roots.push(root);const sessionsDir=join(root,'sessions');await mkdir(sessionsDir,{mode:0o700});
  const store=createSessionStore({sessionsDir});const id=randomUUID();const original=join(root,'original');const sidecar=join(sessionsDir,`${id}.spex.json`);
  const source=JSON.stringify({v:1,id,createdAt:1,endedAt:2});await writeFile(original,source,{mode:0o600});
  if(kind==='symlink')await symlink(original,sidecar);else if(kind==='hardlink')await link(original,sidecar);else await writeFile(sidecar,source,{mode:0o400});
  await expect(store.migrate(id,{sourcePath:sidecar,cwd:process.cwd()})).rejects.toThrow('permission preparation refuses');
  expect(await readFile(original,'utf8')).toBe(source);expect(await readFile(sidecar,'utf8')).toBe(source);
  await expect(readFile(join(sessionsDir,`${id}.json`))).rejects.toMatchObject({code:'ENOENT'});
 });
 it.each([false,true])('retains a valid unterminated legacy replay record (external=%s)',async(external)=>{
  const f=await fixture();const legacy=await f.lease.read();await f.lease.release();await writeFile(f.file,JSON.stringify(legacy));
  const prefix=await readFile(f.stream);const tail=JSON.stringify({v:1,seq:2,record:{type:'captain_reply',timestamp:7,text:'last complete record'}});
  const original=Buffer.concat([prefix,Buffer.from(tail)]);await writeFile(f.stream,original);
  const target=external?createSessionStore({sessionsDir:join(f.root,'destination')}):f.store;
  const result=await target.migrate(f.id,{sourcePath:f.file});expect(result.manifest.state).toBe('settled');expect((await target.validate(f.id)).resumable).toBe(true);
  const replay=await readFile(join(target.sessionsDir,`${f.id}.records.jsonl`));expect(replay.subarray(0,original.length+1)).toEqual(Buffer.concat([original,Buffer.from('\n')]));
  expect(await readFile(join(f.root,'local','migrations',f.id,'inputs','1'))).toEqual(original);
  expect((await target.readHistory(f.id)).entries[1].record.text).toBe('last complete record');
 });
 it('skips history-only and unmigrated schema6 during discovery and fresh adoption',async()=>{
  const f=await fixture();const legacy=await f.lease.read();await f.lease.release();
  const legacyId=randomUUID();await writeFile(join(f.store.sessionsDir,`${legacyId}.json`),JSON.stringify({...legacy,sessionId:legacyId}),{mode:0o600});
  const historyId=randomUUID();const source=join(f.store.sessionsDir,`${historyId}.spex.json`);
  await writeFile(source,JSON.stringify({v:1,id:historyId,createdAt:Date.now()+1000,endedAt:Date.now()+2000}),{mode:0o644});
  await f.store.migrate(historyId,{sourcePath:source,cwd:process.cwd()});
  const skipped:any[]=[];expect((await f.store.latest({onLegacyRecord:r=>{skipped.push(r);}})).sessionId).toBe(f.id);
  expect(skipped.find(r=>r.sessionId===legacyId).reason).toContain('requires explicit migration');
  expect(skipped.find(r=>r.sessionId===historyId).reason).toContain('lacks complete durable recovery');
  const next=await f.store.acquire(randomUUID());const record=await next.initializeSettledWithPredecessor(freshBoundary() as any);expect(record.state).toBe('settled');await next.release();
  await f.store.delete(f.id);await f.store.delete(record.sessionId);await expect(f.store.latest()).rejects.toThrow('no resumable Captain session exists');
 });
 it.each(['digest','incomplete','context','path'])('refuses %s before embedding host imports or reconciliation',async(kind)=>{
  const f=await fixture();await f.lease.release();const manifest=JSON.parse(await readFile(f.file,'utf8'));
  if(kind==='digest')manifest.replay.sha256='0'.repeat(64);else if(kind==='incomplete')manifest.replay.incomplete=true;
  else if(kind==='context'){const entry=JSON.parse(await readFile(f.stream,'utf8'));entry.record.contextVersion=99;const bytes=JSON.stringify(entry)+'\n';await writeFile(f.stream,bytes);manifest.replay.sha256=createHash('sha256').update(bytes).digest('hex');}
  else manifest.cwd=String.raw`C:\Users\other\project`;
  await writeFile(f.file,JSON.stringify(manifest));let imports=0,hosts=0;
  await expect(openSessionHost({store:f.store,sessionId:f.id,mode:'continue',loadModule:async()=>{imports++;throw new Error('must not import');},createHostRuntime:async()=>{hosts++;throw new Error('must not start');}} as any)).rejects.toThrow();
  expect(imports).toBe(0);expect(hosts).toBe(0);expect(await f.store.readLeaseState(f.id)).toBe('idle');
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

 it.each([false,true])('preflights refused desktop sources without accumulating leases (external=%s)',async(external)=>{
  const root=await mkdtemp(join(tmpdir(),'migration-refusal-'));roots.push(root);
  const sessionsDir=join(root,'target');const sourceDir=external?join(root,'source'):sessionsDir;
  await mkdir(sessionsDir,{mode:0o700});if(external)await mkdir(sourceDir,{mode:0o700});
  const id=randomUUID();const sourcePath=join(sourceDir,`${id}.spex.json`);
  const valid={v:1,id,createdAt:1,endedAt:2,players:[],initialVisible:[]};
  const guards=async(dir:string)=>(await readdir(dir)).filter(name=>name.startsWith(`.${id}.lock`)).sort();
  for(const input of [{bytes:'{bad JSON',cwd:process.cwd()},{bytes:JSON.stringify({...valid,v:99}),cwd:process.cwd()},{bytes:JSON.stringify(valid),cwd:undefined}]){
   await writeFile(sourcePath,input.bytes,{mode:0o600});
   for(let restart=0;restart<3;restart++){
    const store=createSessionStore({sessionsDir});
    await expect(store.migrate(id,{sourcePath,...(input.cwd?{cwd:input.cwd}:{})})).rejects.toThrow();
    expect(await readFile(sourcePath,'utf8')).toBe(input.bytes);
    expect(await guards(sessionsDir)).toEqual([]);expect(await guards(sourceDir)).toEqual([]);
   }
  }
  // Supplying newly available context is sufficient; no refusal memo to clear.
  const store=createSessionStore({sessionsDir});
  const migrated=await store.migrate(id,{sourcePath,cwd:process.cwd()});expect(migrated.manifest.state).toBe('history-only');
  expect(await guards(sessionsDir)).toHaveLength(1);if(external)expect(await guards(sourceDir)).toHaveLength(1);
  const before=await guards(sessionsDir);expect(await readFile(join(sessionsDir,`${id}.json`),'utf8')).toContain('history-only');
  await expect(readFile(sourcePath)).rejects.toMatchObject({code:'ENOENT'});
  expect(await guards(sessionsDir)).toEqual(before);
 });

 it('revalidates migration source after acquiring ownership and retries repaired bytes',async()=>{
  const root=await mkdtemp(join(tmpdir(),'migration-preflight-race-'));roots.push(root);
  const sessionsDir=join(root,'sessions');await mkdir(sessionsDir,{mode:0o700});
  const id=randomUUID();const sourcePath=join(sessionsDir,`${id}.spex.json`);
  const valid=JSON.stringify({v:1,id,createdAt:1,endedAt:2,players:[],initialVisible:[]});
  const invalid=JSON.stringify({v:99,id,createdAt:1});await writeFile(sourcePath,valid,{mode:0o600});
  let replace=true;
  const store=createSessionStore({sessionsDir,fsOps:{rename:async(from:string,to:string)=>{
   await rename(from,to);
   if(replace&&to===join(sessionsDir,`.${id}.lock`)){replace=false;await writeFile(sourcePath,invalid);}
  }}});
  await expect(store.migrate(id,{sourcePath,cwd:process.cwd()})).rejects.toThrow('invalid legacy desktop');
  await expect(readFile(join(sessionsDir,`${id}.json`))).rejects.toMatchObject({code:'ENOENT'});
  const guards=async()=>(await readdir(sessionsDir)).filter(name=>name.startsWith(`.${id}.lock`)).sort();
  const refused=await guards();expect(refused).toHaveLength(1);
  for(let restart=0;restart<3;restart++)await expect(createSessionStore({sessionsDir}).migrate(id,{sourcePath,cwd:process.cwd()})).rejects.toThrow('invalid legacy desktop');
  expect(await guards()).toEqual(refused);expect(await readFile(sourcePath,'utf8')).toBe(invalid);
  await writeFile(sourcePath,valid);expect((await createSessionStore({sessionsDir}).migrate(id,{sourcePath,cwd:process.cwd()})).migrated).toBe(true);
  expect(await guards()).toHaveLength(2);
 });

});
