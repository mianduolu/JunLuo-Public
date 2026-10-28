/* Production-source RAM regression: no device, disk-backed App data, real transport, or native scheduler. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const sourceRoot = path.resolve(__dirname, '../src');
const testedModules = new Set(["ai/assistantNearStatus","chat/chatSleepSchedule","life/sleepPlanGeneration","life/sleepPlanPolicy","life/sleepPlanRuntime","life/sleepPlanStore","proactive/unifiedContact","proactive/unifiedContactDispatch","proactive/unifiedContactHandoff","proactive/unifiedContactRuntime","proactive/unifiedContactStore","sync/syncAssistantLifeState","sync/syncAssistantLifeStateMerge"]);
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const MIN = 60000;
const AT = Date.parse('2026-10-28T01:00:00+08:00');
let passed = 0;
const test = async (name, work) => { await work(); passed++; process.stdout.write(`PASS ${name}\n`); };

function harness() {
  const cache = new Map(), raw = new Map(), days = new Map();
  let now = AT, epoch = 1, auto = true, enabled = true, chatBusy = false, pause = null, activeLane = null;
  const state = { lifeMode: 'available', wakeSource: 'poke', manualWakeUntil: AT + 15 * MIN, updatedAt: AT };
  const messages = [{ id: 'you-1', role: 'you', content: 'synthetic', createdAt: AT - 1000 }];
  const events = [], requests = [];
  const dateKey = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  const day = (key = '2026-10-27') => ({ dateKey: key, createdAt: AT - 24*60*MIN,
    sleepTargetAt: AT - 60*MIN, wakeTargetAt: AT + 8*60*MIN, deviations: [], segments: [], timelineEntries: [],
    nightSleepPlan: { originalSleepAt: AT - 60*MIN, originalWakeAt: AT + 8*60*MIN, actualSleepAt: AT - 60*MIN,
      revision: 0, events: [{ id: `poke:${AT}`, kind: 'poke_awake', at: AT, until: AT+15*MIN }] } });
  days.set('2026-10-27', day());
  const storage = { getItem: async key => raw.get(key) ?? null,
    setItem: async (key, value) => { raw.set(key,value); if(key.startsWith('day:')) days.set(key.slice(4), JSON.parse(value)); },
    removeItem: async key => raw.delete(key),
    multiSet: async entries => { for(const [key,value] of entries) await storage.setItem(key,value); },
    multiGet: async keys => Promise.all(keys.map(async key => [key,await storage.getItem(key)])) };
  const timeline = {
    loadAssistantLifeDay: async key => clone(days.get(key)), loadAssistantLifeDays: async keys => keys.map(key => clone(days.get(key))),
    saveAssistantLifeDay: async value => { days.set(value.dateKey, clone(value)); }, listAssistantLifeDays: async () => [...days.keys()],
    getAssistantLifeDayKey: key => `day:${key}`, getLocalDateKey: dateKey,
    ensureAssistantLifeDay: async time => {
      const key = dateKey(new Date(time)); if(!days.has(key)) {
        const value = day(key); delete value.nightSleepPlan; days.set(key,value);
      } return clone(days.get(key));
    }, getLifeScheduleSlot: () => 'test', resolveAssistantLifeSegment: () => ({ lifeMode: 'available' }),
  };
  const chat = { loadChatStateFast: async ({activeMessageLimit = 24} = {}) => ({ activeSessionId: 'session',
    sessions: [{ id:'session', messageCount:messages.length, messages:clone(activeMessageLimit ? messages.slice(-activeMessageLimit) : []) }] }),
    loadChatSessionMessage: async (session,id) => clone(messages.find(value=>value.id===id)) ?? null,
    loadChatSessionMessagePage: async(_session,{beforeIndex,limit})=>({startIndex:Math.max(0,beforeIndex-limit),messages:clone(messages.slice(Math.max(0,beforeIndex-limit),beforeIndex))}),
    appendMessagesToChatSession: async (session, incoming, options) => {
      if(h.failAppend) throw Error('synthetic-save-failure');
      if(options?.beforeAppend && !await options.beforeAppend(clone(messages))) return { messages:clone(messages) };
      for(const message of incoming) if(!messages.some(value=>value.id===message.id)) messages.push(clone(message));
      return { messages:clone(messages) };
    } };
  const stubs = {
    '@react-native-async-storage/async-storage': { __esModule:true, default:storage },
    'react-native': { Platform: { OS:'android' } },
    'expo-notifications': { scheduleNotificationAsync:async () => undefined },
    'ai/assistantLifeTimeline': timeline,
    'ai/assistantState': { loadAssistantState:async()=>clone(state), saveAssistantState:async (_,value)=>Object.assign(state,value), subscribeAssistantStateChanged:()=>()=>{} },
    'ai/assistantLife': { refreshAssistantLifeState:async()=>clone(state) },
    'ai/subjectiveMessages': { cleanAssistantMessageContent:value=>value },
    'ai/promptCacheMetrics': { fingerprintPromptText: value=>require('node:crypto').createHash('sha256').update(value).digest('hex') },
    'ai/assistantLifePromptEnvelope': {
      buildAssistantStatePairEnvelope:async()=>({stableSystemPrompt:'PERSONA'}),
      fetchAssistantLifeCompletion:async input=>{
        await input.onRequestStart?.(async()=>{ if(h.preparationFailure) throw Error('synthetic-preparation'); });
        requests.push(input); input.onTransportAttempt?.({outcome:'started',startedAt:now});
        if(h.transportFailure) throw Error('synthetic-transport');
        if(h.onCompletion) await h.onCompletion(input);
        const content = '{"message":"synthetic farewell"}';
        return {content, payload:{choices:[{message:{content}}]}};
      },
    },
    'ai/assistantLifeShortJsonRequest': {buildAssistantLifeShortJsonRequest:()=>({temperature:0.7})},
    'ai/ambientContext': {getAmbientTimeContext:()=>''},
    'ai/shortJsonObjects': {readJsonObjects:text=>[JSON.parse(text)]},
    'ai/AiConfigPreferences': {loadAiConfigPreferencesSnapshot:async()=>({profile:{}}),resolveLifeCreativeConfig:()=>({apiKey:'synthetic',connection:{model:'fixture',baseUrl:'https://invalid.example'}})},
    'ai/aiCallBudget': {runBudgetedAiCall:async (kind,priority,work)=>h.strictScheduler? scheduled(kind,priority,work):({ok:true,value:await work()}),getProactiveBudgetRetryAt:async()=>null},
    'ai/aiRuntimeScheduler': { isChatReplyInFlight:()=>chatBusy, runScheduledAiCall:(kind,priority,work)=>h.strictScheduler? scheduled(kind,priority,work):Promise.resolve().then(async()=>({ok:true,value:await work()})) },
    'ai/retiredAssistantFeatureData': {RETIRED_SOCIAL_SHARE_QUEUE_KEY:'retired'},
    'backup/backupRestoreCoordinator': {captureBackupRestoreDataEpoch:()=>epoch,
      canCommitBackupRestoreDataEpoch:value=>value===epoch,
      runBackupRestoreDataEpochCommit:async(value,work)=>value===epoch?{committed:true,value:await work()}:{committed:false} },
    'chat/chatStorage': chat, 'chat/chatMessageEvents': {emitChatMessagesAppended:event=>events.push(clone(event))},
    'chat/chatSleepSchedule': {isLiveChatSleepTurn:()=>false},
    'focus/focusStore': {loadActiveFocusSession:async()=>h.focus ?? null},
    'runtime/automaticRemoteAiPolicy': {loadAutomaticRemoteAiPolicy:async()=>({enabled:auto}),isAutomaticRemoteAiAllowed:policy=>policy.enabled},
    'runtime/phonePrimaryRuntime': {ensurePhonePrimaryActivation:async()=>true,loadPhonePrimaryActivation:async()=>true},
    'life/junluoDesireRuntime': {loadJunluoDesirePromptPaper:async()=>''},
    'life/lifeRhythm': {getRhythmSnapshot:async()=>null,getSleepRecoveryProjection:async()=>({reliable:false,recovered:false}),runRhythmTick:async()=>{}},
    'life/junluoRelationshipPolicy': {isJunluoAutomaticRelationshipOutletAllowed:()=>true},
    'life/sleepNearStatusRuntime': {ensureSleepNearStatusSlots:async day=>day,getSleepNearStatusWakeTasks:()=>[],resetSleepNearStatusAfterRestore:async()=>{}},
    'life/sleepNativeWake': {replaceSleepNativeWakeTasks:async()=>{}},
    'life/readingActivityRuntime': {getReadingActivityWakeTask:async()=>null},
    'life/ownDayPlanRuntime': {getOwnDayPlanWakeTask:async()=>null},
    'schedule/ownScheduleExecution': {getOwnScheduleWakeAt:async()=>null},
    'proactive/proactiveMessages': {loadProactiveMessageSettings:async()=>({enabled})},
    'proactive/unifiedContactDispatch': {getNextUnifiedContactAt:async()=>null},
    'proactive/unifiedContactScheduleRecovery': {recordContactScheduleRecoveryProvided:async()=>{}},
    'proactive/phoneEmergencyContact': {recordPhoneEmergencyHandled:()=>{}},
    'proactive/unifiedContactWeeklyReview': {recordContactWeeklyReviewProvided:async()=>{}},
    'sync/syncAssistantLifeStateStorageBridge': {assistantLifeStateStorageBridge:storage},
    'sync/syncRelationshipAuthorizationStorageBridge': {relationshipAuthorizationStorageBridge:storage},
    'sync/syncOwnDayPlanState': {assertOwnDayPlanNight:()=>{},mergeOwnDayPlanState:()=>undefined},
    'sync/syncProtocol': {assertJsonValue:value=>assert.doesNotThrow(()=>JSON.stringify(value)), assertPlainMutationV1:()=>{}},
    'life/junluoInnerState': {JUNLUO_DESIRE_IDS:[],BAIYUN_EMOTION_IDS:[]},
    'life/junluoInnerStatePersistence': {},
    'tools/builtin/lifeSleepTools': {sleepScheduleWriteTool:{id:'life.set_sleep_schedule'},sleepScheduleToolPackage:{},sleepScheduleToolFor:()=>({id:'life.set_sleep_schedule'})},
    'tools/toolRegistry': {getToolDefinition:()=>true,registerToolPackage:()=>{}},
    'tools/toolExecution': {executeToolCall:async()=>{throw Error('unexpected tool execution');}},
    'tools/toolCallProtocol': {parseOpenAiToolCalls:()=>({rawCallCount:0,invocations:[],errors:[]}),toolDefinitionToOpenAiTool:tool=>tool},
    'ai/assistantNearStatusRuntime': {runSleepTransitionNearStatusUpdate:async()=>{}},
  };
  async function scheduled(kind,priority,work) {
    if(activeLane) return {ok:false,reason:`busy:${activeLane}`,skipped:true};
    activeLane=kind;try{return {ok:true,skipped:false,value:await work()};}finally{activeLane=null;}
  }
  function load(key) {
    if(stubs[key]) return stubs[key];
    if(cache.has(key)) return cache.get(key).exports;
    assert.ok(testedModules.has(key), 'UNSTUBBED '+key);
    const file = path.join(sourceRoot,key+'.ts');
    if(!fs.existsSync(file)) throw Error(`UNSTUBBED ${key}`);
    const module = {exports:{}}; cache.set(key,module);
    const source=fs.readFileSync(file,'utf8');
    const result=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2023,esModuleInterop:true},reportDiagnostics:true});
    const errors=(result.diagnostics??[]).filter(d=>d.category===ts.DiagnosticCategory.Error);
    assert.equal(errors.length,0, errors.map(d=>ts.flattenDiagnosticMessageText(d.messageText,' ')).join('\n'));
    const FakeDate=class extends Date { constructor(...args){super(...(args.length?args:[now]));} static now(){return now;} };
    vm.runInNewContext(`(function(require,module,exports){${result.outputText}\n})`,{Date:FakeDate,AbortController,setTimeout,clearTimeout,console,
      Map,Set,Promise,JSON,Number,Object,Array,Error})(request=>{
      if(request.startsWith('.')) return load(path.posix.normalize(path.posix.join(path.posix.dirname(key),request)));
      return load(request);
    },module,module.exports);
    return module.exports;
  }
  const h = {load,stubs,raw,days,state,messages,events,requests,day,
    time:value=>{now=value;}, now:()=>now, auto:value=>{auto=value;}, enabled:value=>{enabled=value;}, busy:value=>{chatBusy=value;},
    restore:()=>{epoch++;}, epoch:()=>epoch, night:()=>clone(days.get('2026-10-27')),
    writeNight:value=>days.set('2026-10-27',clone(value)),
    phase:()=>load('life/sleepPlanPolicy').nightSleepPhaseAt(h.night(),now),
    ledger:async()=>load('proactive/unifiedContactStore').readUnifiedContactState(),
    cold:()=>{cache.clear();},
    withLane:async work=>{activeLane='life-urgent';try{return await work();}finally{activeLane=null;}},
    lane:()=>activeLane,
    enableDispatch:()=>{
      h.strictScheduler=true;delete stubs['proactive/unifiedContactDispatch'];
      const own={id:'synthetic-own',version:'v1',text:'ORIGINAL SELECTED LIFE',own:'experience'};
      Object.assign(stubs,{
        'proactive/proactiveDeviceControl':{getProactiveDeviceControl:()=>undefined},
        'proactive/proactiveDeviceControlAndroid':{ensureAndroidProactiveDeviceControl:async()=>{}},
        'ai/assistantNearStatus':{selectNearStatusConversation:rows=>rows},
        'life/junluoInnerStateStore':{loadJunluoAffectState:async()=>({relationshipPhase:{phase:'synthetic'},updatedAt:AT}),loadJunluoDesireState:async()=>({desires:{}})},
        'ai/qwenChatLayout':{isSiliconQwenChatConnection:()=>false,QwenChatSourceInvalid:class extends Error{},isQwenChatSourceDeferred:()=>false},
        'bodySignal/bodySignalProactiveCareRuntime':{loadPriorityHeartContact:async()=>null},
        'period/periodCareEvents':{loadPriorityPeriodContact:async()=>null},
        'chat/chatAuxiliaryDiagnostics':{runChatAuxiliaryOperation:async(_meta,work)=>({ok:true,value:await work()})},
        'backend/phoneLimitActionNative':{readPhoneLimitActionQuery:async()=>null},
        'backend/phoneRestrictionNative':{readPhoneRestrictionUsage:async()=>null},
        'backend/phoneActivityNative':{getInstalledPhoneApps:async()=>[]},
        'proactive/contactWaiting':{ORDINARY_CONTACT_ID_PREFIX:'unified-contact:ordinary:',loadContactWaitingMessages:async()=>[],selectContactWaiting:()=>undefined},
        'ai/lifeMaterialHub':{buildNearStatusLifeMaterialSnapshot:async()=>({items:[]}),isFocusSummaryLifeMaterialId:()=>false},
        'proactive/unifiedContactShares':{prepareUnifiedContactShares:async()=>[]},
        'proactive/unifiedContactOwnLife':{isContactOwnLifeId:id=>id==='synthetic-own',prepareContactOwnLife:async()=>[],loadContactOwnLife:async()=>own},
        'proactive/unifiedContactCurrentState':{prepareContactCurrentStates:async()=>[]},
        'proactive/unifiedContactWeeklyReview':{prepareContactWeeklyReviews:async()=>[],loadContactWeeklyReview:async()=>null,recordContactWeeklyReviewProvided:async()=>{}},
        'proactive/unifiedContactMemory':{CONTACT_PAST_MEMORY_MIN_CHARS:50},
        'schedule/chatScheduleUnknownProgress':{isChatScheduleProgressId:()=>false,prepareChatScheduleProgress:async()=>[]},
        'ai/behavior/continuityLedger':{listBaiyunContinuityEvents:async()=>[],listChatCareMatters:async()=>[]},
        'ai/behavior/heartCareMatter':{isHeartCareMatter:()=>false},
        'wishPool/wishProactiveMaterials':{wishProactiveSourcesCurrent:async()=>true,isWishProactiveSource:()=>false},
        'proactive/unifiedContactMaterials':{buildContactMotivePaper:motives=>motives.join(','),selectContactMaterialEntries:rows=>rows,buildContactFailureMaterial:()=>''},
      });
      Object.assign(stubs['life/junluoDesireRuntime'],{loadJunluoDesireSnapshot:async()=>({desires:{}}),isJunluoWantsAwake:async()=>true});
      stubs['backup/backupRestoreCoordinator'].subscribeBackupRestoreRuntimeState=()=>()=>{};
      Object.assign(stubs['proactive/phoneEmergencyContact'],{buildPhoneEmergencySnapshot:()=>null,decidePhoneEmergencyContact:()=>({due:false})});
      for(const key of ['proactive/unifiedContactDispatch','proactive/unifiedContactHandoff']) {
        const file=path.join(sourceRoot,key+'.ts');
        const ast=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest);
        for(const statement of ast.statements) if(ts.isImportDeclaration(statement)&&!statement.importClause?.isTypeOnly){
          const request=statement.moduleSpecifier.text;
          const resolved=request.startsWith('.')?path.posix.normalize(path.posix.join(path.posix.dirname(key),request)):request;
          if(!stubs[resolved]&&!testedModules.has(resolved)) stubs[resolved]={};
        }
      }
    },
  };
  return h;
}

async function suite(){
  await test('poke farewell boundary is ten minutes, fallback stays fifteen',async()=>{
    const h=harness(), p=h.load('life/sleepPlanPolicy');
    assert.equal(p.sleepGreetingBoundary(h.night(),h.state,AT).dueAt,AT+10*MIN);
    assert.equal(p.sleepGreetingBoundary(h.night(),h.state,AT+15*MIN),null);
  });
  await test('real delivered farewell waits five minutes beyond original cutoff',async()=>{
    const h=harness(), p=h.load('life/sleepPlanPolicy'), s=h.load('life/sleepPlanStore');
    h.time(AT+14*MIN); const b=p.sleepGreetingBoundary(h.night(),h.state,h.now());
    await s.recordSleepGreetingDelivery(b,{sessionId:'session',messageId:'farewell',deliveredAt:h.now()});
    assert.equal(p.pendingSleepDueAt(h.night().nightSleepPlan),AT+19*MIN);
    h.time(AT+16*MIN); h.auto(false); await s.settleSleepNight(h.now()); assert.equal(h.phase(),'awake');
    await s.recordSleepGreetingDelivery(b,{sessionId:'session',messageId:'farewell',deliveredAt:h.now()});
    assert.equal(p.pendingSleepDueAt(h.night().nightSleepPlan),AT+19*MIN);
    h.time(AT+22*MIN); await s.settleSleepNight(h.now());
    assert.equal(h.night().nightSleepPlan.events.at(-1).at,h.now());
  });
  await test('failed second round keeps old quiet cutoff; success alone extends it',async()=>{
    for(const saved of [false,true]) {
      const h=harness(),p=h.load('life/sleepPlanPolicy'),s=h.load('life/sleepPlanStore');
      h.time(AT+14*MIN); await s.recordSleepGreetingDelivery(p.sleepGreetingBoundary(h.night(),h.state,h.now()),{sessionId:'session',messageId:'farewell',deliveredAt:h.now()});
      h.time(AT+18*MIN); await s.beginChatSleepTurn({sessionId:'session',turnId:'you-2',sourceMessageIds:['you-2'],now:h.now()});
      h.time(AT+21*MIN); await s.finishChatSleepTurn({sessionId:'session',turnId:'you-2',replySaved:saved,now:h.now()});
      assert.equal(p.pendingSleepDueAt(h.night().nightSleepPlan),AT+(saved?26:19)*MIN);
      if(saved){await s.beginChatSleepTurn({sessionId:'session',turnId:'you-3',now:h.now()});assert.equal(h.night().nightSleepPlan.pendingSleep.round,2);}
    }
  });
  await test('early main farewell keeps original sleep and ordinary chat after its two rounds',async()=>{
    const h=harness(),p=h.load('life/sleepPlanPolicy'),s=h.load('life/sleepPlanStore');
    const d=h.night(); delete d.nightSleepPlan.actualSleepAt; d.sleepTargetAt=AT+30*MIN; d.nightSleepPlan.originalSleepAt=d.sleepTargetAt;
    d.nightSleepPlan.events=[]; h.writeNight(d); h.state.wakeSource=undefined; h.state.manualWakeUntil=undefined;
    const b=p.sleepGreetingBoundary(d,h.state,AT); await s.recordSleepGreetingDelivery(b,{sessionId:'session',messageId:'main-farewell',deliveredAt:AT});
    h.time(AT+2*MIN);await s.beginChatSleepTurn({sessionId:'session',turnId:'you-2',now:h.now()});
    h.time(AT+3*MIN);await s.finishChatSleepTurn({sessionId:'session',turnId:'you-2',replySaved:true,now:h.now()});
    assert.equal(p.pendingSleepDueAt(h.night().nightSleepPlan),AT+30*MIN);
    h.time(AT+10*MIN); await s.settleSleepNight(h.now()); assert.equal(h.phase(),'awake');
    assert.equal(await s.isChatSleepReplyCurrent({sessionId:'session',turnId:'ordinary-you',startedAt:h.now(),now:h.now()}),true);
    await s.beginChatSleepTurn({sessionId:'session',turnId:'ordinary-you',now:h.now()});assert.equal(h.night().nightSleepPlan.pendingSleep.round,2);
  });
  await test('late unsent farewell cannot reopen expired poke',async()=>{
    const h=harness(),p=h.load('life/sleepPlanPolicy'),s=h.load('life/sleepPlanStore'); const b=p.sleepGreetingBoundary(h.night(),h.state,AT);
    h.time(AT+16*MIN); await s.settleSleepNight(h.now());
    assert.equal(await s.recordSleepGreetingDelivery(b,{sessionId:'session',messageId:'late',deliveredAt:h.now()}),false);
    assert.equal(h.night().nightSleepPlan.pendingSleep,undefined);
  });
  await test('shared twelve slots and request cap are enforced without refunding unknown',async()=>{
    const h=harness(),s=h.load('proactive/unifiedContactStore');
    const b={nightKey:'2026-10-27',phase:'return',episodeId:'poke',dueAt:AT,deadlineAt:AT+15*MIN};
    const handle=await s.beginSleepGreetingRequest({boundary:b,sessionId:'session',messageId:'m',epoch:1,priorRequests:0});
    assert.equal((await h.ledger()).used,1); await s.markSleepGreetingTransport(handle,1,'unknown');
    assert.equal(await s.releaseUnsentSleepGreeting(handle,1),false);
    for(const n of [1,2]) await s.beginSleepGreetingRequest({boundary:b,sessionId:'session',messageId:'m',epoch:1,priorRequests:n});
    await assert.rejects(()=>s.beginSleepGreetingRequest({boundary:b,sessionId:'session',messageId:'m',epoch:1,priorRequests:3}));
    assert.equal((await h.ledger()).used,1);
    await s.finishSharedSleepGreeting(handle.id,1,'failed');
    await s.changeUnifiedContactState(state=>{state.used=12;state.day=h.load('proactive/unifiedContact').contactLocalDay(AT);},1);
    await assert.rejects(()=>s.beginSleepGreetingRequest({boundary:{...b,episodeId:'new'},sessionId:'session',messageId:'new',epoch:1,priorRequests:0}));
  });
  await test('known unsent rollback restores exact allowance; cold legacy cannot buy a slot',async()=>{
    const h=harness(),s=h.load('proactive/unifiedContactStore'),b={nightKey:'n',phase:'prepare',episodeId:'one',dueAt:AT,deadlineAt:AT+MIN};
    const handle=await s.beginSleepGreetingRequest({boundary:b,sessionId:'session',messageId:'m',epoch:1,priorRequests:0});
    assert.equal(await s.releaseUnsentSleepGreeting(handle,1),true);assert.equal((await h.ledger()).used,0);
    await assert.rejects(()=>s.beginSleepGreetingRequest({boundary:{...b,episodeId:'old'},sessionId:'session',messageId:'m',epoch:1,priorRequests:1}));
  });
  await test('approved task text and real history order; return offers no scheduling tools',async()=>{
    const h=harness(),g=h.load('life/sleepPlanGeneration');
    const source=Array.from({length:28},(_,n)=>({id:`m${n}`,role:n%2?'I':'you',content:`real-${n}`,createdAt:AT+n}));
    await g.generateSleepPlan({apiKey:'x',connection:{},profile:{},context:{nightKey:'2026-10-27',requestAt:AT},messages:source,
      phase:'return',remainingRequests:3,signal:new AbortController().signal,onRequestStart:async()=>{},canContinue:async()=>true,
      ordinaryMaterial:'SELECTED ORIGINAL MATERIAL',commit:async()=>{throw Error('not allowed');}});
    const input=h.requests[0], api=input.apiMessagesOverride;
    assert.equal(api[0].content,'PERSONA'); assert.equal(api[2].content,'SELECTED ORIGINAL MATERIAL');
    assert.equal(api.slice(3,-1).length,24);assert.equal(api[3].content,'real-4');assert.equal(api.at(-1).content,g.RETURN_SLEEP_PROMPT);
    assert.equal(input.request.tools,undefined);assert.equal(input.timeoutMs,25000);assert.equal(input.request.max_tokens,600);
    assert.ok(g.SLEEP_PLAN_PROMPT.includes('I 把晚安和此刻还想对 you 说的话，一起说给 you 听。\n\nI 把想说的话写进这个 JSON：'));
    assert.ok(g.NEAR_STATUS_SLEEP_MESSAGE_PROMPT.includes('I 把晚安和此刻还想对 you 说的话，一起说给 you 听。'));
  });
  await test('new receipts pass sync; old-record merge cannot erase them',async()=>{
    const h=harness(),s=h.load('life/sleepPlanStore'),p=h.load('life/sleepPlanPolicy');
    h.time(AT+14*MIN);await s.recordSleepGreetingDelivery(p.sleepGreetingBoundary(h.night(),h.state,h.now()),{sessionId:'session',messageId:'farewell',deliveredAt:h.now()});
    const incoming=h.night(),old=clone(incoming); delete old.nightSleepPlan.pendingSleep.greeting;delete old.nightSleepPlan.events[0].greeting;
    h.load('sync/syncAssistantLifeState').assertAssistantLifeStateRecord('life-day',incoming.dateKey,incoming);
    const merge=h.load('sync/syncAssistantLifeStateMerge');
    for(const [a,b] of [[old,incoming],[incoming,old]]){
      const result=merge.mergeLifeDayRuntimeProgress(a,b);
      assert.equal(result.nightSleepPlan.pendingSleep.greeting.deliveredAt,AT+14*MIN);
      assert.equal(result.nightSleepPlan.events[0].greeting.messageId,'farewell');
      h.load('sync/syncAssistantLifeState').assertAssistantLifeStateRecord('life-day',result.dateKey,result);
    }
  });
  await test('actual return runtime saves and emits one original message, then waits locally with AI off',async()=>{
    const h=harness();h.time(AT+10*MIN);const r=h.load('life/sleepPlanRuntime');
    assert.equal(await r.runSleepPlanTick(),true);
    assert.equal(h.requests.length,1);assert.equal(h.messages.length,2);assert.equal(h.events.length,1);
    assert.equal((await h.ledger()).used,1);assert.equal((await h.ledger()).current.status,'finished');
    assert.equal(h.night().nightSleepPlan.pendingSleep.greeting.deliveredAt,AT+10*MIN);
    h.auto(false);h.time(AT+12*MIN);await r.runSleepPlanTick({allowRequest:false});
    assert.equal(h.requests.length,1);assert.equal(h.messages.length,2);assert.equal(h.phase(),'awake');
  });
  await test('runtime late completion does not write or emit, and closes at actual fallback handling',async()=>{
    const h=harness();h.time(AT+10*MIN);h.onCompletion=async()=>h.time(AT+16*MIN);
    await h.load('life/sleepPlanRuntime').runSleepPlanTick();
    assert.equal(h.requests.length,1);assert.equal(h.messages.length,1);assert.equal(h.events.length,0);
    const returned=h.night().nightSleepPlan.events.find(event=>event.kind==='sleep_return');
    assert.equal(returned.at,AT+16*MIN);assert.equal((await h.ledger()).used,1);
  });
  await test('actual main prepare keeps original half-hour sleep, one quota, and original receipt on recheck',async()=>{
    const h=harness(),d=h.night();delete d.nightSleepPlan.actualSleepAt;d.sleepTargetAt=AT+30*MIN;
    d.nightSleepPlan.originalSleepAt=d.sleepTargetAt;d.nightSleepPlan.events=[];h.writeNight(d);
    h.state.wakeSource=undefined;h.state.manualWakeUntil=undefined;
    const r=h.load('life/sleepPlanRuntime');assert.equal(await r.runSleepPlanTick(),true);
    assert.equal(h.requests.length,1);assert.equal((await h.ledger()).used,1);
    assert.equal(h.load('life/sleepPlanPolicy').pendingSleepDueAt(h.night().nightSleepPlan),AT+30*MIN);
    const ended=(await h.ledger()).lastEndedAt;h.time(AT+8*MIN);await r.runSleepPlanTick();
    assert.equal((await h.ledger()).lastEndedAt,ended);assert.equal(h.requests.length,1);
  });
  await test('paid main draft survives local save failure and cold recovery without regenerating',async()=>{
    const h=harness(),d=h.night();delete d.nightSleepPlan.actualSleepAt;d.sleepTargetAt=AT+30*MIN;
    d.nightSleepPlan.originalSleepAt=d.sleepTargetAt;d.nightSleepPlan.events=[];h.writeNight(d);
    h.state.wakeSource=undefined;h.state.manualWakeUntil=undefined;h.failAppend=true;
    await h.load('life/sleepPlanRuntime').runSleepPlanTick();assert.equal(h.messages.length,1);assert.equal(h.requests.length,1);
    assert.ok(h.raw.get('junluo.sleep.pendingReply.v1'));
    h.failAppend=false;h.cold();h.time(AT+MIN);await h.load('life/sleepPlanRuntime').runSleepPlanTick();
    assert.equal(h.messages.length,2);assert.equal(h.requests.length,1);assert.equal((await h.ledger()).used,1);
    assert.equal(h.raw.has('junluo.sleep.pendingReply.v1'),false);assert.equal(h.night().nightSleepPlan.pendingSleep.greeting.deliveredAt,AT+MIN);
    h.cold();await h.load('life/sleepPlanRuntime').runSleepPlanTick();assert.equal(h.messages.length,2);assert.equal(h.requests.length,1);
  });
  await test('unknown interrupted return does not request again after cold start',async()=>{
    const h=harness(),s=h.load('proactive/unifiedContactStore'),p=h.load('life/sleepPlanPolicy');h.time(AT+10*MIN);
    const b=p.sleepGreetingBoundary(h.night(),h.state,h.now());
    const handle=await s.beginSleepGreetingRequest({boundary:b,sessionId:'session',messageId:'m',epoch:1,priorRequests:0});
    await h.load('life/sleepPlanStore').recordSleepGreetingAttempt(b,handle.id);await s.markSleepGreetingTransport(handle,1,'unknown');
    h.cold();await h.load('life/sleepPlanRuntime').runSleepPlanTick();assert.equal(h.requests.length,0);assert.equal((await h.ledger()).used,1);
    assert.equal((await h.ledger()).current.status,'finished');
  });
  await test('return local save retry adopts the same paid body and ID with no second call',async()=>{
    const h=harness();h.time(AT+10*MIN);h.failAppend=true;await h.load('life/sleepPlanRuntime').runSleepPlanTick();
    const op=(await h.ledger()).current;assert.equal(op.status,'saving');assert.equal(h.messages.length,1);assert.equal(h.requests.length,1);
    h.failAppend=false;h.cold();h.time(AT+11*MIN);await h.load('life/sleepPlanRuntime').runSleepPlanTick();
    assert.equal(h.messages[1].id,op.sleepGreeting.messageId);assert.equal(h.messages[1].content,op.messages[0]);assert.equal(h.requests.length,1);
    assert.equal(h.night().nightSleepPlan.pendingSleep.greeting.deliveredAt,AT+11*MIN);
  });
  await test('quota full and automatic-off never send return farewell',async()=>{
    for(const off of [false,true]){
      const h=harness();h.time(AT+10*MIN);
      if(off) h.auto(false);else await h.load('proactive/unifiedContactStore').changeUnifiedContactState(state=>{
        state.day=h.load('proactive/unifiedContact').contactLocalDay(h.now());state.used=12;
      });
      await h.load('life/sleepPlanRuntime').runSleepPlanTick();assert.equal(h.requests.length,0);assert.equal(h.messages.length,1);
      h.time(AT+16*MIN);await h.load('life/sleepPlanStore').settleSleepNight(h.now());assert.equal(h.phase(),'sleeping');
    }
  });
  await test('wake greeting retains physical waking separately until actual default get-up',async()=>{
    const h=harness(),d=h.night();d.nightSleepPlan.events=[];d.nightSleepPlan.originalWakeAt=AT;h.writeNight(d);
    h.state.wakeSource=undefined;h.state.manualWakeUntil=undefined;
    await h.load('life/sleepPlanRuntime').runSleepPlanTick({scheduledWakeNight:d.dateKey});
    const plan=h.night().nightSleepPlan;assert.equal(h.requests.length,1);assert.equal(plan.morningAwakeAt,AT);assert.equal(plan.actualWakeAt,AT);
    assert.ok(h.requests[0].apiMessagesOverride.at(-1).content.includes('I 把早安和此刻还想对 you 说的话，一起说给 you 听。'));
    assert.equal((await h.ledger()).used,1);
  });
  await test('saved return without original delivery confirmation expires silently after fifteen minutes',async()=>{
    for(const confirmed of [false,true]) {
      const h=harness(),s=h.load('proactive/unifiedContactStore'),p=h.load('life/sleepPlanPolicy');h.time(AT+14*MIN);
      const b=p.sleepGreetingBoundary(h.night(),h.state,h.now());
      const handle=await s.beginSleepGreetingRequest({boundary:b,sessionId:'session',messageId:'saved-return',epoch:1,priorRequests:0});
      await h.load('life/sleepPlanStore').recordSleepGreetingAttempt(b,handle.id);await s.markSleepGreetingTransport(handle,1,'unknown');
      const message={id:'saved-return',role:'I',source:'proactive-message',content:'original body',createdAt:h.now()};
      await s.retainSharedSleepGreeting(handle.id,message,1);h.messages.push(message);
      if(confirmed) await s.markSharedSleepGreetingDelivered(handle.id,h.now(),1);
      h.cold();h.time(AT+16*MIN);await h.load('life/sleepPlanRuntime').runSleepPlanTick();
      assert.equal(h.requests.length,0);assert.equal(h.events.length,0);assert.equal(h.messages.length,2);assert.equal((await h.ledger()).used,1);
      if(confirmed) assert.equal(h.night().nightSleepPlan.pendingSleep.greeting.deliveredAt,AT+14*MIN);
      else {assert.equal(h.night().nightSleepPlan.pendingSleep,undefined);assert.equal((await h.ledger()).current.sleepGreeting.deliveredAt,undefined);}
    }
  });
  await test('merged ordinary motives enter the original rotation only at unknown/started transport',async()=>{
    const h=harness(),s=h.load('proactive/unifiedContactStore');
    const candidate={id:'unified-contact:ordinary:phone-local:session:1',sessionId:'session',createdAt:AT,expiresAt:AT+MIN,
      motives:['miss_you'],sources:[],important:false,epoch:1,latestYouId:'you-1',sourceMessages:[],requests:0,requestStartedAt:0,
      retryStarted:false,failedAt:null,retryAt:null,status:'ready',messages:[],savedMessageIds:[],endedAt:null};
    await s.changeUnifiedContactState(state=>{state.current=clone(candidate);});
    const handle=await s.beginSleepGreetingRequest({boundary:{nightKey:'n',phase:'prepare',episodeId:'n:prepare',dueAt:AT,deadlineAt:AT+MIN},
      sessionId:'session',messageId:'m',epoch:1,priorRequests:0,ordinary:{candidate,material:'original selected material'}});
    assert.equal((await h.ledger()).used,1);assert.equal((await h.ledger()).motiveLastSelectedAt?.miss_you,undefined);
    await s.markSleepGreetingTransport(handle,1,'unknown');
    assert.equal((await h.ledger()).motiveLastSelectedAt.miss_you,AT);assert.equal((await h.ledger()).current.sleepGreeting.ordinaryMaterial,'original selected material');
  });
  await test('new return respects cowork occupancy',async()=>{
    const h=harness();h.time(AT+10*MIN);h.focus={mode:'cowork',paused:false,baiyunActivity:'synthetic reading'};
    await h.load('life/sleepPlanRuntime').runSleepPlanTick();assert.equal(h.requests.length,0);assert.equal((await h.ledger()).used,0);
  });
  await test('near-status immediate-sleep handoff shares quota and defers physical sleep until farewell quiet ends',async()=>{
    const h=harness(),d=h.night();delete d.nightSleepPlan.actualSleepAt;d.sleepTargetAt=AT+30*MIN;
    d.nightSleepPlan.originalSleepAt=d.sleepTargetAt;d.nightSleepPlan.events=[];h.writeNight(d);h.state.wakeSource=undefined;h.state.manualWakeUntil=undefined;
    const r=h.load('life/sleepPlanRuntime'),p=h.load('life/sleepPlanPolicy');
    const opportunity=await r.createNearStatusSleepOpportunity({operationId:'near-op',epoch:1,signal:new AbortController().signal});assert.ok(opportunity);
    const decision=await opportunity.commit({sleepAt:p.formatSleepLocalTime(AT)},'tool-1');assert.equal(decision.ok,true);assert.ok(opportunity.handoff);
    assert.equal(h.night().nightSleepPlan.actualSleepAt,undefined);await opportunity.onHandoffRequestStart();await opportunity.onHandoffTransportPrepared();
    assert.equal((await h.ledger()).used,1);assert.equal(await opportunity.finishHandoff('synthetic farewell'),true);
    assert.equal(h.messages.length,2);assert.equal(p.pendingSleepDueAt(h.night().nightSleepPlan),AT+5*MIN);
    assert.equal(h.night().nightSleepPlan.actualSleepAt,undefined);await opportunity.dispose();
    h.time(AT+6*MIN);await h.load('life/sleepPlanStore').settleSleepNight(h.now());assert.equal(h.night().nightSleepPlan.actualSleepAt,h.now());
  });
  await test('real native prepare to checkUnifiedContact reaches exactly one original sleep request under strict scheduler',async()=>{
    const h=harness(),d=h.night();delete d.nightSleepPlan.actualSleepAt;d.sleepTargetAt=AT+30*MIN;
    d.nightSleepPlan.originalSleepAt=d.sleepTargetAt;d.nightSleepPlan.events=[];h.writeNight(d);h.state.wakeSource=undefined;h.state.manualWakeUntil=undefined;h.enableDispatch();
    await h.load('life/sleepPlanRuntime').handleSleepPlanTask({id:`${d.dateKey}:prepare`,nightKey:d.dateKey,phase:'prepare',at:AT});
    assert.equal(h.requests.length,1);assert.equal((await h.ledger()).used,1);assert.equal(h.messages.length,2);
  });
  await test('held urgent lane defers new sleep work without consuming it; free native contact then delivers',async()=>{
    const h=harness();h.time(AT+10*MIN);h.enableDispatch();const dispatch=h.load('proactive/unifiedContactDispatch');
    await h.withLane(()=>dispatch.runUnifiedContact({apiKey:'x',connection:{},profile:{},schedulerHeld:true}));
    assert.equal(h.requests.length,0);assert.equal((await h.ledger()).used,0);
    await dispatch.checkUnifiedContact();assert.equal(h.requests.length,1);assert.equal((await h.ledger()).used,1);
  });
  await test('ordinary check cannot manufacture native wake eligibility; original native wake still delivers',async()=>{
    const h=harness(),d=h.night();d.nightSleepPlan.events=[];d.nightSleepPlan.originalWakeAt=AT;h.writeNight(d);
    h.state.wakeSource=undefined;h.state.manualWakeUntil=undefined;h.enableDispatch();
    await h.load('proactive/unifiedContactDispatch').checkUnifiedContact();assert.equal(h.requests.length,0);assert.equal(h.night().nightSleepPlan.wake,undefined);
    await h.load('life/sleepPlanRuntime').handleSleepPlanTask({id:`${d.dateKey}:wake`,nightKey:d.dateKey,phase:'wake',at:AT});
    assert.equal(h.requests.length,1);assert.equal((await h.ledger()).used,1);
  });
  await test('real ready ordinary is merged before transport with only its selected motive/life material',async()=>{
    const h=harness(),d=h.night();delete d.nightSleepPlan.actualSleepAt;d.sleepTargetAt=AT+30*MIN;
    d.nightSleepPlan.originalSleepAt=d.sleepTargetAt;d.nightSleepPlan.events=[];h.writeNight(d);h.state.wakeSource=undefined;h.state.manualWakeUntil=undefined;
    h.enableDispatch();const s=h.load('proactive/unifiedContactStore');
    const candidate={id:'unified-contact:ordinary:phone-local:session:1',sessionId:'session',materialVersion:2,createdAt:AT,expiresAt:AT+60*MIN,
      motives:['miss_you'],sources:[{id:'synthetic-own',version:'v1',kind:'life'}],important:false,epoch:1,latestYouId:'you-1',
      sourceMessages:h.messages.map(message=>({id:message.id,version:h.stubs['ai/promptCacheMetrics'].fingerprintPromptText(JSON.stringify([message.role,message.content,message.createdAt]))})),
      requests:0,requestStartedAt:0,retryStarted:false,failedAt:null,retryAt:null,status:'ready',messages:[],savedMessageIds:[],endedAt:null};
    await s.changeUnifiedContactState(state=>{state.current=candidate;});
    await h.load('proactive/unifiedContactDispatch').checkUnifiedContact();
    assert.equal(h.requests.length,1);assert.equal((await h.ledger()).used,1);assert.equal((await h.ledger()).current.id,candidate.id);
    assert.equal((await h.ledger()).motiveLastSelectedAt.miss_you,AT);
    assert.equal(h.requests[0].apiMessagesOverride[2].content,'miss_you\n\nORIGINAL SELECTED LIFE');
    assert.equal(h.messages.length,2);
  });
  await test('lifeEngine public sleep entry routes a ready ordinary through selection before activeTick',async()=>{
    assert.match(fs.readFileSync(path.join(sourceRoot,'life/lifeEngine.ts'),'utf8'),/runSleepPlanTick\(\{ now, allowRequest: !localOnly \}\)/);
    const h=harness(),d=h.night();delete d.nightSleepPlan.actualSleepAt;d.sleepTargetAt=AT+30*MIN;
    d.nightSleepPlan.originalSleepAt=d.sleepTargetAt;d.nightSleepPlan.events=[];h.writeNight(d);h.state.wakeSource=undefined;h.state.manualWakeUntil=undefined;
    h.enableDispatch();const s=h.load('proactive/unifiedContactStore');
    await s.changeUnifiedContactState(state=>{state.current={id:'unified-contact:ordinary:phone-local:session:1',sessionId:'session',materialVersion:2,
      createdAt:AT,expiresAt:AT+60*MIN,motives:['miss_you'],sources:[],important:false,epoch:1,latestYouId:'you-1',sourceMessages:[],
      requests:0,requestStartedAt:0,retryStarted:false,failedAt:null,retryAt:null,status:'ready',messages:[],savedMessageIds:[],endedAt:null};});
    assert.equal(await h.load('life/sleepPlanRuntime').runSleepPlanTick({now:AT,allowRequest:true}),true);
    assert.equal(h.requests.length,1);assert.equal((await h.ledger()).used,1);assert.equal(h.night().nightSleepPlan.prepare.status,'complete');
  });
  await test('new true you invalidates unsaved return body rather than recovering it into newer chat',async()=>{
    const h=harness();h.time(AT+10*MIN);h.failAppend=true;await h.load('life/sleepPlanRuntime').runSleepPlanTick();
    assert.equal(h.requests.length,1);h.failAppend=false;h.time(AT+11*MIN);h.messages.push({id:'you-2',role:'you',content:'new synthetic input',createdAt:h.now()});
    h.cold();await h.load('life/sleepPlanRuntime').runSleepPlanTick();assert.equal(h.messages.length,2);assert.equal(h.requests.length,1);
    assert.equal((await h.ledger()).current.status,'finished');
  });
  await test('near-status known-unsent handoff refunds only that claim before local failed farewell closes',async()=>{
    const h=harness(),d=h.night();delete d.nightSleepPlan.actualSleepAt;d.sleepTargetAt=AT+30*MIN;
    d.nightSleepPlan.originalSleepAt=d.sleepTargetAt;d.nightSleepPlan.events=[];h.writeNight(d);h.state.wakeSource=undefined;h.state.manualWakeUntil=undefined;
    const r=h.load('life/sleepPlanRuntime'),p=h.load('life/sleepPlanPolicy');
    const opportunity=await r.createNearStatusSleepOpportunity({operationId:'near-unsent',epoch:1,signal:new AbortController().signal});
    await opportunity.commit({sleepAt:p.formatSleepLocalTime(AT)},'tool-unsent');await opportunity.onHandoffRequestStart();
    await opportunity.onHandoffUnsent();await opportunity.dispose();assert.equal((await h.ledger()).used,0);assert.equal(h.messages.length,1);
    assert.equal(h.night().nightSleepPlan.prepare.requestCount,0);assert.equal(h.night().nightSleepPlan.actualSleepAt,AT);
  });
  await test('due priority care leaves sleep-only route and enters original normal scheduler lane',async()=>{
    for(const kind of ['heart','phone']){
      const h=harness(),d=h.night();delete d.nightSleepPlan.actualSleepAt;d.sleepTargetAt=AT+30*MIN;
      d.nightSleepPlan.originalSleepAt=d.sleepTargetAt;d.nightSleepPlan.events=[];h.writeNight(d);h.state.wakeSource=undefined;h.state.manualWakeUntil=undefined;h.enableDispatch();
      if(kind==='heart') h.stubs['bodySignal/bodySignalProactiveCareRuntime'].loadPriorityHeartContact=async()=>({id:'heart-fixture',version:'v1',expiresAt:AT+10*MIN,facts:'synthetic priority'});
      else Object.assign(h.stubs['proactive/phoneEmergencyContact'],{buildPhoneEmergencySnapshot:()=>({latest:{id:'phone-fixture',version:'v1'},pendingIds:[]}),decidePhoneEmergencyContact:()=>({due:true})});
      let selected;
      h.load('proactive/unifiedContactRuntime').processUnifiedContact=async(_ports,candidate)=>{selected={candidate,lane:h.lane()};return 0;};
      // Replace only the normal contact execution boundary: this case proves routing, not its pre-existing model/tool pipeline.
      await h.load('proactive/unifiedContactDispatch').checkUnifiedContact();
      assert.ok(selected);assert.equal(selected.lane,'unified-contact');assert.equal(h.requests.length,0);
      assert.equal(kind==='heart'?selected.candidate.important:!!selected.candidate.phoneEmergency,true);
      assert.equal(h.night().nightSleepPlan.prepare,undefined);
    }
  });
  await test('real bedtime decision may revise C deadline without revising a temporary return cutoff',async()=>{
    const h=harness(),s=h.load('proactive/unifiedContactStore');
    const handle=await s.beginSleepGreetingRequest({boundary:{nightKey:'n',phase:'prepare',episodeId:'n:prepare',dueAt:AT,deadlineAt:AT+MIN},
      sessionId:'session',messageId:'m',epoch:1,priorRequests:0});
    await s.updateSharedBedtimeDeadline(handle.id,AT+30*MIN,1);assert.equal((await h.ledger()).current.expiresAt,AT+30*MIN);
    await s.finishSharedSleepGreeting(handle.id,1,'done');
    const next=await s.beginSleepGreetingRequest({boundary:{nightKey:'n',phase:'return',episodeId:'poke',dueAt:AT,deadlineAt:AT+15*MIN},
      sessionId:'session',messageId:'return-m',epoch:1,priorRequests:0,now:AT+1});
    await assert.rejects(()=>s.updateSharedBedtimeDeadline(next.id,AT+30*MIN,1));assert.equal((await h.ledger()).current.expiresAt,AT+15*MIN);
  });
  await test('legacy paid morning draft recovers its exact ID without claiming a new slot or defaulting early get-up into the past',async()=>{
    for(const early of [false,true]) {
      const h=harness(),d=h.night(),id='sleep-plan:2026-10-27:wake';
      d.nightSleepPlan.events=[{id:'2026-10-27:morning-awake',kind:'morning_awake',at:AT}];
      d.nightSleepPlan.morningAwakeAt=AT;d.nightSleepPlan.originalWakeAt=AT+(early?8*60*MIN:0);
      d.nightSleepPlan.wake={status:'complete',requestCount:2,sessionId:'session',messageId:id,contextMessageId:'you-1'};h.writeNight(d);
      h.state.wakeSource=undefined;h.state.manualWakeUntil=undefined;
      const fingerprint=h.stubs['ai/promptCacheMetrics'].fingerprintPromptText;
      const draft={version:1,nightKey:d.dateKey,phase:'wake',sessionId:'session',activeSessionId:'session',
        message:{id,role:'I',source:'proactive-message',content:'ORIGINAL PAID MORNING',createdAt:AT},revision:0,requestCount:2,
        contextKey:fingerprint(JSON.stringify(h.messages)),eventsKey:fingerprint(JSON.stringify(d.nightSleepPlan.events)),
        sleepAt:d.sleepTargetAt,wakeAt:d.nightSleepPlan.originalWakeAt,originalSleepAt:d.nightSleepPlan.originalSleepAt,
        originalWakeAt:d.nightSleepPlan.originalWakeAt,manualWakeUntil:0,manualSleepUntil:0,hasDecision:false};
      await h.load('life/sleepPlanStore').savePendingSleepReply(draft,1,async()=>true);
      h.cold();h.time(AT+2*MIN);await h.load('life/sleepPlanRuntime').runSleepPlanTick({allowRequest:false});
      assert.equal(h.requests.length,0);assert.equal(h.messages.filter(message=>message.id===id).length,1);
      assert.equal(h.messages.find(message=>message.id===id).content,draft.message.content);
      assert.equal(h.night().nightSleepPlan.actualWakeAt,early?h.now():AT);assert.equal((await h.ledger()).used,0);
      h.cold();await h.load('life/sleepPlanRuntime').runSleepPlanTick({allowRequest:false});assert.equal(h.messages.filter(message=>message.id===id).length,1);
    }
  });
}
suite().then(()=>process.stdout.write(`RESULT ${passed} synthetic scenarios passed\n`)).catch(error=>{console.error(error);process.exitCode=1;});

