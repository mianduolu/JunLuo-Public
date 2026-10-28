/* Only new delayed-receipt/real-chat interleavings. Reuse the existing RAM fixture, never its old suite. */
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const assert=require('node:assert/strict');
const repo=path.resolve(__dirname,'../..');
const fixture=path.join(repo,'app/scripts/sleep-greeting-shared-contact-eval.cjs');
const fixtureText=fs.readFileSync(fixture,'utf8'),end=fixtureText.lastIndexOf('\nsuite().then(');
if(end<0)throw Error('RAM fixture entry boundary missing');
const fixtureModule=new Module(fixture,module);fixtureModule.filename=fixture;fixtureModule.paths=Module._nodeModulePaths(path.dirname(fixture));
fixtureModule._compile(fixtureText.slice(0,end)+'\nmodule.exports={harness,AT,MIN};',fixture);
const {harness,AT,MIN}=fixtureModule.exports;
function h(){return harness();}
const results=[];
const test=async(name,work)=>{try{await work();results.push({name,pass:true});}catch(error){results.push({name,pass:false,error:String(error.message)});}};
async function turnFixture({receiptFirst=false,finish}={}){
 const f=h(),s=f.load('life/sleepPlanStore'),p=f.load('life/sleepPlanPolicy');f.time(AT+14*MIN);
 const boundary=p.sleepGreetingBoundary(f.night(),f.state,f.now());
 const receipt={sessionId:'session',messageId:'saved-farewell',deliveredAt:f.now()};
 f.messages.push({id:receipt.messageId,role:'I',source:'proactive-message',content:'synthetic original',createdAt:f.now()});
 if(receiptFirst)await s.recordSleepGreetingDelivery(boundary,receipt);
 f.time(AT+14.5*MIN);const turn={sessionId:'session',turnId:'real-you',sourceMessageIds:['real-you'],now:f.now()};
 f.messages.push({id:turn.turnId,role:'you',content:'synthetic real response',createdAt:f.now()});
 await s.beginChatSleepTurn(turn);
 if(finish!==undefined){f.time(AT+14.75*MIN);await s.finishChatSleepTurn({...turn,now:f.now(),replySaved:finish});}
 return{f,s,p,boundary,receipt,turn};
}
async function confirmedFixture(phase='return',confirmed=true){
 const f=h();if(phase==='prepare'){
  const d=f.night();delete d.nightSleepPlan.actualSleepAt;d.sleepTargetAt=AT+30*MIN;d.nightSleepPlan.originalSleepAt=d.sleepTargetAt;d.nightSleepPlan.events=[];f.writeNight(d);
  f.state.wakeSource=undefined;f.state.manualWakeUntil=undefined;
 }
 f.time(AT+(phase==='return'?14:0)*MIN);const p=f.load('life/sleepPlanPolicy'),s=f.load('life/sleepPlanStore'),shared=f.load('proactive/unifiedContactStore');
 const boundary=p.sleepGreetingBoundary(f.night(),f.state,f.now()),messageId=phase==='return'?`sleep-plan:${boundary.nightKey}:return:${boundary.episodeId}`:`sleep-plan:${boundary.nightKey}:prepare`;
 const handle=await shared.beginSleepGreetingRequest({boundary,sessionId:'session',messageId,epoch:1,priorRequests:0});
 await s.recordSleepGreetingAttempt(boundary,handle.id);await shared.markSleepGreetingTransport(handle,1,'unknown');
 const message={id:messageId,role:'I',source:'proactive-message',content:'synthetic exact original',createdAt:f.now()};
 await shared.retainSharedSleepGreeting(handle.id,message,1);f.messages.push(message);
 if(phase==='prepare')await s.updateSleepOpportunity(boundary.nightKey,'prepare',()=>({status:'complete',requestCount:1,sessionId:'session',messageId,sharedContactId:handle.id}));
 if(confirmed)await shared.markSharedSleepGreetingDelivered(handle.id,f.now(),1);
 // The shared RAM fixture stubs ChatSleepSchedule; these cases explicitly execute its real public entry.
 delete f.stubs['chat/chatSleepSchedule'];
 f.stubs['tools/toolPermissions']={};f.stubs['chat/sleepInteraction']={recordSleepingMessage:async()=>{}};
 return{f,p,s,shared,boundary,message,handle};
}
async function main(){
 await test('late receipt keeps already accepted you in flight and counts it as round two',async()=>{
  const{f,s,boundary,receipt,turn}=await turnFixture();await s.recordSleepGreetingDelivery(boundary,receipt);
  const pending=f.night().nightSleepPlan.pendingSleep;
  assert.equal(pending.turnId,turn.turnId);assert.equal(pending.round,2);assert.equal(pending.turnEndedAt,undefined);
  assert.equal(pending.roundDeadlineAt,turn.now+5*MIN);
  assert.equal(await s.isChatSleepReplyCurrent({...turn,startedAt:turn.now,now:f.now()}),true);
 });
 await test('receipt-before-you and you-before-receipt preserve the same real turn timing',async()=>{
  const pairs=[];for(const first of [true,false]){const t=await turnFixture({receiptFirst:first});if(!first)await t.s.recordSleepGreetingDelivery(t.boundary,t.receipt);
   const p=t.f.night().nightSleepPlan.pendingSleep;pairs.push([p.round,p.turnId,p.roundStartedAt,p.roundDeadlineAt,p.greeting.waitingUntil,p.turnEndedAt]);}
  assert.deepEqual(pairs[0],pairs[1]);
 });
 await test('already saved real second reply keeps its own successful quiet period without a third round',async()=>{
  const{f,s,boundary,receipt}=await turnFixture({finish:true});const before=f.night().nightSleepPlan.pendingSleep;
  f.time(AT+17*MIN);await s.recordSleepGreetingDelivery(boundary,receipt);const after=f.night().nightSleepPlan.pendingSleep;
  assert.equal(after.round,2);assert.equal(after.turnId,before.turnId);assert.equal(after.dueAt,before.dueAt);
  assert.equal(after.greeting.deliveredAt,before.greeting.deliveredAt);
  await s.beginChatSleepTurn({sessionId:'session',turnId:'third-you',now:f.now()});assert.equal(f.night().nightSleepPlan.pendingSleep.turnId,before.turnId);
 });
 await test('failed real second reply uses original first delivery cutoff, not receipt recovery time',async()=>{
  const{f,s,p,boundary,receipt,turn}=await turnFixture({finish:false});f.time(AT+17*MIN);
  await s.recordSleepGreetingDelivery(boundary,receipt);const pending=f.night().nightSleepPlan.pendingSleep;
  assert.equal(pending.turnId,turn.turnId);assert.equal(pending.round,2);assert.equal(p.pendingSleepDueAt(f.night().nightSleepPlan),AT+19*MIN);
 });
 await test('same receipt repeated cannot reset accepted turn, round count or cutoff',async()=>{
  const{f,s,boundary,receipt}=await turnFixture();await s.recordSleepGreetingDelivery(boundary,receipt);
  const original=JSON.stringify(f.night().nightSleepPlan.pendingSleep);f.time(AT+18*MIN);await s.recordSleepGreetingDelivery(boundary,receipt);
  assert.equal(JSON.stringify(f.night().nightSleepPlan.pendingSleep),original);
 });
 await test('first delivery at expired cutoff is rejected without a new grace period',async()=>{
  const{f,s,boundary,receipt}=await turnFixture();const original=JSON.stringify(f.night().nightSleepPlan.pendingSleep);f.time(AT+16*MIN);
  assert.equal(await s.recordSleepGreetingDelivery(boundary,{...receipt,deliveredAt:AT+15*MIN}),false);
  assert.equal(JSON.stringify(f.night().nightSleepPlan.pendingSleep),original);
 });
 await test('old fragment receipt never rebinds a later awake episode real turn',async()=>{
  const{f,s,boundary,receipt}=await turnFixture();f.time(AT+16*MIN);await s.settleSleepNight(f.now());
  f.time(AT+20*MIN);await s.recordSleepPokeAwake(f.now(),AT+35*MIN);f.state.manualWakeUntil=AT+35*MIN;
  f.time(AT+31*MIN);await s.beginChatSleepTurn({sessionId:'session',turnId:'new-episode-you',now:f.now()});
  const original=JSON.stringify(f.night().nightSleepPlan.pendingSleep);await s.recordSleepGreetingDelivery(boundary,receipt);
  assert.equal(JSON.stringify(f.night().nightSleepPlan.pendingSleep),original);
 });
 await test('another session pending is acknowledged without replacement',async()=>{
  const{f,s,boundary,receipt}=await turnFixture();const d=f.night();d.nightSleepPlan.pendingSleep.sessionId='other-session';f.writeNight(d);
  const original=JSON.stringify(f.night().nightSleepPlan.pendingSleep);await s.recordSleepGreetingDelivery(boundary,receipt);
  assert.equal(JSON.stringify(f.night().nightSleepPlan.pendingSleep),original);
 });
 await test('actual accept after original poke deadline first acknowledges confirmed delivery and keeps real second round',async()=>{
  const{f,s,p}=await confirmedFixture();f.time(AT+16*MIN);const turn={sessionId:'session',turnId:'real-you',sourceMessageIds:['real-you'],now:f.now(),dataEpoch:1};
  f.messages.push({id:turn.turnId,role:'you',content:'synthetic real reply',createdAt:f.now()});
  await f.load('chat/chatSleepSchedule').acceptChatSleepMessage(turn);const pending=f.night().nightSleepPlan.pendingSleep;
  assert.equal(pending.turnId,turn.turnId);assert.equal(pending.round,2);assert.equal(pending.roundDeadlineAt,AT+21*MIN);
  assert.equal(await s.isChatSleepReplyCurrent({...turn,startedAt:turn.now}),true);
  assert.equal(f.night().nightSleepPlan.events.some(event=>event.kind==='sleep_return'),false);
  assert.equal(p.pendingSleepDueAt(f.night().nightSleepPlan),AT+21*MIN);assert.equal(f.requests.length,0);assert.equal(f.events.length,0);
 });
 await test('actual main accept before the last five minutes cannot be replaced by original I receipt',async()=>{
  const{f,s,p}=await confirmedFixture('prepare');f.time(AT+MIN);const turn={sessionId:'session',turnId:'real-main-you',sourceMessageIds:['real-main-you'],now:f.now(),dataEpoch:1};
  f.messages.push({id:turn.turnId,role:'you',content:'synthetic real reply',createdAt:f.now()});
  await f.load('chat/chatSleepSchedule').acceptChatSleepMessage(turn);const pending=f.night().nightSleepPlan.pendingSleep;
  assert.equal(pending.turnId,turn.turnId);assert.equal(pending.round,2);assert.equal(await s.isChatSleepReplyCurrent({...turn,startedAt:turn.now}),true);
  assert.equal(p.pendingSleepDueAt(f.night().nightSleepPlan),AT+30*MIN);assert.equal(f.requests.length,0);assert.equal(f.events.length,0);
 });
 await test('new public acknowledgement is local only and rejects missing delivery proof or changed exact I',async()=>{
  for(const variant of ['no-proof','changed-I','stale-epoch']){
   const{f,message}=await confirmedFixture('return',variant!=='no-proof');
   if(variant==='changed-I')f.messages.find(item=>item.id===message.id).content='different synthetic body';
   if(variant==='stale-epoch')f.restore();const original=JSON.stringify(f.night());
   assert.equal(await f.load('life/sleepPlanRuntime').recoverDeliveredSleepGreeting(1),false);
   assert.equal(JSON.stringify(f.night()),original);assert.equal(f.requests.length,0);assert.equal(f.events.length,0);
  }
 });
 await test('confirmed first receipt repeated before public accept never buys another round or resets quiet time',async()=>{
  const{f,s}=await confirmedFixture();const runtime=f.load('life/sleepPlanRuntime');await runtime.recoverDeliveredSleepGreeting(1);
  const first=JSON.stringify(f.night().nightSleepPlan.pendingSleep);f.time(AT+16*MIN);await runtime.recoverDeliveredSleepGreeting(1);
  assert.equal(JSON.stringify(f.night().nightSleepPlan.pendingSleep),first);
  const turn={sessionId:'session',turnId:'you-2',sourceMessageIds:['you-2'],now:f.now(),dataEpoch:1};
  f.messages.push({id:turn.turnId,role:'you',content:'synthetic response',createdAt:f.now()});await f.load('chat/chatSleepSchedule').acceptChatSleepMessage(turn);
  await runtime.recoverDeliveredSleepGreeting(1);const pending=f.night().nightSleepPlan.pendingSleep;
  assert.equal(pending.round,2);assert.equal(pending.turnId,turn.turnId);assert.equal(await s.isChatSleepReplyCurrent({...turn,startedAt:turn.now}),true);
 });
 console.log(JSON.stringify({source:'production',results,passed:results.filter(r=>r.pass).length,failed:results.filter(r=>!r.pass).length,models:0,device:false,realData:false},null,2));
 if(results.some(result=>!result.pass))process.exitCode=1;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
