
(function(){
  if(window.__FLOW_FIXGEN__) return;
  window.__FLOW_FIXGEN__=true;

  const MSG='__FA_MSG__';
  const isTop = (window===window.top);

  // ---------- shared DOM-scan helpers (used by both top frame and worker frames) ----------
  function findAllInputs(doc){
    const selectors=[
      'textarea',
      'div[contenteditable="true"]',
      '[role="textbox"]',
      '[data-testid*="prompt"] textarea',
      '[data-testid*="prompt"] [contenteditable]',
      'div[aria-label*="prompt" i][contenteditable]',
      'div[aria-label*="describe" i][contenteditable]',
      'input[type="text"]',
    ];
    let found=[];
    selectors.forEach(sel=>{
      try{
        doc.querySelectorAll(sel).forEach(el=>{
          if(!found.includes(el)) found.push(el);
        });
      }catch(e){}
    });
    return found.filter(el=>{
      const r=el.getBoundingClientRect();
      return r.width>60 && r.height>16 && r.top>=0 && r.top<innerHeight;
    });
  }

  function findAllGenButtons(doc){
    const candidates=[...doc.querySelectorAll('button, [role="button"], div[tabindex]')];
    return candidates.filter(b=>{
      const txt=(b.innerText||b.textContent||'').trim().toLowerCase();
      const aria=(b.getAttribute('aria-label')||'').toLowerCase();
      const hay=txt+' '+aria;
      const isGenLike = /generate|create|buat|hasilkan|submit|kirim|run/.test(hay);
      const r=b.getBoundingClientRect();
      const visible = r.width>10 && r.height>10;
      return isGenLike && visible;
    });
  }

  function findBestInput(doc){
    const all=findAllInputs(doc);
    if(!all.length) return null;
    all.sort((a,b)=> b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    return all[0];
  }

  function findBestGenButton(doc){
    const all=findAllGenButtons(doc);
    if(!all.length) return null;
    all.sort((a,b)=> b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    return all[0];
  }

  // Fixed fill routine: one clean event sequence per element type, no duplicate/out-of-order events.
  function fillInputRobust(el, text){
    if(!el) return false;
    try{
      el.focus();
      if(el.tagName==='TEXTAREA' || el.tagName==='INPUT'){
        const proto = el.tagName==='TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        const lastValue = el.value;
        if(nativeSetter){
          nativeSetter.call(el, text);
        } else {
          el.value = text;
        }
        const tracker = el._valueTracker;
        if(tracker) tracker.setValue(lastValue);
        el.dispatchEvent(new Event('input',{bubbles:true}));
        el.dispatchEvent(new Event('change',{bubbles:true}));
      } else {
        // contenteditable rich-text editors (Lexical/ProseMirror/Draft etc.)
        el.focus();
        const sel=window.getSelection();
        const range=document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        const okBeforeInput = el.dispatchEvent(new InputEvent('beforeinput',{bubbles:true, cancelable:true, data:text, inputType:'insertText'}));
        if(okBeforeInput){
          // execCommand still fires the correct native 'input' event chain in Chrome
          document.execCommand('insertText', false, text);
        }
        if(!el.textContent || el.textContent.trim().length<Math.min(3,text.length)){
          el.textContent = text;
          el.dispatchEvent(new InputEvent('input',{bubbles:true, data:text, inputType:'insertText'}));
        }
      }
      return true;
    }catch(e){
      return false;
    }
  }

  function pressEnter(el){
    ['keydown','keypress','keyup'].forEach(type=>{
      el.dispatchEvent(new KeyboardEvent(type,{bubbles:true, cancelable:true, key:'Enter', code:'Enter', keyCode:13, which:13}));
    });
  }

  // Best-effort offset of this frame within the top page (only works while every
  // ancestor frame is same-origin; if a cross-origin ancestor blocks it, the
  // offset stops accumulating there and the coordinates may be slightly off).
  function frameOffset(){
    let x=0,y=0,win=window;
    try{
      while(win!==win.top){
        const fe=win.frameElement;
        if(!fe) break;
        const r=fe.getBoundingClientRect();
        x+=r.left; y+=r.top;
        win=win.parent;
      }
    }catch(e){}
    return {x,y};
  }

  function elCenterInPage(el){
    const r=el.getBoundingClientRect();
    const off=frameOffset();
    return { x: Math.round(off.x + r.left + r.width/2), y: Math.round(off.y + r.top + r.height/2) };
  }

  // Real, browser-level click/keypress via chrome.debugger (CDP) - passes
  // isTrusted checks that a plain el.click()/dispatchEvent cannot.
  async function trustedClickEl(el){
    try{ el.click(); }catch(e){} // harmless best-effort in case the site doesn't check isTrusted
    const {x,y}=elCenterInPage(el);

    // Guard: if our own floating panel is visually on top of the click point,
    // a real coordinate-based click (via CDP) would hit OUR panel instead of
    // the page underneath. Temporarily make the panel click-through.
    const panel = document.getElementById('flow-auto-root');
    let restorePE = null;
    let blocked = false;
    if(panel){
      const hit = document.elementFromPoint(x, y);
      blocked = !!(hit && panel.contains(hit));
      if(blocked){
        restorePE = panel.style.pointerEvents;
        panel.style.pointerEvents = 'none';
      }
    }
    try{
      const res = await chrome.runtime.sendMessage({type:'FA_TRUSTED_CLICK', x, y});
      const hitAfter = document.elementFromPoint(x, y);
      const stillMismatched = hitAfter && hitAfter!==el && !el.contains(hitAfter) && !(hitAfter.contains && hitAfter.contains(el));
      return {...res, blocked, mismatch: stillMismatched ? (hitAfter.tagName||'?')+(hitAfter.className?('.'+String(hitAfter.className).split(' ')[0]):'') : null};
    }catch(e){
      return {ok:false, error:e.message, blocked};
    }finally{
      if(panel && restorePE!==null){ panel.style.pointerEvents = restorePE; }
    }
  }
  async function trustedEnter(){
    try{
      return await chrome.runtime.sendMessage({type:'FA_TRUSTED_KEY', key:'Enter'});
    }catch(e){ return {ok:false, error:e.message}; }
  }

  function scanSummary(doc){
    const inputs=findAllInputs(doc);
    const btns=findAllGenButtons(doc);
    return {
      url: location.href,
      inputCount: inputs.length,
      btnCount: btns.length,
      inputs: inputs.slice(0,3).map(el=>({tag:el.tagName.toLowerCase(), ph:el.placeholder||'', ce:el.getAttribute('contenteditable')||'', cls:(el.className||'').toString().slice(0,30)})),
      btns: btns.slice(0,3).map(b=>({text:(b.innerText||'').slice(0,30), aria:(b.getAttribute('aria-label')||'').slice(0,20), disabled: !!b.disabled}))
    };
  }

  // ---------- WORKER MODE (runs in every matching frame, including iframes) ----------
  function initWorker(){
    if(!isTop){
      try{ window.parent.postMessage({channel:MSG, type:'FA_HELLO', url:location.href}, '*'); }catch(e){}
    }
    window.addEventListener('message', (ev)=>{
      const d=ev.data;
      if(!d || d.channel!==MSG) return;
      if(d.type==='FA_SCAN_REQ'){
        ev.source.postMessage({channel:MSG, type:'FA_SCAN_RES', reqId:d.reqId, summary: scanSummary(document)}, '*');
      }
      if(d.type==='FA_FILL_AND_CLICK_REQ'){
        const log=[];
        const input=findBestInput(document);
        let filled=false, clicked=false;
        if(input){
          filled=fillInputRobust(input, d.text);
          log.push(filled?`Isi input OK (<${input.tagName.toLowerCase()}>)`:'Gagal isi input');
        } else {
          log.push('Input tidak ditemukan di frame ini');
        }
        setTimeout(async ()=>{
          let btn=findBestGenButton(document);
          if(btn && !btn.disabled){
            const res=await trustedClickEl(btn);
            clicked=!!res?.ok;
            log.push(res?.ok?`Trusted click terkirim ke tombol: "${(btn.innerText||btn.getAttribute('aria-label')||'').slice(0,20)}"`:`Trusted click gagal: ${res?.error||'unknown'}`);
          } else if(btn && btn.disabled){
            log.push('Tombol Generate ditemukan tapi disabled - coba trusted Enter sebagai fallback');
            const res=await trustedEnter();
            log.push(res?.ok?'Trusted Enter terkirim':`Trusted Enter gagal: ${res?.error||'unknown'}`);
          } else if(input){
            log.push('Tombol Generate tidak ditemukan - coba trusted Enter sebagai fallback');
            const res=await trustedEnter();
            log.push(res?.ok?'Trusted Enter terkirim':`Trusted Enter gagal: ${res?.error||'unknown'}`);
          }
          ev.source.postMessage({channel:MSG, type:'FA_FILL_AND_CLICK_RES', reqId:d.reqId, ok: filled, clicked, log}, '*');
        }, 400);
      }
    });
  }

  // ---------- CONTROLLER MODE (only the top frame renders the panel) ----------
  if(!isTop){ initWorker(); return; }
  initWorker(); // top frame also answers its own scan/fill requests via loopback below

  const STATE={
    tab:'images', ptab:'file', minimized:false, projectId:null, shortId:null, connected:false,
    prompts:[], queue:[], running:false, logText:'',
    settings:{ modelImage:'Nano Banana 2', aspectImage:'16:9', countImage:'x1', modelVideo:'Veo 3.1 Lite', duration:'8s' },
    delay:10, refs:{subject:[],scene:[],style:[]}, autoDownload:false, assets:{}
  };
  const workerFrames=new Map(); // window -> {url}
  let reqCounter=0;
  chrome.storage.local.get({faAutoDownload:false,faAssets:{},faLog:'',faDelay:10,faSettings:STATE.settings}, s=>{STATE.autoDownload=!!s.faAutoDownload;STATE.assets=s.faAssets||{};STATE.delay=Math.max(0,Number(s.faDelay)||10);STATE.settings={...STATE.settings,...(s.faSettings||{})};if(s.faLog)STATE.logText=s.faLog;});
  chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
    if(msg.type==='FA_SETUP_START'){STATE.prompts=(msg.prompts||[]).slice();STATE.queue=STATE.prompts.map((text,id)=>({id,text,status:'queued'}));if(msg.settings)STATE.settings={...STATE.settings,...msg.settings};if(msg.delay!=null)STATE.delay=Math.max(0,Number(msg.delay)||0);chrome.storage.local.set({faSettings:STATE.settings,faDelay:STATE.delay});start();sendResponse({ok:true});return true;}
    if(msg.type==='FA_SETUP_STOP'){STATE.running=false;log('Stopped from Setup tab');sendResponse({ok:true});return true;}
    if(msg.type==='FA_SETUP_RETRY'){const item=STATE.queue[msg.index];if(!item){sendResponse({ok:false,error:'queue item not found'});return true;}if(msg.settings)STATE.settings={...STATE.settings,...msg.settings};if(msg.delay!=null)STATE.delay=Math.max(0,Number(msg.delay)||0);retryItem(item).then(()=>sendResponse({ok:true}));return true;}
    if(msg.type==='FA_SET_AUTODOWNLOAD'){STATE.autoDownload=!!msg.value;chrome.storage.local.set({faAutoDownload:STATE.autoDownload});sendResponse({ok:true});return true;}
    if(msg.type==='FA_GET_STATE'){sendResponse({ok:true,autoDownload:STATE.autoDownload,assets:STATE.assets,queue:STATE.queue,log:STATE.logText,settings:STATE.settings,delay:STATE.delay});return true;}
  });

  window.addEventListener('message', (ev)=>{
    const d=ev.data;
    if(!d || d.channel!==MSG) return;
    if(d.type==='FA_HELLO'){
      workerFrames.set(ev.source, {url: d.url||'(iframe)'});
    }
  });

  function requestFrame(win, payload, timeoutMs){
    return new Promise(resolve=>{
      const reqId='r'+(++reqCounter);
      let done=false;
      const handler=(ev)=>{
        const d=ev.data;
        if(!d || d.channel!==MSG || d.reqId!==reqId) return;
        done=true;
        window.removeEventListener('message', handler);
        resolve(d);
      };
      window.addEventListener('message', handler);
      win.postMessage({channel:MSG, reqId, ...payload}, '*');
      setTimeout(()=>{ if(!done){ window.removeEventListener('message', handler); resolve(null); } }, timeoutMs||1500);
    });
  }

  async function scanEverywhere(){
    const results=[{scope:'top', summary: scanSummary(document)}];
    for(const [win, meta] of workerFrames){
      const res=await requestFrame(win, {type:'FA_SCAN_REQ'}, 1200);
      if(res) results.push({scope:meta.url, summary: res.summary});
    }
    return results;
  }

  function getProjectId(){
    let m=location.pathname.match(/\/project\/([a-z0-9\-]+)/i);
    if(m) return m[1];
    m=location.href.match(/project\/([a-z0-9\-]+)/i);
    if(m) return m[1];
    return null;
  }

  function ensureRoot(){
    if(document.getElementById('flow-auto-root')) return;
    const r=document.createElement('div');
    r.id='flow-auto-root';
    document.documentElement.appendChild(r);
  }

  function render(){
    ensureRoot();
    const root=document.getElementById('flow-auto-root');
    const pid=getProjectId();
    STATE.projectId=pid;
    STATE.shortId=pid?pid.slice(0,6):null;
    STATE.connected=!!pid;
    if(STATE.minimized) root.classList.add('minimized'); else root.classList.remove('minimized');

    root.innerHTML=`
      <div class="fa-header">
        <div><b>${STATE.minimized?'◫':'Flow Automator Fix'}</b>${!STATE.minimized?'<small>No AutoDownload • Real Gen Only</small>':''}</div>
        <button class="fa-min-btn" id="minBtn">${STATE.minimized?'□':'—'}</button>
      </div>
      <div class="fa-body">
        <div class="fa-tabs">
          <button data-tab="images" class="${STATE.tab==='images'?'active':''}">Images</button>
          <button data-tab="videos" class="${STATE.tab==='videos'?'active':''}">Videos</button>
          <button data-tab="log" class="${STATE.tab==='log'?'active':''}">Log</button>
        </div>
        <div class="fa-status ${STATE.connected?'connected':''}">
          <div class="fa-dot"></div><div>${STATE.connected?`Ready · ${STATE.shortId} · konek`:`Not connected`}</div>
        </div>
        ${STATE.tab==='log' ? `
        <div class="fa-sec">
          <div style="font-size:10px;opacity:.6;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;">
            <span>Log &amp; Debug</span>
            <button id="clearLog" style="font-size:9px;padding:3px 8px;border-radius:10px;border:1px solid #222;background:#141414;color:#888;cursor:pointer;">Clear</button>
          </div>
          <div class="fa-debug" id="debugBox">scanning...</div>
          <div id="log" class="fa-log fa-log-big">${STATE.logText}</div>
        </div>
        ` : `
        <div class="fa-sec">
          <div style="font-size:10px;opacity:.6;margin-bottom:6px;">Prompts (${STATE.prompts.length})</div>
          <div class="fa-ptabs">
            <button data-ptab="file" class="${STATE.ptab==='file'?'active':''}">Upload File</button>
            <button data-ptab="text" class="${STATE.ptab==='text'?'active':''}">Paste Text</button>
          </div>
          <div id="drop" class="fa-drop">↑ Drop .txt or click to browse<input type="file" id="filein" accept=".txt" style="display:none"></div>
          <textarea id="paste" class="fa-ta ${STATE.ptab==='text'?'show':''}" placeholder="Satu prompt per baris kosong..."></textarea>
          ${STATE.prompts.length?`<div style="margin-top:6px;background:#111;border:1px solid #1a1a1a;border-radius:8px;padding:6px;max-height:90px;overflow:auto;font-size:10px;">${STATE.prompts.map((p,i)=>`<div>${i+1}. ${p.slice(0,60)}</div>`).join('')}</div>`:''}
        </div>
        <div class="fa-sec">
          <div style="font-size:10px;opacity:.6;margin-bottom:6px;">Queue - Main</div>
          <div id="qlist">${STATE.queue.length?STATE.queue.map(q=>`<div class="fa-qitem ${q.status==='generating'?'gen':''} ${q.status==='done'?'done':''}"><div class="fa-num">${q.id+1}</div><div style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(q.text.slice(0,40))}</div><div style="opacity:.5;font-size:9px">${q.status}</div>${q.status==='failed'?`<button data-retry="${q.id}" style="font-size:9px;padding:4px 7px;border-radius:9px;border:1px solid #444;background:#222;color:#fff">↻</button>`:''}</div>`).join(''):`<div style="text-align:center;padding:12px;background:#101010;border:1px dashed #222;border-radius:8px;color:#666;font-size:10px;">No prompts yet</div>`}</div>
        </div>
        <div class="fa-debug fa-debug-mini" id="debugBox">scanning...</div>
        `}
        ${STATE.tab==='images'?`<div class="fa-sec"><div style="font-size:10px;opacity:.6;display:flex;justify-content:space-between;align-items:center"><span>Auto Download</span><button id="autoDl" style="padding:4px 9px;border-radius:12px;border:1px solid #333;background:${STATE.autoDownload?'#17351f':'#171717'};color:${STATE.autoDownload?'#4ade80':'#888'};cursor:pointer">${STATE.autoDownload?'ON':'OFF'}</button></div><div style="font-size:9px;opacity:.5;margin-top:5px">Default OFF · Flow tidak dijalankan otomatis</div></div>`:''}
        ${STATE.tab==='images'?`<div class="fa-sec"><div style="font-size:10px;opacity:.6;margin-bottom:7px">Settings Image</div><div class="fa-grid"><button data-setting="modelImage">${escapeHtml(STATE.settings.modelImage)}</button><button data-setting="aspectImage">${escapeHtml(STATE.settings.aspectImage)}</button><button data-setting="countImage">${escapeHtml(STATE.settings.countImage)}</button></div><div style="font-size:9px;opacity:.5;margin-top:6px">Video: ${escapeHtml(STATE.settings.modelVideo)} · ${escapeHtml(STATE.settings.duration)}</div><div style="font-size:9px;opacity:.5;margin-top:5px">Jeda antar generate: ${STATE.delay}s</div></div>`:''}
        <div class="fa-bar">
          <button class="fa-stop" id="stop">■ Stop</button>
          <button class="fa-testfill" id="testfill">⌁ Test Fill</button>
          <button class="fa-start" id="start">▶ Start ${STATE.queue.length?`(${STATE.queue.length})`:''}</button>
        </div>
      </div>
    `;
    bind();
    updateDebug();
  }

  function bind(){
    document.getElementById('minBtn')?.addEventListener('click', ()=>{ STATE.minimized=!STATE.minimized; render(); });
    document.querySelectorAll('[data-tab]').forEach(b=> b.addEventListener('click', ()=>{ STATE.tab=b.dataset.tab; render(); }));
    document.querySelectorAll('[data-ptab]').forEach(b=> b.addEventListener('click', ()=>{ STATE.ptab=b.dataset.ptab; render(); }));
    const drop=document.getElementById('drop');
    const filein=document.getElementById('filein');
    if(drop && filein){
      drop.addEventListener('click', ()=>filein.click());
      filein.addEventListener('change', e=>{ if(e.target.files[0]) loadFile(e.target.files[0]); });
      drop.addEventListener('dragover', e=>{ e.preventDefault(); drop.style.borderColor='#fff'; });
      drop.addEventListener('dragleave', ()=> drop.style.borderColor='#222');
      drop.addEventListener('drop', e=>{ e.preventDefault(); drop.style.borderColor='#222'; if(e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });
    }
    const paste=document.getElementById('paste');
    if(paste){
      paste.addEventListener('input', e=>{
        const parts=e.target.value.split(/\n\s*\n/).map(s=>s.trim()).filter(Boolean);
        if(parts.length) loadPrompts(parts);
      });
    }
    document.getElementById('start')?.addEventListener('click', start);
    document.getElementById('testfill')?.addEventListener('click', testFillOnly);
    document.getElementById('stop')?.addEventListener('click', ()=>{ STATE.running=false; log('Stopped'); });
    document.querySelectorAll('[data-retry]').forEach(b=>b.addEventListener('click',()=>retryItem(STATE.queue[+b.dataset.retry])));
    document.getElementById('autoDl')?.addEventListener('click',()=>{STATE.autoDownload=!STATE.autoDownload;chrome.storage.local.set({faAutoDownload:STATE.autoDownload});render();});
    document.querySelectorAll('[data-setting]').forEach(b=>b.addEventListener('click',()=>cycleSetting(b.dataset.setting)));
    document.getElementById('clearLog')?.addEventListener('click', ()=>{ STATE.logText=''; const el=document.getElementById('log'); if(el) el.textContent=''; });
  }

  function cycleSetting(key){
    const opts={modelImage:['Nano Banana 2','Nano Banana Pro'],aspectImage:['16:9','9:16','1:1','4:3','3:4'],countImage:['x1','x2','x3','x4'],modelVideo:['Veo 3.1 Lite','Veo 3.1'],duration:['8s','10s','15s']};
    const arr=opts[key];if(!arr)return;const i=Math.max(0,arr.indexOf(STATE.settings[key]));STATE.settings[key]=arr[(i+1)%arr.length];chrome.storage.local.set({faSettings:STATE.settings});log(`Setting ${key} = ${STATE.settings[key]}`);render();
  }

  function loadFile(file){
    file.text().then(t=>{
      const parts=t.split(/\n\s*\n|\n/).map(s=>s.trim()).filter(Boolean);
      loadPrompts(parts);
    });
  }
  function loadPrompts(list){
    STATE.prompts=list;
    STATE.queue=list.map((text,id)=>({id, text, status:'queued'}));
    render();
  }
  function log(msg){
    STATE.logText += `> ${msg}\n`;
    const el=document.getElementById('log');
    if(el){ el.textContent=STATE.logText; el.scrollTop=el.scrollHeight; }
    chrome.storage.local.set({faLog:STATE.logText,faAssets:STATE.assets});
    console.log('[FlowFix]', msg);
  }

  async function updateDebug(){
    const box=document.getElementById('debugBox');
    if(!box) return;
    const results = await scanEverywhere();
    const top = results.find(r=>r.scope==='top')?.summary;
    const totalInput = results.reduce((n,r)=>n+r.summary.inputCount,0);
    const totalBtn = results.reduce((n,r)=>n+r.summary.btnCount,0);
    const btnLabel = results.flatMap(r=>r.summary.btns).map(b=>b.text||b.aria).find(Boolean) || '-';
    const ok = totalInput>0 && totalBtn>0;
    box.innerHTML = `<span style="color:${ok?'#4ade80':'#f59e0b'}">${ok?'✓':'⚠'}</span> ${totalInput} input · ${totalBtn} tombol gen (${btnLabel})${workerFrames.size?` · ${workerFrames.size} iframe`:''}`;
  }

  // Picks whichever scope (top or a worker frame) actually has a usable input, preferring one with a non-disabled gen button.
  async function pickTargetScope(){
    const localBtn=findBestGenButton(document);
    const localInput=findBestInput(document);
    if(localInput && localBtn && !localBtn.disabled) return {win:null};
    for(const [win] of workerFrames){
      const res=await requestFrame(win, {type:'FA_SCAN_REQ'}, 1200);
      if(res && res.summary.inputCount>0) return {win};
    }
    if(localInput) return {win:null};
    return null;
  }

  async function testFillOnly(){
    log('Test Fill: mencari input di semua frame...');
    const target=await pickTargetScope();
    if(!target){ log('Tidak ada input ditemukan di halaman utama maupun iframe. Cek panel debug di atas.'); return; }
    const sample = STATE.queue[0]?.text || 'test prompt dari extension';
    if(target.win===null){
      const input=findBestInput(document);
      const ok=fillInputRobust(input, sample);
      log(ok?'✓ Berhasil isi teks di halaman utama. Cek apakah teks muncul di Flow.':'✗ Gagal isi teks.');
    } else {
      const res=await requestFrame(target.win, {type:'FA_FILL_AND_CLICK_REQ', text: sample+' [TEST - jangan generate]'}, 3000);
      // note: this also tries to click Generate; acceptable for test since it confirms the whole pipeline works
      (res?.log||['Tidak ada respons dari iframe']).forEach(l=>log('[iframe] '+l));
    }
  }

  function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function parsePrompt(raw){const names=[...String(raw).matchAll(/#([A-Za-z0-9_-]+)/g)].map(m=>m[1]);let prompt=String(raw).replace(/#([A-Za-z0-9_-]+)/g,'').trim();const refs=[...prompt.matchAll(/@([A-Za-z0-9_-]+)/g)].map(m=>m[1]);prompt=prompt.replace(/@([A-Za-z0-9_-]+)/g,'').trim();return {prompt,names,refs};}
  async function dataUrlFromImage(src){try{const res=await fetch(src,{credentials:'include'});const blob=await res.blob();return await new Promise(resolve=>{const fr=new FileReader();fr.onload=()=>resolve(fr.result);fr.readAsDataURL(blob);});}catch(e){return null;}}
  async function captureGeneratedImage(before){
    const tiles=[...document.querySelectorAll('flow-image-tile')].filter(tile=>{const r=tile.getBoundingClientRect();return r.width>120&&r.height>120&&r.bottom>0;});
    const candidates=tiles.map(tile=>{const img=tile.querySelector('img.image, img');const mediaId=tile.getAttribute('data-media-id')||img?.getAttribute('data-media-id')||null;const title=tile.querySelector('.footer-title')?.textContent?.trim()||null;return {tile,img,mediaId,title};}).filter(x=>x.img);
    let picked=candidates.reverse().find(x=>!before.has(x.img.currentSrc||x.img.src))||candidates[0];
    if(!picked)return null;
    const src=picked.img.currentSrc||picked.img.src;return {src,dataUrl:await dataUrlFromImage(src),mediaId:picked.mediaId,title:picked.title};
  }
  async function uploadReferenceAsset(name){const asset=STATE.assets[name];if(!asset)return {ok:false,error:`Reference @${name} tidak ditemukan`};if(!asset.dataUrl)return {ok:false,error:`Asset #${name} belum memiliki data image`};const inputs=[...document.querySelectorAll('input[type=file]')];const input=inputs.find(i=>/image|png|jpg|jpeg|webp/i.test(i.accept||''))||inputs[0];if(!input)return {ok:false,error:'File input reference tidak ditemukan di Flow'};const blob=await (await fetch(asset.dataUrl)).blob();const file=new File([blob],`${name}.png`,{type:blob.type||'image/png'});const dt=new DataTransfer();dt.items.add(file);input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));input.dispatchEvent(new Event('input',{bubbles:true}));return {ok:true};}
  async function saveGeneratedAsset(item,captured){const names=parsePrompt(item.text).names;if(!names.length||!captured)return;for(const name of names){STATE.assets[name]={name,src:captured.src,dataUrl:captured.dataUrl,mediaId:captured.mediaId||null,title:captured.title||name,createdAt:Date.now()};log(`[Item ${item.id+1}] ✓ Saved asset #${name}`);}chrome.storage.local.set({faAssets:STATE.assets});if(STATE.autoDownload&&captured.src){const r=await chrome.runtime.sendMessage({type:'FA_DOWNLOAD_URL',url:captured.src,filename:`${names[0].replace(/[^A-Za-z0-9_-]/g,'_')}.png`});log(r?.ok?`[Item ${item.id+1}] ✓ Auto download OK`:`[Item ${item.id+1}] ✗ Auto download gagal`);}}
  async function retryItem(item){if(!item)return;if(STATE.running){log('Batch sedang berjalan; retry manual dilewati');return;}STATE.running=true;log(`[Item ${item.id+1}] Retry`);await generateOne(item);STATE.running=false;render();}
  async function generateOne(item){item.status='generating';render();const parsed=parsePrompt(item.text);for(const ref of parsed.refs){const rr=await uploadReferenceAsset(ref);if(!rr.ok){log(`[Item ${item.id+1}] ✗ ${rr.error}`);item.status='failed';render();return false;}log(`[Item ${item.id+1}] ✓ Reference @${ref} loaded`);}const before=new Set([...document.querySelectorAll('img')].map(i=>i.currentSrc||i.src));const target=await pickTargetScope();if(!target){log(`[Item ${item.id+1}] ✗ Input Flow tidak ditemukan`);item.status='failed';render();return false;}if(target.win===null){const input=findBestInput(document);const ok=fillInputRobust(input,parsed.prompt);log(ok?`[Item ${item.id+1}] ✓ Prompt terisi`:`[Item ${item.id+1}] ✗ Gagal isi prompt`);await new Promise(r=>setTimeout(r,800));const genBtn=findBestGenButton(document);const res=genBtn&&!genBtn.disabled?await trustedClickEl(genBtn):await trustedEnter();log(res?.ok?`[Item ${item.id+1}] ✓ Generate triggered`:`[Item ${item.id+1}] ✗ Generate trigger gagal`);}else{const res=await requestFrame(target.win,{type:'FA_FILL_AND_CLICK_REQ',text:parsed.prompt},3000);(res?.log||[]).forEach(l=>log('[iframe] '+l));}let waited=0,captured=null;while(waited<90000&&STATE.running){await new Promise(r=>setTimeout(r,2000));waited+=2000;captured=await captureGeneratedImage(before);if(captured){log(`[Item ${item.id+1}] ✓ Image detected after ${waited/1000}s`);break;}}if(captured){await saveGeneratedAsset(item,captured);item.status='done';render();return true;}item.status='failed';render();log(`[Item ${item.id+1}] ✗ Timeout — klik ↻ untuk generate ulang`);return false;}

  async function start(){if(STATE.running){log('Already running');return;}if(!STATE.queue.length){log('Load prompts dulu');return;}STATE.running=true;log(`Start ${STATE.queue.length} prompts · Auto Download: ${STATE.autoDownload?'ON':'OFF'}`);for(const item of STATE.queue){if(!STATE.running)break;if(item.status==='done')continue;await generateOne(item);if(STATE.running && STATE.delay>0){log(`Jeda ${STATE.delay}s sebelum item berikutnya`);await new Promise(r=>setTimeout(r,STATE.delay*1000));}}STATE.running=false;log('Batch selesai / stopped');render();}

  ensureRoot();
  render();
  setInterval(()=>{
    if(location.href!==document.__lastHref){ document.__lastHref=location.href; render(); }
    if(!document.getElementById('flow-auto-root')){ ensureRoot(); render(); }
    if(Math.random()<0.15) updateDebug();
  }, 1500);
})();
