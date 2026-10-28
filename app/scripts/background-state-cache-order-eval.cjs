const fs=require('node:fs'), path=require('node:path'), vm=require('node:vm'), assert=require('node:assert/strict'), crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),ts=require(root+'/node_modules/typescript'),sources=new Map();
let externalRequests=0;const savedFetch=global.fetch;global.fetch=()=>{externalRequests++;throw Error('external-request-forbidden');};
const clean=v=>JSON.parse(JSON.stringify(v)),hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const read=p=>{const f=path.resolve(root,p);if(!sources.has(f))sources.set(f,fs.readFileSync(f,'utf8'));return sources.get(f);};
class FixedDate extends Date {static now(){return 1700000000000;}}
function harness(candidate,response){
 const wire=[],metrics=[],selection=[],estimates=[],cache=new Map();
 const bare={emotions:{primary:null,secondary:[]},relationshipFeeling:{},relationshipChoice:{},strain:{}};
 const stubs={
 'src/ai/builtInSystemPrompt.ts':{buildCompiledSystemPromptResult:async()=>({stablePrompt:'SYNTHETIC_PERSONA I/you',sections:{expression:'SYNTHETIC_EXPRESSION'}})},
 'src/ai/promptContextProfile.ts':{getPromptContextProfileForSource:()=> 'assistant-state',getPromptOutputAudienceForSource:()=> 'private_visible_text'},
 'src/ai/subjectiveMessages.ts':{SUBJECTIVE_IDENTITY_PROTOCOL:'SYNTHETIC_IDENTITY I/you',getTheaterBackstageContext:()=>''},
 'src/ai/promptDiagnostics.ts':{recordPromptRuntimeSnapshot:()=>{}},
 'src/ai/promptCacheMetrics.ts':{fingerprintPromptText:hash,extractPromptCacheUsageFromResponseUsage:()=>({hitTokens:null}),beginPromptCacheMetric:o=>{metrics.push(clean(o));return {observeSerializedRequest(){},recordUsage(){},finish:async()=>{}}},recordPromptCacheMetricFromResponseUsage:async()=>{}},
 'src/ai/types.ts':{defaultAiProfile:{systemPrompt:'',userNote:''}},
 'src/life/junluoInnerStateStore.ts':{loadJunluoAffectState:async()=>bare,loadJunluoDesireState:async()=>({desires:{rest:{currentValue:2}}})},
 'src/life/junluoInnerState.ts':{BAIYUN_EMOTION_IDS:['calm'],JUNLUO_DESIRE_IDS:['rest']},
 'src/life/junluoInnerStateGeneration.ts':{},'src/life/junluoInnerStatePresentation.ts':{},
 'src/chat/chatAfterglowProbe.ts':{formatChatAfterglowMessageTime:t=>String(t),formatChatAfterglowConversation:m=>m.map(x=>x.role+':'+x.content).join('\n')},
 'src/proactive/unifiedContact.ts':{CONTACT_AFFECT_AFTER_CHAT:{}},'src/proactive/contactWaiting.ts':{formatContactWaiting:()=>''},
 'src/music/musicPlaybackMaterial.ts':{formatMusicPlaybackMaterial:events=>events.map(x=>x.text).join('\n')},
 'src/reading/readingReference.ts':{formatReadingReference:()=>''},'src/chat/chatSummaryCorrection.ts':{CHAT_SUMMARY_CORRECTION_INSTRUCTION:''},
 'src/ai/shortJsonObjects.ts':{readJsonObjects:()=>[]},'src/posts/baiyunPostData.ts':{orderPostComments:x=>x}
 };
 const syntheticFetch=async(url,options)=>{
  wire.push({url,body:JSON.parse(options.body)});
  return {ok:true,status:200,json:async()=>({choices:[{message:{content:response},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}})};
 };
 function load(relative){
  relative=relative.replaceAll('\\','/');if(stubs[relative])return stubs[relative];if(cache.has(relative))return cache.get(relative).exports;
  let source=read(relative);
  if(/assistantAffectGenerator\.ts$/.test(relative)){const from="    { role: 'system' as const, content: ASSISTANT_AFFECT_PROMPT },\n    { role: 'system' as const, content: material() },";const n=source.replaceAll('\r\n','\n');assert.equal(n.split(from).length,2);if(!candidate)source=n.replace(from,"    { role: 'system' as const, content: material() },\n    { role: 'system' as const, content: ASSISTANT_AFFECT_PROMPT },");}
  if(/assistantStateGenerator\.ts$/.test(relative)){const from="    { role: 'system', content: taskPrompt },\n    { role: 'system', content: facts() },";const n=source.replaceAll('\r\n','\n');assert.equal(n.split(from).length,2);if(!candidate)source=n.replace(from,"    { role: 'system', content: facts() },\n    { role: 'system', content: taskPrompt },");}
  const module={exports:{}};cache.set(relative,module);
  const req=spec=>{assert.ok(spec.startsWith('.'),'unexpected dependency '+spec);return load(path.relative(root,path.resolve(path.dirname(path.resolve(root,relative)),spec+'.ts')).replaceAll('\\','/'));};
  const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  vm.runInNewContext('(function(require,module,exports){'+compiled+'\n})',{AbortController,setTimeout,clearTimeout,Date:FixedDate,fetch:syntheticFetch})(req,module,module.exports);
  return module.exports;
 }
 const compression=load('src/chat/contextCompression.ts'),originalEstimate=compression.estimateApiMessagesTokens;
 compression.estimateApiMessagesTokens=m=>{const n=originalEstimate(m);estimates.push(n);return n;};
 return {load,wire,metrics,selection,estimates};
}
function input(kind,variant={}){
 const common={apiKey:'SYNTHETIC_NOT_A_KEY',connection:{id:'synthetic',model:'arbitrary-model',baseUrl:'https://invalid.example',contextWindowTokens:64000},profile:{systemPrompt:'',userNote:''},currentState:{lifeMode:'available'},now:1000,onRequestStart:async ready=>{await ready?.();},...variant};
 return kind==='affect'?{...common,messages:[{role:'you',content:'SYNTHETIC YOU',createdAt:900}],lifeMaterial:'SYNTHETIC LIFE',music:[{text:'SYNTHETIC MUSIC'}],...variant}:{...common,source:'afterglow',conversationRounds:[[{role:'you',content:'SYNTHETIC YOU',time:'900'}],[{role:'I',content:'SYNTHETIC I',time:'950'}]],chatSupplementCount:2,outingCount:2,musicForRounds:n=>Array.from({length:n},()=>({text:'SYNTHETIC MUSIC'})),materialForRounds:(n,s,o)=>({text:'SYNTHETIC FACTS '+n+'/'+s+'/'+o}),...variant};
}
async function run(kind,candidate,variant={},bad=false){
 const response=bad?'not-json':kind==='affect'?' {"affect":null} ':' {"wants":null'+(variant.postLookKind?',"lookAtPost":true':'')+'} ';
 const h=harness(candidate,response),v=input(kind,variant);
 for(const [name,key] of [['onMusicSelected','music'],['onConversationSelected','rounds'],['onChatSupplementSelected','supplements'],['onOutingSelected','outings']])v[name]=value=>h.selection.push([key,clean(value)]);
 const mod=h.load(kind==='affect'?'src/ai/assistantAffectGenerator.ts':'src/ai/assistantStateGenerator.ts');
 const p=await(kind==='affect'?mod.prepareAssistantAffect(v):mod.prepareAssistantWants(v)),result=await p.execute();
 return {...h,fits:p.fits,result:clean(result)};
}
function compare(a,b){
 assert.equal(a.fits,b.fits);assert.deepEqual(a.selection,b.selection);assert.deepEqual(a.estimates,b.estimates);assert.deepEqual(a.result,b.result);assert.deepEqual(a.metrics,b.metrics);assert.equal(a.wire.length,b.wire.length);
 for(let i=0;i<a.wire.length;i++){const x=a.wire[i],y=b.wire[i];assert.equal(x.url,y.url);const{messages:am,...ap}=x.body,{messages:bm,...bp}=y.body;assert.deepEqual(ap,bp);assert.equal(am.length,3);assert.deepEqual(bm,[am[0],am[2],am[1]]);assert.ok(bm.every(m=>m.role==='system'));}
}
(async()=>{
 const results=[];async function pair(name,kind,v={},bad=false){const a=await run(kind,false,v,bad),b=await run(kind,true,v,bad);compare(a,b);results.push({name,passed:true,requestsPerRun:b.wire.length,fits:b.fits,selected:b.selection.map(([kind,value])=>[kind,kind==='music'?value.length:value]),status:b.result.status});return {a,b};}
 const normal=await pair('affect-normal','affect'),next=await run('affect',true,{now:2000});assert.deepEqual(normal.b.wire[0].body.messages.slice(0,2),next.wire[0].body.messages.slice(0,2));
 const cropA=await pair('affect-music-capacity','affect',{connection:{id:'synthetic',model:'arbitrary-model',baseUrl:'https://invalid.example',contextWindowTokens:5000},music:[{text:'M'.repeat(18000)},{text:'tail'}]});assert.equal(cropA.b.selection.find(x=>x[0]==='music')[1].length,1);
 const tasks=[];
 for(const postLookKind of [undefined,'posts','comments','both']){const{a,b}=await pair('wants-'+(postLookKind??'plain'),'wants',{postLookKind});const a2=await run('wants',false,{postLookKind,now:2000}),b2=await run('wants',true,{postLookKind,now:2000});assert.notDeepEqual(a.wire[0].body.messages.slice(0,2),a2.wire[0].body.messages.slice(0,2));assert.deepEqual(b.wire[0].body.messages.slice(0,2),b2.wire[0].body.messages.slice(0,2));tasks.push(hash(b.wire[0].body.messages[1].content));}
 assert.equal(new Set(tasks).size,4);
 const shrink={connection:{id:'synthetic',model:'arbitrary-model',baseUrl:'https://invalid.example',contextWindowTokens:2500},materialForRounds:(n,s,o)=>({text:'F'.repeat(n*900+s*1100+o*1200)}),musicForRounds:n=>Array.from({length:n},()=>({text:'M'.repeat(800)}))};
 await pair('wants-capacity','wants',shrink);const fixed=await pair('wants-fixed-oversize','wants',{...shrink,fixedChatSelection:true});assert.equal(fixed.b.wire.length,0);assert.equal(fixed.b.result.reason,'context-too-long');
 await pair('affect-invalid-parser','affect',{},true);await pair('wants-invalid-parser','wants',{},true);
 assert.equal(results.length,10);assert.equal(externalRequests,0);
 console.log(JSON.stringify({groups:results.length,passed:results.filter(x=>x.passed).length,externalRequests,actualProductionSourcesVerified:true,results,taskBranchHashes:tasks,sourceHashes:Object.fromEntries([...sources].map(([p,s])=>[path.relative(root,p).replaceAll('\\','/'),hash(s)])),limitations:['Compiler/material/storage/transport ports synthetic; actual two generators, prompt constants/parsers, post-look builder, token estimator and life transport helper executed.','Actual adopted generators used; only the comparison baseline reverses the two System entries in RAM.','No model/cache-rate or comprehension validation.']},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{global.fetch=savedFetch;});
