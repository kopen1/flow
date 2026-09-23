
// Background: storage passthrough + trusted input dispatch via CDP (chrome.debugger).
// Some sites ignore synthetic .click()/KeyboardEvent because isTrusted is false.
// chrome.debugger lets us send real input events at the browser-engine level,
// the same mechanism tools like Puppeteer/Playwright use.

function attach(tabId){
  return new Promise((resolve)=>{
    chrome.debugger.attach({tabId}, '1.3', ()=>{
      if(chrome.runtime.lastError){
        resolve({ok:false, error: chrome.runtime.lastError.message});
      } else {
        resolve({ok:true});
      }
    });
  });
}
function detach(tabId){
  return new Promise((resolve)=>{
    chrome.debugger.detach({tabId}, ()=> resolve());
  });
}
function send(tabId, method, params){
  return new Promise((resolve)=>{
    chrome.debugger.sendCommand({tabId}, method, params, (result)=>{
      if(chrome.runtime.lastError){ resolve({ok:false, error: chrome.runtime.lastError.message}); }
      else resolve({ok:true, result});
    });
  });
}

async function trustedClick(tabId, x, y){
  const a=await attach(tabId);
  if(!a.ok) return a;
  try{
    await send(tabId, 'Input.dispatchMouseEvent', {type:'mouseMoved', x, y});
    await send(tabId, 'Input.dispatchMouseEvent', {type:'mousePressed', x, y, button:'left', clickCount:1});
    await send(tabId, 'Input.dispatchMouseEvent', {type:'mouseReleased', x, y, button:'left', clickCount:1});
    return {ok:true};
  } finally {
    await detach(tabId);
  }
}

async function trustedKey(tabId, key){
  const a=await attach(tabId);
  if(!a.ok) return a;
  try{
    const map={ 'Enter': {key:'Enter', code:'Enter', windowsVirtualKeyCode:13, nativeVirtualKeyCode:13, unmodifiedText:'\r', text:'\r'} };
    const base = map[key] || {key};
    await send(tabId, 'Input.dispatchKeyEvent', {type:'keyDown', ...base});
    await send(tabId, 'Input.dispatchKeyEvent', {type:'keyUp', ...base});
    return {ok:true};
  } finally {
    await detach(tabId);
  }
}

chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
  if(msg.type==='SET_STORAGE'){
    chrome.storage.local.set(msg.data, ()=>sendResponse({ok:true}));
    return true;
  }
  if(msg.type==='GET_STORAGE'){
    chrome.storage.local.get(msg.keys, res=>sendResponse(res));
    return true;
  }
  if(msg.type==='FA_TRUSTED_CLICK'){
    const tabId = sender.tab?.id;
    if(!tabId){ sendResponse({ok:false, error:'no tab id'}); return true; }
    trustedClick(tabId, msg.x, msg.y).then(sendResponse);
    return true;
  }
  if(msg.type==='FA_DOWNLOAD_URL'){
    chrome.downloads.download({url:msg.url, filename:msg.filename||undefined, saveAs:false}, id=>sendResponse({ok:!chrome.runtime.lastError, id, error:chrome.runtime.lastError?.message}));
    return true;
  }
  if(msg.type==='FA_TRUSTED_KEY'){
    const tabId = sender.tab?.id;
    if(!tabId){ sendResponse({ok:false, error:'no tab id'}); return true; }
    trustedKey(tabId, msg.key||'Enter').then(sendResponse);
    return true;
  }
});
