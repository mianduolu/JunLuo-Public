import type { GiftAttachmentActivity } from './giftTypes';

export const GIFT_WEB_CHANNEL = 'junluo-gift-v1';
export const giftScriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** Display-only additions; the imported HTML original is never rewritten on disk. */
export function buildGiftWebDocument(html: string, sessionId: string, activity: GiftAttachmentActivity) {
  const bootstrap = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; style-src 'unsafe-inline' data:; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">
<script>(function(){
  var channel=${giftScriptJson(GIFT_WEB_CHANNEL)}, sessionId=${giftScriptJson(sessionId)};
  var saved=${giftScriptJson(activity)}, progress=saved.progress, sequence=0, pending={}, tail=Promise.resolve();
  function copy(value){return JSON.parse(JSON.stringify(value));}
  function request(type, value){return new Promise(function(resolve,reject){
    var id=++sequence; pending[id]={resolve:resolve,reject:reject};
    var message=JSON.stringify({channel:channel,sessionId:sessionId,id:id,type:type,progress:value});
    if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(message);
    else parent.postMessage(message,'*');
  });}
  window.__junluoGiftReply=function(message){
    if(!message||message.channel!==channel||message.sessionId!==sessionId||!pending[message.id])return;
    var waiter=pending[message.id]; delete pending[message.id];
    if(message.ok){saved=message.activity;waiter.resolve(copy(saved));}
    else waiter.reject(new Error(message.error||'gift-progress-save-failed'));
  };
  window.addEventListener('message',function(event){
    if(event.source!==parent)return;
    try{window.__junluoGiftReply(typeof event.data==='string'?JSON.parse(event.data):event.data);}catch(error){}
  });
  function save(next){
    progress=copy(next); var value=copy(progress);
    tail=request('save',value);
    return tail;
  }
  window.junluoGift={
    loadState:function(){return tail.then(function(){return copy(saved.progress);});},
    saveState:function(state,summary){return save({state:state,summary:String(summary||''),storage:progress.storage});},
    resetState:function(){
      progress={state:null,summary:'',storage:{}};
      tail=request('reset'); return tail;
    }
  };
  var methods={
    getItem:function(key){key=String(key);return Object.prototype.hasOwnProperty.call(progress.storage,key)?progress.storage[key]:null;},
    setItem:function(key,value){var storage=copy(progress.storage);Object.defineProperty(storage,String(key),{value:String(value),enumerable:true,configurable:true,writable:true});save({state:progress.state,summary:progress.summary,storage:storage}).catch(function(){});},
    removeItem:function(key){var storage=copy(progress.storage);delete storage[String(key)];save({state:progress.state,summary:progress.summary,storage:storage}).catch(function(){});},
    clear:function(){save({state:progress.state,summary:progress.summary,storage:{}}).catch(function(){});},
    key:function(index){var key=Object.keys(progress.storage)[index];return key===undefined?null:key;}
  };
  var storage=new Proxy(methods,{
    get:function(target,key){if(key==='length')return Object.keys(progress.storage).length;if(key in target)return target[key];var value=methods.getItem(key);return value===null?undefined:value;},
    set:function(target,key,value){methods.setItem(key,value);return true;},
    deleteProperty:function(target,key){methods.removeItem(key);return true;},
    ownKeys:function(){return Object.keys(progress.storage);},
    getOwnPropertyDescriptor:function(target,key){if(Object.prototype.hasOwnProperty.call(progress.storage,key))return{configurable:true,enumerable:true,value:progress.storage[key],writable:true};}
  });
  try{Object.defineProperty(window,'localStorage',{value:storage,configurable:false});}
  catch(error){request('storage-unavailable').catch(function(){});}
})();</script>`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)?.[0] ?? '';
  return (doctype || '<!doctype html>') + bootstrap + html.slice(doctype.length);
}
