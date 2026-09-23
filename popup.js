const dl=document.getElementById('dl');
function refresh(){chrome.storage.local.get({faAutoDownload:false},s=>{dl.textContent=s.faAutoDownload?'ON':'OFF';dl.className='pill '+(s.faAutoDownload?'on':'off');});}
dl.addEventListener('click',()=>chrome.storage.local.set({faAutoDownload:!dl.classList.contains('on')},refresh));
document.getElementById('openSetup').addEventListener('click',()=>chrome.tabs.create({url:chrome.runtime.getURL('setup.html')}));
document.getElementById('openFlow').addEventListener('click',()=>chrome.tabs.create({url:'https://flow.google.com/'}));
document.getElementById('reload').addEventListener('click',()=>chrome.tabs.query({active:true,currentWindow:true},t=>{if(t[0])chrome.tabs.reload(t[0].id);}));
refresh();
