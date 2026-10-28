/* Only new deadline/cancellation RAM cases; transport, storage and preparation are synthetic ports. */

const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');

const {createRequire}=require('node:module');
const workspace=fs.existsSync(path.join(process.cwd(),'app/package.json'))?process.cwd():path.resolve(process.cwd(),'..');
const appRequire=createRequire(path.join(workspace,'app/package.json'));
const ts=appRequire('typescript');
const sourceFlag=process.argv.indexOf('--source-root');
if(sourceFlag>=0&&!process.argv[sourceFlag+1])throw Error('--source-root requires a repository root');
const sourceRoot=sourceFlag<0?workspace:path.resolve(process.argv[sourceFlag+1]);
function fixture(root=sourceRoot){
 let now=1000,fetchCalls=0,xhrCalls=0;const timers=new Map(),events=[],replies=[],cache=new Map(),controllers=[],bodies=[];
 const metrics={starts:0,finishes:0};
 const TrackedController=class extends AbortController{constructor(){super();const listeners=new Set(),add=this.signal.addEventListener.bind(this.signal),remove=this.signal.removeEventListener.bind(this.signal);this.signal.addEventListener=(name,fn,...args)=>{if(name==='abort')listeners.add(fn);return add(name,fn,...args);};this.signal.removeEventListener=(name,fn,...args)=>{if(name==='abort')listeners.delete(fn);return remove(name,fn,...args);};controllers.push(listeners);}};
 const sample={choices:[{finish_reason:'stop',message:{content:'{"messages":["synthetic body"]}'}}]};
 const plain={stablePrompt:'synthetic static',dynamicPrompt:'',sections:{persona:'',personaState:'',userProfile:'',scenario:'',expression:'',memory:''}};
 const mocks={
  'react-native':{Platform:{OS:'android'}},
  'ai/builtInSystemPrompt':{buildCompiledSystemPromptResult:async()=>plain},
  'ai/ambientContext':{buildAmbientContext:async()=>''},
  'voiceCall/voiceCallInvitationStore':{buildRecentMissedVoiceCallContext:async()=>''},
  'ai/modelParameters':{buildChatModelParameterPayload:()=>({}),buildToolProviderTransportParameters:()=>({}),isOfficialQwen27bConnection:()=>false,isOfficialQwen397bConnection:()=>false,isOfficialQwenMaxConnection:()=>false},
  'ai/qwenChatLayout':{isSiliconQwenChatConnection:()=>false,isLocalQwenChatConnection:()=>false},
  'ai/subjectiveMessages':{SUBJECTIVE_IDENTITY_PROTOCOL:'synthetic identity',buildApiMessages:(sys,rows)=>[{role:'system',content:sys},...rows.map(x=>({role:x.role==='you'?'user':'assistant',content:x.content}))],parseAssistantMessageBubbles:text=>JSON.parse(text).messages},
  'chat/contextCompression':{estimateTextTokens:v=>typeof v==='string'?Math.ceil(v.length/4):0,estimateApiMessagesTokens:rows=>JSON.stringify(rows).length/4,getReplyTokenReserve:()=>1000},
  'ai/promptCacheMetrics':{beginPromptCacheMetric:()=>{metrics.starts++;return{observeSerializedRequest(){},recordUsage(){},finish:async()=>{metrics.finishes++;}}},extractPromptCacheUsageFromResponseUsage:()=>({})},
  'ai/promptDiagnostics':{recordPromptRuntimeSnapshot(){},beginProactiveRequestCapture(){},finishProactiveRequestCapture(){}},
  'ai/promptContextProfile':{getPromptContextProfileForSource:()=> 'synthetic',getPromptOutputAudienceForSource:()=> 'you',isPromptContextSource:()=>true},
  'ai/behavior/actionSemantic':{BAIYUN_SEMANTIC_SIGNAL_KINDS:[]},
  'ai/behavior/actionChatSemantic':{BAIYUN_PROVIDER_EMPTY_SUCCESS_CODE:'provider_empty_success'},
  'tools/toolCallProtocol':{parseOpenAiToolCalls:()=>({rawCallCount:0,invocations:[],errors:[]}),parsePromptJsonToolInvocations:()=>({rawCallCount:0,invocations:[],errors:[]})},
 };
 const FakeDate=class extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
 const context={Date:FakeDate,Error,TypeError,SyntaxError,AbortController:TrackedController,URL,TextDecoder,TextEncoder,Map,Set,Promise,
  console:{...console,warn:(...args)=>{if(args[0]!=='[chat-empty-response]')console.warn(...args);}},__DEV__:false,
  setTimeout:(fn,delay)=>{const token={};timers.set(token,{fn,delay});return token;},clearTimeout:token=>timers.delete(token),
  fetch:async(...args)=>{fetchCalls++;bodies.push(String(args[1]?.body));return f.fetch(...args);}
 };
 function load(key){
  if(mocks[key])return mocks[key];if(cache.has(key))return cache.get(key).exports;
  if(!['ai/openAiCompatibleProvider','ai/chatCompletionTransport','ai/visibleReplyExtraction','ai/replyTransportFormatting','ai/responseEvidenceWire','ai/promptCacheRequest'].includes(key))return {};
  const file=path.join(key==='ai/openAiCompatibleProvider'?root:workspace,'app/src',key+'.ts'),module={exports:{}};cache.set(key,module);
  const js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2023}}).outputText;
  vm.runInNewContext('(function(require,module,exports){'+js+'\n})',context)(name=>load(name.startsWith('.')?path.posix.normalize(path.posix.join(path.posix.dirname(key),name)):name),module,module.exports);
  return module.exports;
 }
 const f={sample,events,replies,timers,load,context,bodies,metrics,listeners:()=>controllers.reduce((n,set)=>n+set.size,0),time:v=>{now=v;},now:()=>now,
  fetch:async()=>({ok:true,status:200,json:async()=>sample}),
  fetchCalls:()=>fetchCalls,xhrCalls:()=>xhrCalls,
  run:extra=>load('ai/openAiCompatibleProvider').sendChatCompletionWithTools({
    apiKey:'fixture-value',connection:{id:'synthetic',model:'synthetic',name:'synthetic',preset:'custom',provider:'openai-compatible',baseUrl:'https://invalid.example'},
    profile:{},messages:[{id:'synthetic-you',role:'you',content:'synthetic input',createdAt:1}],ambientContext:'',
    responseEnvelopeMode:'messages_with_semantic',semanticEnvelopeProtocol:'single_root_json',semanticPrefixCompletionMode:'disabled',
    onTransportAttempt:e=>events.push(e),onReplyDiagnostics:e=>replies.push(e),...extra
  }),
  native:()=>{
   context.navigator={product:'ReactNative'};
   context.XMLHttpRequest=class {
    readyState=0;status=0;responseText='';responseType='';
    open(){this.readyState=1;}setRequestHeader(){}getResponseHeader(){return null;}
    abort(){this.status=0;this.readyState=0;this.responseText='';this.onabort?.();}
    send(body){xhrCalls++;bodies.push(body);f.xhr(this);}
   };
  },
  xhr:xhr=>{xhr.status=200;xhr.readyState=2;xhr.onreadystatechange?.();xhr.responseText=JSON.stringify(sample);xhr.readyState=4;xhr.onload?.();}
 };
 return f;
}


const rows=[];
const policySource=fs.readFileSync(path.join(workspace,'app/src/ai/behavior/actionChatSemantic.ts'),'utf8');
const policyAst=ts.createSourceFile('policy.ts',policySource,ts.ScriptTarget.Latest);
const policyFunction=policyAst.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='decideBaiyunProviderEmptyRetry');
assert.ok(policyFunction);
const policyModule={exports:{}};
const policyJs=ts.transpileModule("const BAIYUN_PROVIDER_EMPTY_SUCCESS_CODE='provider_empty_success';\n"+policyFunction.getText(policyAst),{
 compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2023}}).outputText;
new Function('module','exports',policyJs)(policyModule,policyModule.exports);
const emptyRetry=code=>policyModule.exports.decideBaiyunProviderEmptyRetry({technicalCode:code,additionalRequestUsed:false,remainingRequests:2,toolAgentUsed:false});
const drain=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
function gate(){let open;const promise=new Promise(r=>{open=r;});return{promise,open};}
async function test(name,work){
 let timer;
 try{await Promise.race([Promise.resolve().then(work),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('5s RAM fixture deadline: '+name)),5000);})]);
  rows.push({name,passed:true});console.log('PASS '+name);
 }catch(error){rows.push({name,passed:false});console.error('FAIL '+name,error.message);}
 finally{clearTimeout(timer);}
}
function tracked(f,extra){
 let settled=false;
 const work=f.run(extra).then(result=>{settled=true;return{result};},error=>{settled=true;return{error};});
 return{work,settled:()=>settled};
}
function fireDeadline(f){
 f.time(121001);
 for(const timer of [...f.timers.values()])if(timer.delay===120000)timer.fn();
}
function clean(f,expectedDispatches=1){
 assert.equal(f.timers.size,0,'request deadline timer must be cleared');
 assert.equal(f.listeners(),0,'request abort listeners must be removed');
 assert.equal(f.events.filter(e=>e.phase==='started').length,1);
 assert.equal(f.events.filter(e=>e.phase==='finished').length,1);
 assert.equal(f.fetchCalls()+f.xhrCalls(),expectedDispatches,'no additional transport is permitted');
}
async function interruptedBody(cause,cooperative){
 const f=fixture(),external=new f.context.AbortController(),entered=gate(),body=gate();let fail,child;
 const bodyPromise=new Promise((resolve,reject)=>{body.resolve=resolve;fail=reject;});
 f.fetch=async(_url,init)=>{child=init.signal;return{ok:true,status:200,json:()=>{entered.open();return bodyPromise;}};};
 const turn=tracked(f,{signal:external.signal});
 await entered.promise;
 if(cause==='external')external.abort();else fireDeadline(f);
 if(cooperative)fail(Object.assign(new Error('synthetic body abort'),{name:'AbortError'}));
 await drain();
 const settledBeforeLateBody=turn.settled();
 const finishedBeforeLateBody=f.events.filter(e=>e.phase==='finished').length;
 body.resolve(f.sample);
 const outcome=await turn.work;
 await drain();
 return{f,outcome,settledBeforeLateBody,finishedBeforeLateBody,childAborted:child.aborted};
}
async function suite(){
 for(const mode of ['fetch','xhr'])await test(mode+': normal request body/counts match production and all listeners are cleaned',async()=>{
  const results=[];
  for(const root of [workspace,sourceRoot]){
   const f=fixture(root);if(mode==='xhr')f.native();
   const result=await f.run();
   assert.equal(result.contents[0],'synthetic body');
   assert.equal(f.events.at(-1).outcome,'response_received');
   clean(f);results.push({body:f.bodies[0],starts:f.metrics.starts,finishes:f.metrics.finishes});
  }
  assert.deepEqual(results[1],results[0]);
 });
 for(const mode of ['fetch','xhr'])await test(mode+': late native completion cannot cancel an already due deadline timer and succeed',async()=>{
  const f=fixture();
  if(mode==='xhr'){f.native();f.xhr=x=>{f.time(121001);x.status=200;x.readyState=4;x.responseText=JSON.stringify(f.sample);x.onload();};}
  else f.fetch=async()=>{f.time(121001);return{ok:true,status:200,json:async()=>f.sample};};
  const {error,result}=await tracked(f).work;
  assert.equal(result,undefined);
  assert.equal(error?.kind,'timeout');
  assert.equal(f.events.at(-1).stopCause,'timeout');
  assert.equal(f.events.at(-1).httpStatus,200,'observed HTTP metadata must survive rejection of a late body');
  clean(f);
 });
 await test('JSON completion across the deadline is rejected even before its timer runs',async()=>{
  const f=fixture();f.fetch=async()=>({ok:true,status:200,json:async()=>{f.time(121001);return f.sample;}});
  const {error,result}=await tracked(f).work;
  assert.equal(result,undefined);assert.equal(error?.kind,'timeout');
  assert.ok(f.events.at(-1).bodyReadStartedAt);assert.equal(f.events.at(-1).stopCause,'timeout');clean(f);
 });
 for(const cause of ['external','timer'])for(const cooperative of [false,true])await test(
  cause+': '+(cooperative?'cooperating':'non-cooperating')+' JSON read terminates without an empty-response retry classification',async()=>{
   const row=await interruptedBody(cause,cooperative);
   assert.equal(row.settledBeforeLateBody,true,'caller must finish before a late JSON promise resolves');
   assert.equal(row.finishedBeforeLateBody,1);
   assert.equal(row.childAborted,true);
   assert.equal(row.outcome.result,undefined);
   assert.equal(row.outcome.error?.name,cause==='external'?'AbortError':'AiRequestError');
   if(cause==='timer')assert.equal(row.outcome.error.kind,'timeout');
   assert.equal(row.f.events.at(-1).outcome,cause==='external'?'aborted':'timeout');
   assert.equal(row.f.events.at(-1).stopCause,cause==='external'?'aborted':'timeout');
   assert.equal(row.f.replies.length,0,'interruption must not be emitted as a provider-empty success');
   clean(row.f);
  });
 await test('late JSON rejection after cancellation is handled and cannot emit a second completion',async()=>{
  const f=fixture(),external=new f.context.AbortController(),entered=gate();let rejectBody;
  f.fetch=async()=>({ok:true,status:200,json:()=>{entered.open();return new Promise((_,reject)=>{rejectBody=reject;});}});
  const turn=tracked(f,{signal:external.signal});await entered.promise;external.abort();await drain();
  const settled=turn.settled();
  rejectBody(new TypeError('synthetic late body error'));const {error}=await turn.work;await drain();
  assert.equal(settled,true);assert.equal(error?.name,'AbortError');assert.equal(f.events.at(-1).outcome,'aborted');clean(f);
 });
 for(const mode of ['invalid-json','empty-payload','read-error'])await test(mode+': original non-abort empty-response classification remains',async()=>{
  const f=fixture();
  f.fetch=async()=>({ok:true,status:200,json:async()=>{
   if(mode==='invalid-json')throw new SyntaxError('synthetic invalid JSON');
   if(mode==='read-error')throw new TypeError('synthetic body read failure');
   return{choices:[]};
  }});
  const {error}=await tracked(f).work;
  assert.equal(error?.kind,'empty_response');
  assert.equal(f.events.at(-1).stopCause,undefined);
  assert.equal(f.events.at(-1).bodyParseFailure,mode==='invalid-json'?'invalid_json':mode==='read-error'?'body_read_failed':undefined);
  clean(f);
 });
 await test('actual provider-empty retry decision is unchanged for a genuine empty result',async()=>{
  const f=fixture();f.fetch=async()=>({ok:true,status:200,json:async()=>({choices:[]})});
  const {error}=await tracked(f).work;
  assert.equal(error?.kind,'empty_response');
  assert.equal(f.replies.at(-1).technicalCode,'provider_empty_success');
  assert.equal(emptyRetry(f.replies.at(-1).technicalCode).mode,'messages_only');
  assert.equal(emptyRetry(undefined).mode,'none');clean(f);
 });
 await test('pre-aborted fetch never dispatches or adopts a body',async()=>{
  const f=fixture(),external=new f.context.AbortController();external.abort();
  const {error,result}=await tracked(f,{signal:external.signal}).work;
  assert.equal(result,undefined);assert.equal(error?.name,'AbortError');clean(f,0);
 });
 await test('native XHR waiting before any headers still uses the original timeout outcome',async()=>{
  const f=fixture();f.native();f.xhr=()=>{};
  const turn=tracked(f);await drain();assert.equal(f.xhrCalls(),1);fireDeadline(f);const {error}=await turn.work;
  assert.equal(error?.kind,'timeout');assert.equal(f.events.at(-1).headersReceivedAt,undefined);clean(f);
 });
 for(const cause of ['external','timer'])for(const late of ['resolve','reject'])await test(
  cause+': a non-cooperating pending fetch finishes before its late '+late+' and emits no late observation',async()=>{
   const f=fixture(),external=new f.context.AbortController(),entered=gate();let resolveTransport,rejectTransport;
   f.fetch=()=>{entered.open();return new Promise((resolve,reject)=>{resolveTransport=resolve;rejectTransport=reject;});};
   const turn=tracked(f,{signal:external.signal});await entered.promise;
   if(cause==='external')external.abort();else fireDeadline(f);
   await drain();
   const settled=turn.settled(),eventCount=f.events.length;
   assert.equal(settled,true,'caller must finish without waiting for an uncooperative fetch');
   if(late==='resolve')resolveTransport({ok:true,status:200,json:async()=>f.sample});
   else rejectTransport(new TypeError('synthetic late network error'));
   const {error,result}=await turn.work;await drain();
   assert.equal(result,undefined);assert.equal(error?.name,cause==='external'?'AbortError':'AiRequestError');
   if(cause==='timer')assert.equal(error.kind,'timeout');
   assert.equal(f.events.length,eventCount,'late transport cannot append progress or another finish');
   assert.equal(f.events.at(-1).outcome,cause==='external'?'aborted':'timeout');
   assert.equal(f.events.at(-1).httpStatus,undefined);assert.equal(f.replies.length,0);clean(f);
  });
 assert.equal(rows.length,20,'all new groups must complete');
 const failed=rows.filter(x=>!x.passed).length;
 console.log(JSON.stringify({sourceRoot,passed:rows.length-failed,failed,externalNetworkCalls:0,legacySuitesRun:0}));
 if(failed)process.exitCode=1;
}
suite().catch(error=>{console.error(error);process.exitCode=1;});


