export const UI_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodeRefiner</title>
<style>
:root{--bg:#fff;--fg:#1c1e21;--muted:#6b7280;--card:#f7f8fa;--line:#d9dde3;--accent:#2457d6;--accent-fg:#fff;--bad:#b42318;--ok:#16794a}
@media (prefers-color-scheme:dark){:root{--bg:#14161a;--fg:#e6e8eb;--muted:#9aa3ad;--card:#1d2026;--line:#333844;--accent:#6f98ff;--accent-fg:#0b1020;--bad:#ff7b72;--ok:#4cc38a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;justify-content:center}
main{width:100%;max-width:560px;padding:40px 16px 64px}h1{font-size:28px;margin:0 0 24px;letter-spacing:-.01em}
#drop{border:2px dashed var(--line);border-radius:14px;padding:44px 16px;text-align:center;background:var(--card);cursor:pointer;transition:border-color .15s,background .15s}
#drop.over{border-color:var(--accent)}#drop b{display:block;font-size:17px;margin-bottom:4px}#drop span{color:var(--muted);font-size:14px}
#picked{margin-top:10px;color:var(--muted);font-size:14px;min-height:21px;word-break:break-all}
fieldset{border:0;padding:0;margin:22px 0 0}legend{font-weight:600;margin-bottom:6px;padding:0}
label{display:flex;gap:8px;align-items:flex-start;padding:5px 0;cursor:pointer}label small{color:var(--muted);display:block}
button{font:inherit;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--fg);padding:10px 16px;cursor:pointer}
button.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent);font-weight:600;width:100%;margin-top:26px;padding:13px}
button:disabled{opacity:.5;cursor:default}#result{margin-top:30px;display:none}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;text-align:center}
.stat b{display:block;font-size:26px}.stat span{color:var(--muted);font-size:13px}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.actions>*{flex:1 1 140px;text-align:center;text-decoration:none}
a.btn{font:inherit;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--fg);padding:10px 16px}
#msg{margin-top:14px;font-size:14px;color:var(--muted)}#msg.err{color:var(--bad)}#where{margin-top:12px;color:var(--muted);font-size:13px;word-break:break-all}
</style></head><body><main>
<h1>CodeRefiner</h1>
<div id="drop" tabindex="0" role="button" aria-label="Choose a ZIP file or folder"><b>Drop a ZIP or folder here</b><span>or click to choose a ZIP file · <a href="#" id="pickFolder">choose a folder</a></span></div>
<input type="file" id="fileInput" accept=".zip,application/zip" hidden>
<input type="file" id="folderInput" webkitdirectory multiple hidden>
<div id="picked"></div>
<fieldset><legend>Mode</legend>
<label><input type="radio" name="mode" value="safe" checked><span>Safe<small>Only changes that cannot alter behaviour</small></span></label>
<label><input type="radio" name="mode" value="cautious"><span>Cautious<small>Also applies well-supported inferences</small></span></label>
<label><input type="radio" name="mode" value="aggressive"><span>Aggressive<small>Structural refactorings</small></span></label>
</fieldset>
<fieldset><legend>AI</legend><label><input type="checkbox" id="ai"><span>Enable AI Advisor<small>Optional. Needs ANTHROPIC_API_KEY on the machine running CodeRefiner.</small></span></label></fieldset>
<button class="primary" id="go" disabled>REFINE</button>
<div id="msg" role="status"></div>
<section id="result">
<div class="stats"><div class="stat"><b id="sFiles">0</b><span>Files</span></div><div class="stat"><b id="sChanged">0</b><span>Changed</span></div><div class="stat"><b id="sWarn">0</b><span>Warnings</span></div></div>
<div class="actions"><a class="btn" id="report" target="_blank" rel="noopener">View Report</a><button id="open">Open Refined Folder</button><a class="btn" id="zip" download>Export ZIP</a></div>
<div id="where"></div>
</section>
<script>
(function(){
var picked=null,pickedName='';
var $=function(id){return document.getElementById(id)};
var drop=$('drop'),msg=$('msg'),go=$('go');
function say(t,err){msg.textContent=t||'';msg.className=err?'err':''}
function setPicked(blob,name,label){picked=blob;pickedName=name;$('picked').textContent=label;go.disabled=!blob;say('')}
// ---- minimal ZIP writer (STORE) so folders can be sent as one upload ----
var T=(function(){var t=[],c,n,k;for(n=0;n<256;n++){c=n;for(k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[n]=c>>>0}return t})();
function crc(b){var c=0xFFFFFFFF;for(var i=0;i<b.length;i++)c=T[(c^b[i])&255]^(c>>>8);return(c^0xFFFFFFFF)>>>0}
function zipStore(entries){var enc=new TextEncoder(),parts=[],central=[],offset=0;
 entries.forEach(function(e){var name=enc.encode(e.name),data=e.data,c=crc(data);
  var h=new DataView(new ArrayBuffer(30));h.setUint32(0,0x04034b50,true);h.setUint16(4,20,true);h.setUint16(6,0x0800,true);h.setUint16(8,0,true);h.setUint32(14,c,true);h.setUint32(18,data.length,true);h.setUint32(22,data.length,true);h.setUint16(26,name.length,true);
  parts.push(h.buffer,name,data);
  var ch=new DataView(new ArrayBuffer(46));ch.setUint32(0,0x02014b50,true);ch.setUint16(4,20,true);ch.setUint16(6,20,true);ch.setUint16(8,0x0800,true);ch.setUint32(16,c,true);ch.setUint32(20,data.length,true);ch.setUint32(24,data.length,true);ch.setUint16(28,name.length,true);ch.setUint32(42,offset,true);
  central.push(ch.buffer,name);offset+=30+name.length+data.length});
 var csize=0;central.forEach(function(p){csize+=p.byteLength||p.length});
 var end=new DataView(new ArrayBuffer(22));end.setUint32(0,0x06054b50,true);end.setUint16(8,entries.length,true);end.setUint16(10,entries.length,true);end.setUint32(12,csize,true);end.setUint32(16,offset,true);
 return new Blob(parts.concat(central,[end.buffer]),{type:'application/zip'})}
function readEntry(entry,prefix,out){return new Promise(function(res){
 if(entry.isFile){entry.file(function(f){f.arrayBuffer().then(function(b){out.push({name:prefix+entry.name,data:new Uint8Array(b)});res()})},function(){res()})}
 else if(entry.isDirectory){var r=entry.createReader(),all=[];(function more(){r.readEntries(function(list){if(!list.length){Promise.all(all.map(function(e){return readEntry(e,prefix+entry.name+'/',out)})).then(res);return}all=all.concat([].slice.call(list));more()},function(){res()})})()}
 else res()})}
function fromFolderEntry(entry){var out=[];return readEntry(entry,'',out).then(function(){return zipStore(out)})}
function fromFileList(files){var out=[],jobs=[].map.call(files,function(f){return f.arrayBuffer().then(function(b){out.push({name:f.webkitRelativePath||f.name,data:new Uint8Array(b)})})});return Promise.all(jobs).then(function(){return zipStore(out)})}
drop.addEventListener('click',function(e){if(e.target.id==='pickFolder')return;$('fileInput').click()});
drop.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();$('fileInput').click()}});
$('pickFolder').addEventListener('click',function(e){e.preventDefault();e.stopPropagation();$('folderInput').click()});
$('fileInput').addEventListener('change',function(e){var f=e.target.files[0];if(f)setPicked(f,f.name.replace(/\\.zip$/i,''),f.name+' ('+Math.round(f.size/1024)+' KB)')});
$('folderInput').addEventListener('change',function(e){var fs=e.target.files;if(!fs.length)return;say('Reading folder…');var root=(fs[0].webkitRelativePath||'').split('/')[0]||'project';fromFileList(fs).then(function(z){setPicked(z,root,root+'/ ('+fs.length+' files)')})});
['dragenter','dragover'].forEach(function(n){drop.addEventListener(n,function(e){e.preventDefault();drop.classList.add('over')})});
['dragleave','drop'].forEach(function(n){drop.addEventListener(n,function(e){e.preventDefault();drop.classList.remove('over')})});
drop.addEventListener('drop',function(e){var item=e.dataTransfer.items&&e.dataTransfer.items[0];var entry=item&&item.webkitGetAsEntry&&item.webkitGetAsEntry();
 if(entry&&entry.isDirectory){say('Reading folder…');fromFolderEntry(entry).then(function(z){setPicked(z,entry.name,entry.name+'/ (folder)')});return}
 var f=e.dataTransfer.files[0];if(f&&/\\.zip$/i.test(f.name))setPicked(f,f.name.replace(/\\.zip$/i,''),f.name+' ('+Math.round(f.size/1024)+' KB)');else say('Please drop a .zip file or a folder.',true)});
var last=null;
go.addEventListener('click',function(){if(!picked)return;go.disabled=true;$('result').style.display='none';say('Refining…');
 var mode=document.querySelector('input[name=mode]:checked').value,ai=$('ai').checked?1:0;
 fetch('/api/refine?mode='+mode+'&ai='+ai+'&name='+encodeURIComponent(pickedName),{method:'POST',headers:{'X-CodeRefiner':'1','Content-Type':'application/zip'},body:picked})
 .then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'Failed');return j})})
 .then(function(j){last=j;$('sFiles').textContent=j.files;$('sChanged').textContent=j.changed;$('sWarn').textContent=j.warnings;
  $('report').href='/out/'+j.id+'/report.html';$('zip').href='/out/'+j.id+'/refined-project.zip';$('where').textContent=j.refinedDir;
  $('result').style.display='block';say(j.aiNote||'')})
 .catch(function(e){say(e.message,true)}).then(function(){go.disabled=false})});
$('open').addEventListener('click',function(){if(!last)return;fetch('/api/open?id='+last.id,{method:'POST',headers:{'X-CodeRefiner':'1'}}).then(function(r){if(!r.ok)say('Could not open the folder. It is at: '+last.refinedDir,true)})});
})();
</script></main></body></html>`;
