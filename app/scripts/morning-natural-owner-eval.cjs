/* Run from repository root; --source-root selects only the four candidate sources. No legacy suite is executed. */
const fs=require('node:fs'), ts=require(require('node:path').join(process.cwd(),'app/node_modules/typescript')), assert=require('node:assert/strict');
let prefix=fs.readFileSync('app/scripts/morning-fresh-handoff-eval.cjs','utf8').split('\n(async () => {')[0].replace('const { harness, AT, MIN }','const { harness, AT, MIN, testedModules }').replace('return {harness,AT,MIN};','return {harness,AT,MIN,testedModules};');
prefix=prefix.replace("const changed = ['life/sleepPlanStore.ts', 'life/sleepPlanRuntime.ts', 'proactive/unifiedContactDispatch.ts'];", "const changed = ['life/sleepPlanRuntime.ts', 'life/lifeEngine.ts', 'proactive/proactiveMessages.ts', 'proactive/unifiedContactDispatch.ts'];");
const {early,drain,gate,AT,MIN,testedModules,test,results,assertDelivered,holdNear}=new Function('require',prefix+'\nreturn {early,drain,gate,AT,MIN,testedModules,test,results,assertDelivered,holdNear};')(require);
for(const id of ['life/lifeEngine','life/lifeTickExecutionOnceCore','ai/aiCallBudget','ai/aiCallBudgetStorage','ai/aiCallBudgetScope','ai/aiCallBudgetPolicy','runtime/automaticRemoteAiPolicyCore']) testedModules.add(id);
function lifePorts(h) {
 Object.assign(h.stubs,{
  'posts/baiyunPostGeneration':{maybePublishBaiyunPost:async()=>false,resumeSleepingBaiyunPostReply:async()=>true},
  'sync/syncExecutionOperationId':{createSyncExecutionOperationId:()=> 'synthetic-life-operation'},
  'ai/types':{defaultAiProfile:{}}, 'letters/letterDelivery':{maybeCreateContextualAiLetter:async()=>0},
  'life/autonomySettings':{defaultAutonomySettings:{},loadAutonomySettings:async()=>({}),isAutonomyFeatureEnabled:()=>false},
  'life/junluoDesireMetabolism':{JUNLUO_DESIRE_VISIBLE_THRESHOLD:100},
  'life/dreamEngine':{tryGenerateDream:async()=>false},'life/socialAgent':{runSocialDesireAction:async()=>false},
  'life/webVoyage':{runWebVoyageTick:async()=>false},
  'life/lifeTickExecutionOnce':{executeLifeTickOnce:async(_identity,ports)=>({executedNow:true,outcome:await ports.executeLocally()})},
  'life/lifePeriodicSyncCheckpoint':{beginLifePeriodicSyncCheckpoint:()=>null,loadLifePeriodicSyncCheckpoint:async()=>null},
  'posts/baiyunPostMemoryRuntime':{organizePostMemory:async()=>null,recoverPostMemoryOrganization:async()=>null},
  'gifts/giftReceptionRuntime':{runGiftReceptionTick:async()=>({requested:false})},
  'gifts/giftCreativeRuntime':{runGiftCreativeTick:async()=>({requested:false})},
 });
 h.stubs['life/readingActivityRuntime'].runReadingActivityTick=async()=>false;
 h.stubs['schedule/ownScheduleExecution'].runOwnScheduleExecution=async()=>false;
 h.stubs['life/ownDayPlanRuntime'].runOwnDayPlanTick=async()=>false;
}

const path=require('node:path'), root=process.cwd(), flag=process.argv.indexOf('--source-root');
const sourceRoot=flag<0?root:path.resolve(process.argv[flag+1]);
const onlyFlag=process.argv.indexOf('--only'), only=onlyFlag<0?null:new RegExp(process.argv[onlyFlag+1]);
const cases=[];
const add=(name,work)=>{if(!only||only.test(name))cases.push({name,work});};
const actualSource=relative=>fs.readFileSync(path.join(sourceRoot,relative),'utf8');
const input={apiKey:'synthetic',connection:{id:'synthetic',preset:'custom',model:'fixture',baseUrl:'https://invalid.example'},profile:{}};
function actualScheduler(h,withBudget=false) {
 delete h.stubs['ai/aiRuntimeScheduler']; delete h.stubs['backup/backupRestoreCoordinator'];
 if(withBudget) {
  delete h.stubs['ai/aiCallBudget'];
  h.stubs['expo-crypto']={randomUUID:()=>require('node:crypto').randomUUID()};
  h.stubs['sync/syncRemoteBudgetStorageBridge']={remoteBudgetStorageBridge:h.stubs['@react-native-async-storage/async-storage'].default,
   discardUnstartedCameraVisionBudgetCaptures:async()=>{},discardUnstartedReadingBudgetCaptures:async()=>{},discardUnstartedProactiveBudgetCaptures:async()=>{}};
 }
 return h.load('ai/aiRuntimeScheduler');
}
function ordinaryLifeBranch(h) {
 const source=ts.createSourceFile('proactiveMessages.ts',actualSource('app/src/proactive/proactiveMessages.ts'),ts.ScriptTarget.Latest,true);
 let branch;function visit(n){if(ts.isVariableDeclaration(n)&&n.name.getText(source)==='runOrdinaryContact')branch=n.initializer.getText(source);ts.forEachChild(n,visit);}visit(source);assert.ok(branch);
 const js=ts.transpileModule('const branch='+branch,{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.CommonJS}}).outputText;
 h.stubs['proactive/proactiveMessages'].maybeSendProactiveMessage=options=>new Function('resolveLifeCreativeConfig','loadAiConfigPreferencesSnapshot','runUnifiedContact',
  'profile','backupRestoreLeaseHeld','unifiedSchedulerHeld','naturalEarlyWakeOwner',js+';return branch();')(
   h.stubs['ai/AiConfigPreferences'].resolveLifeCreativeConfig,h.stubs['ai/AiConfigPreferences'].loadAiConfigPreferencesSnapshot,
   h.load('proactive/unifiedContactDispatch').runUnifiedContact,options.profile,options.backupRestoreLeaseHeld,options.unifiedSchedulerHeld,options.naturalEarlyWakeOwner);
}
function freshAfterAdvance(h) {
 h.stubs['life/lifeRhythm'].getSleepRecoveryProjection=async now=>({reliable:true,recovered:now>=AT+1500,recoveryAt:AT});
}
function nativeStatus(h) {
 const payload={id:'synthetic-status',nightKey:'2026-10-27',at:AT,phase:'sleep_status'};
 h.stubs['life/sleepNearStatusRuntime'].getSleepNearStatusWakeTasks=()=>[payload];
 h.stubs['life/sleepNearStatusRuntime'].runSleepNearStatusUpdate=async()=>false;
 return payload;
}
add('life local tail first writer hands to D before public completion',async()=>{
 const h=early();lifePorts(h);freshAfterAdvance(h);
 h.stubs['life/readingActivityRuntime'].runReadingActivityTick=async()=>{h.time(AT+1500);return false;};
 let skipNear;
 h.stubs['ai/assistantLife'].refreshAssistantLifeState=async options=>{if(options.sleepOpportunityChecked)skipNear=options.skipNearStatus;return{...h.state};};
 const result=await h.load('life/lifeEngine').runLifeTickFromStoredConfig({source:'active',force:true});
 assertDelivered(h);assert.equal(skipNear,true);assert.equal(result.proactiveMessageInserted,1);
 const first=early();lifePorts(first);
 const firstResult=await first.load('life/lifeEngine').runLifeTickFromStoredConfig({source:'active',force:true});
 assertDelivered(first);assert.equal(firstResult.proactiveMessageInserted,1,'same completed handoff is counted only once across later local drain');
});
add('life urgent owner waits actual budget scheduler record release then D and host completion',async()=>{
 const h=early();lifePorts(h);const scheduler=actualScheduler(h,true);ordinaryLifeBranch(h);freshAfterAdvance(h);
 h.stubs['ai/AiConfigPreferences'].resolveLifeCreativeConfig=()=>({apiKey:input.apiKey,connection:input.connection});
 h.stubs['ai/assistantLife'].refreshAssistantLifeState=async options=>{if(options.sleepOpportunityChecked)h.time(AT+1500);return{...h.state};};
 const recorded=gate(),release=gate(),response=gate(),generated=gate(),storage=h.stubs['@react-native-async-storage/async-storage'].default,set=storage.setItem;
 let held=false,returned=false;
 storage.setItem=async(k,v)=>{if(!held&&k==='junluo.aiRuntimeScheduler.v1'&&JSON.parse(v).records?.some(r=>r.kind==='proactive'&&r.status==='success')){
  held=true;recorded.open();await release.promise;}return set(k,v);};
 h.onCompletion=async()=>{generated.open();await response.promise;};
 const work=h.load('life/lifeEngine').runLifeTickFromStoredConfig({source:'foreground'}).then(value=>{returned=true;return value;});
 try {
  await recorded.promise;await drain();assert.equal(h.night().nightSleepPlan.morningAwakeAt,AT+1500);
  assert.equal(h.requests.length,0);assert.equal(returned,false);
  assert.equal((await scheduler.loadAiRuntimeSnapshot()).current.kind,'proactive');
  release.open();await Promise.race([generated.promise,work.then(()=>assert.fail('natural outer returned without starting its fresh D'))]);
  await drain();assert.equal(returned,false);assert.equal(h.requests.length,1);
  response.open();const value=await work;assertDelivered(h);assert.equal(value.proactiveMessageInserted,1);
  assert.equal((await scheduler.loadAiRuntimeSnapshot()).current,null);
 }finally{release.open();response.open();}
});
add('native valid sleep_status host waits response and original save',async()=>{
 const h=early(),payload=nativeStatus(h),generated=gate(),release=gate();let returned=false;
 h.onCompletion=async()=>{generated.open();await release.promise;};
 const work=h.load('life/sleepPlanRuntime').handleSleepPlanTask(payload).then(()=>{returned=true;});
 try{await generated.promise;await drain();assert.equal(returned,false);assert.equal(h.night().nightSleepPlan.wake.status,'requesting');
  assert.equal(h.messages.filter(x=>x.id==='sleep-plan:2026-10-27:wake').length,0);
 }finally{release.open();}
 await work;assertDelivered(h);
});
add('natural D attempted failure is handled without reporting an inserted message',async()=>{
 const h=early();lifePorts(h);actualScheduler(h,true);ordinaryLifeBranch(h);freshAfterAdvance(h);
 h.stubs['ai/AiConfigPreferences'].resolveLifeCreativeConfig=()=>({apiKey:input.apiKey,connection:input.connection});
 h.stubs['ai/assistantLife'].refreshAssistantLifeState=async options=>{if(options.sleepOpportunityChecked)h.time(AT+1500);return{...h.state};};
 h.transportFailure=true;
 const result=await h.load('life/lifeEngine').runLifeTickFromStoredConfig({source:'foreground'});
 assert.ok(h.requests.length>0);assert.equal(h.messages.filter(x=>x.id==='sleep-plan:2026-10-27:wake').length,0);
 assert.equal(result.proactiveMessageInserted,0);assert.equal(h.night().nightSleepPlan.wake.status,'failed');
});
add('successful D counts its exact saved message when delivery receipt is later than creation',async()=>{
 const h=early();lifePorts(h);actualScheduler(h,true);ordinaryLifeBranch(h);freshAfterAdvance(h);
 h.stubs['ai/AiConfigPreferences'].resolveLifeCreativeConfig=()=>({apiKey:input.apiKey,connection:input.connection});
 h.stubs['ai/assistantLife'].refreshAssistantLifeState=async options=>{if(options.sleepOpportunityChecked)h.time(Math.max(h.now(),AT+1500));return{...h.state};};
 const chat=h.stubs['chat/chatStorage'],append=chat.appendMessagesToChatSession;
 chat.appendMessagesToChatSession=async(...args)=>{const result=await append(...args);h.time(h.now()+25);return result;};
 const result=await h.load('life/lifeEngine').runLifeTickFromStoredConfig({source:'foreground'});
 assertDelivered(h);const saved=h.messages.find(x=>x.id==='sleep-plan:2026-10-27:wake');
 assert.ok(h.night().nightSleepPlan.wake.deliveredAt>saved.createdAt);assert.equal(result.proactiveMessageInserted,1);
});
add('first direct tick waits complete original commit before entering D',async()=>{
 const h=early(),commit=gate(),release=gate();actualScheduler(h);
 let first=true,returned=false;
 h.stubs['ai/assistantLife'].refreshAssistantLifeState=async()=>{if(first){first=false;commit.open();await release.promise;}return{...h.state};};
 const work=h.load('life/sleepPlanRuntime').runSleepPlanTick().then(value=>{returned=true;return value;});
 try{await commit.promise;await drain();assert.equal(h.requests.length,0);assert.equal(returned,false);}finally{release.open();}
 assert.equal(await work,true);assertDelivered(h);
});
add('two simultaneous direct ticks admit exactly one D and one shared allowance',async()=>{
 const h=early(),runtime=h.load('life/sleepPlanRuntime');
 await Promise.all([runtime.runSleepPlanTick(),runtime.runSleepPlanTick()]);assertDelivered(h);assert.equal((await h.ledger()).used,1);
});
add('late fresh writer while an active tick exists keeps both public tick hosts until D save',async()=>{
 const h=early(),entered=gate(),release=gate(),generated=gate(),response=gate();let first=true,recovered=false,a=false,b=false;
 h.stubs['life/lifeRhythm'].getSleepRecoveryProjection=async()=>({reliable:true,recovered,recoveryAt:AT});
 const chat=h.stubs['chat/chatStorage'],read=chat.loadChatStateFast;
 chat.loadChatStateFast=async options=>{const value=await read(options);if(first&&options.activeMessageLimit===24){first=false;entered.open();await release.promise;}return value;};
 h.onCompletion=async()=>{generated.open();await response.promise;};
 const runtime=h.load('life/sleepPlanRuntime'),one=runtime.runSleepPlanTick().then(()=>{a=true;});await entered.promise;recovered=true;
 const two=runtime.runSleepPlanTick().then(()=>{b=true;});await drain();assert.equal(h.requests.length,0);
 try{release.open();await generated.promise;await drain();assert.equal(a,false);assert.equal(b,false);}
 finally{release.open();response.open();}
 await Promise.all([one,two]);assertDelivered(h);assert.equal((await h.ledger()).used,1);
});
add('same unified run public joiners both await its fresh D while internal done stays separate',async()=>{
 const h=early(),entered=gate(),release=gate(),generated=gate(),response=gate();let first=true,a=false,b=false;
 h.stubs['proactive/proactiveDeviceControlAndroid'].ensureAndroidProactiveDeviceControl=async()=>{
  if(first){first=false;entered.open();await release.promise;}
 };
 h.onCompletion=async()=>{generated.open();await response.promise;};
 const dispatch=h.load('proactive/unifiedContactDispatch');
 const one=dispatch.runUnifiedContact(input).then(()=>{a=true;});await entered.promise;
 const captured=dispatch.captureUnifiedContactRun();let internalDone=false;captured.done.then(()=>{internalDone=true;});
 const two=dispatch.runUnifiedContact(input).then(()=>{b=true;});
 try{release.open();await generated.promise;await drain();
  assert.equal(internalDone,true);assert.equal(a,false);assert.equal(b,false);
  assert.notEqual(dispatch.captureUnifiedContactRun(),captured);
 }finally{release.open();response.open();}
 await Promise.all([one,two]);assertDelivered(h);
});
add('new unified owner after original early release is neither cleared nor followed',async()=>{
 const h=early(),tail=gate(),release=gate(),next=gate(),nextRelease=gate();
 let tailCount=0,starts=0,recovered=true;
 const runtime=h.load('life/sleepPlanRuntime'),original=runtime.reconcileSleepPlanLocally;
 runtime.reconcileSleepPlanLocally=async(...args)=>{const value=await original(...args);
  if(++tailCount===1){tail.open();await release.promise;}return value;};
 h.stubs['proactive/proactiveDeviceControlAndroid'].ensureAndroidProactiveDeviceControl=async()=>{
  if(++starts===2){next.open();await nextRelease.promise;}
 };
 const dispatch=h.load('proactive/unifiedContactDispatch'),one=dispatch.runUnifiedContact(input);await tail.promise;
 const two=dispatch.runUnifiedContact(input);await next.promise;const secondOwner=dispatch.captureUnifiedContactRun();
 try{release.open();await one;assert.equal(dispatch.captureUnifiedContactRun(),secondOwner);assert.equal(h.requests.length,0);}
 finally{release.open();nextRelease.open();}
 await two;await drain();assert.equal(h.requests.length,0);assert.equal(dispatch.captureUnifiedContactRun(),undefined);
});
add('held without declared natural outer owner remains refused through actual scheduler finally',async()=>{
 const h=early(),scheduler=actualScheduler(h),recorded=gate(),release=gate();
 const storage=h.stubs['@react-native-async-storage/async-storage'].default,set=storage.setItem;let held=false;
 storage.setItem=async(k,v)=>{if(!held&&k==='junluo.aiRuntimeScheduler.v1'&&JSON.parse(v).records?.some(r=>r.kind==='fixture-urgent')){
  held=true;recorded.open();await release.promise;}return set(k,v);};
 const work=scheduler.runScheduledAiCall('fixture-urgent','urgent',()=>h.load('proactive/unifiedContactDispatch').runUnifiedContact({...input,schedulerHeld:true}));
 try{await recorded.promise;await drain();assert.equal(h.requests.length,0);assert.equal(h.night().nightSleepPlan.morningAwakeAt,AT);
  assert.equal((await scheduler.loadAiRuntimeSnapshot()).current.kind,'fixture-urgent');}
 finally{release.open();}
 await work;await drain();assert.equal(h.requests.length,0);assert.equal(h.night().nightSleepPlan.wake,undefined);
});
add('default local maintenance and false life outer never acquire a request',async()=>{
 for(const method of ['reconcileSleepPlan','reconcileSleepPlanLocally']){
  const h=early();await h.load('life/sleepPlanRuntime')[method]();await drain();assert.equal(h.requests.length,0);
 }
 const h=early();lifePorts(h);freshAfterAdvance(h);
 h.stubs['life/readingActivityRuntime'].runReadingActivityTick=async()=>{h.time(AT+1500);return false;};
 await h.load('life/lifeEngine').runLifeTickFromStoredConfig({source:'active',force:true,localOnly:true});
 assert.equal(h.night().nightSleepPlan.morningAwakeAt,AT+1500);assert.equal(h.requests.length,0);
});
add('a different natural caller cannot claim an unrelated held scheduler owner',async()=>{
 const h=early(),scheduler=actualScheduler(h),entered=gate(),release=gate(),recorded=gate(),recordRelease=gate();let first=true;
 h.stubs['proactive/proactiveDeviceControlAndroid'].ensureAndroidProactiveDeviceControl=async()=>{if(first){first=false;entered.open();await release.promise;}};
 const storage=h.stubs['@react-native-async-storage/async-storage'].default,set=storage.setItem;let held=false;
 storage.setItem=async(k,v)=>{if(!held&&k==='junluo.aiRuntimeScheduler.v1'&&JSON.parse(v).records?.some(r=>r.kind==='unrelated-urgent')){
  held=true;recorded.open();await recordRelease.promise;}return set(k,v);};
 const outer=scheduler.runScheduledAiCall('unrelated-urgent','urgent',()=>h.load('proactive/unifiedContactDispatch').runUnifiedContact({...input,schedulerHeld:true}));
 await entered.promise;const other=h.load('life/sleepPlanRuntime').runSleepPlanTick();await drain();
 try{release.open();await recorded.promise;await other;assert.equal(h.requests.length,0);assert.equal(h.night().nightSleepPlan.wake,undefined);}
 finally{release.open();recordRelease.open();}
 await outer;await drain();assert.equal(h.requests.length,0);
});
for(const invalid of ['off','epoch','expiry','poke','return','terminal','unknown','paid']){
 add('captured natural fact refuses '+invalid+' before drain without retry',async()=>{
  const h=early(),entered=gate(),release=gate();let first=true;
  h.stubs['life/sleepNativeWake'].replaceSleepNativeWakeTasks=async()=>{if(first){first=false;entered.open();await release.promise;}};
  const work=h.load('life/sleepPlanRuntime').handleSleepPlanTask(nativeStatus(h));await entered.promise;
  const day=h.night();
  if(invalid==='off')h.auto(false);
  if(invalid==='epoch')h.restore();
  if(invalid==='expiry')h.time(AT+60*MIN);
  if(invalid==='poke')day.nightSleepPlan.events.push({id:'poke',kind:'poke_awake',at:AT+1,until:AT+MIN});
  if(invalid==='return')day.nightSleepPlan.events.push({id:'return',kind:'sleep_return',at:AT+1});
  if(invalid==='terminal')day.nightSleepPlan.wake={status:'skipped',requestCount:0};
  if(invalid==='unknown')day.nightSleepPlan.wake={status:'requesting',requestCount:1};
  if(invalid==='paid')day.nightSleepPlan.wake={status:'complete',requestCount:1};
  h.writeNight(day);release.open();await work;await drain();assert.equal(h.requests.length,0);
 });
}
add('natural native error preserves saved fresh fact and original rejection after D',async()=>{
 const h=early(),error=Error('synthetic-native'),payload=nativeStatus(h);let first=true;
 h.stubs['life/sleepNativeWake'].replaceSleepNativeWakeTasks=async()=>{if(first){first=false;throw error;}};
 await assert.rejects(h.load('life/sleepPlanRuntime').handleSleepPlanTask(payload),actual=>actual===error);assertDelivered(h);
});
add('cold saved morning is not a new natural fact',async()=>{
 const h=early();await h.load('life/sleepPlanStore').settleSleepNight(AT);h.cold();
 await h.load('life/sleepPlanRuntime').handleSleepPlanTask(nativeStatus(h));await drain();assert.equal(h.requests.length,0);
});
let externalRequests=0;
const originalFetch=globalThis.fetch;
globalThis.fetch=async()=>{externalRequests++;throw Error("unexpected external fetch in RAM suite");};
(async()=>{
 assert.ok(cases.length>0);
 for(const row of cases)await test(row.name,row.work);
 assert.equal(results.length,cases.length,'all selected groups must finish');
 const failed=results.filter(x=>!x.passed).length;
 assert.equal(externalRequests,0,"no external fetch may escape the RAM ports");
 console.log(JSON.stringify({sourceRoot,passed:results.length-failed,failed,groups:results.length,externalRequests,
  scope:'actual four sources; original shared-contact RAM ports; actual scheduler/budget/commit where named; life ordinary arrow extracted, unrelated outlets stubbed'}));
 if(failed)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;})
 .finally(()=>{globalThis.fetch=originalFetch;});


