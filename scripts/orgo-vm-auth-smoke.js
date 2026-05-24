#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ORGO_VM_ID = process.env.ORGO_VM_ID || '3ec3d7f3-a5da-4678-8b25-ce28b7aed829';
const ROOT = path.resolve(__dirname, '..');
const LIVE_ROOT = process.env.CORTEXTOS_ROOT || (
  fs.existsSync('/home/cortextos/cortextos/orgs/revops-global/secrets.env')
    ? '/home/cortextos/cortextos'
    : ROOT
);
const LOCAL_BASE = path.join(LIVE_ROOT, 'orgs', 'revops-global', 'secrets');
const LOCAL_ENC = path.join(LOCAL_BASE, 'orgo-vm-sessions.json.enc');
const LOCAL_META = path.join(LOCAL_BASE, 'orgo-vm-sessions.meta.json');
const REMOTE_BASE = '/root/.config/cortextos/orgo-vm-auth';

function readEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}

readEnvFile(path.join(LIVE_ROOT, 'orgs', 'revops-global', 'secrets.env'));

function requireEnv(name) {
  if (!process.env[name]) throw new Error(`${name} is required`);
  return process.env[name];
}

async function orgoExec(code, timeout = 120) {
  const res = await fetch(`https://www.orgo.ai/api/computers/${ORGO_VM_ID}/exec`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${requireEnv('ORGO_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ code, timeout }),
  });
  if (!res.ok) throw new Error(`Orgo API ${res.status}: ${await res.text()}`);
  const payload = await res.json();
  if (!payload.success) {
    throw new Error(`Orgo exec failed: ${payload.output || payload.error || 'unknown error'}`);
  }
  return payload.output || '';
}

function b64(file) {
  return fs.readFileSync(file).toString('base64');
}

async function pushBundle() {
  if (!fs.existsSync(LOCAL_ENC)) throw new Error(`missing ${LOCAL_ENC}`);
  const metaB64 = fs.existsSync(LOCAL_META) ? b64(LOCAL_META) : '';
  const code = `
import base64, os, pathlib
base = pathlib.Path(${JSON.stringify(REMOTE_BASE)})
base.mkdir(parents=True, exist_ok=True)
(base / 'orgo-vm-sessions.json.enc').write_bytes(base64.b64decode(${JSON.stringify(b64(LOCAL_ENC))}))
os.chmod(base / 'orgo-vm-sessions.json.enc', 0o600)
if ${Boolean(metaB64) ? 'True' : 'False'}:
    (base / 'orgo-vm-sessions.meta.json').write_bytes(base64.b64decode(${JSON.stringify(metaB64)}))
    os.chmod(base / 'orgo-vm-sessions.meta.json', 0o600)
print('pushed')
`;
  return orgoExec(code, 30);
}

function remoteSmokeCode(secret) {
  const nodeScript = String.raw`
const fs=require('fs');
const crypto=require('crypto');
const {spawn}=require('child_process');
const WebSocket=require('/tmp/orgo-cdp-ws/node_modules/ws');
const base='/root/.config/cortextos/orgo-vm-auth';
const enc=JSON.parse(fs.readFileSync(base+'/orgo-vm-sessions.json.enc','utf8'));
const key=crypto.scryptSync(process.env.INTERNAL_CRON_SECRET, Buffer.from(enc.salt,'base64'), 32);
const decipher=crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(enc.iv,'base64'));
decipher.setAuthTag(Buffer.from(enc.tag,'base64'));
const state=JSON.parse(Buffer.concat([decipher.update(Buffer.from(enc.data,'base64')), decipher.final()]).toString('utf8'));
const userDataDir='/root/.config/chrome-orgo-auth-profile';
try { fs.rmSync(userDataDir,{recursive:true,force:true}); } catch {}
const chrome=spawn('/usr/bin/google-chrome',['--headless=new','--no-sandbox','--disable-gpu','--remote-debugging-port=9333',` + '`--user-data-dir=${userDataDir}`' + `,'about:blank'],{stdio:'ignore'});
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
async function jsonFetch(url, opts){const res=await fetch(url,opts); return res.json();}
async function waitCdp(){for(let i=0;i<50;i++){try{return await jsonFetch('http://127.0.0.1:9333/json/version')}catch{await sleep(200)}} throw new Error('cdp timeout')}
function cdp(wsUrl){let id=0; const ws=new WebSocket(wsUrl); const pending=new Map(); ws.on('message',m=>{const msg=JSON.parse(m); if(msg.id&&pending.has(msg.id)){const slot=pending.get(msg.id); pending.delete(msg.id); msg.error?slot.reject(new Error(JSON.stringify(msg.error))):slot.resolve(msg.result)}}); return new Promise((resolve,reject)=>{ws.on('open',()=>resolve({send(method,params={}){return new Promise((resolve,reject)=>{const mid=++id; pending.set(mid,{resolve,reject}); ws.send(JSON.stringify({id:mid,method,params}))})}, close(){ws.close()}})); ws.on('error',reject)})}
async function newPage(url){const target=await jsonFetch('http://127.0.0.1:9333/json/new?'+encodeURIComponent(url),{method:'PUT'}); const client=await cdp(target.webSocketDebuggerUrl); await client.send('Page.enable'); await client.send('Runtime.enable'); return client;}
async function evalExpr(client, expression){const r=await client.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true}); return r.result?.value;}
(async()=>{
 await waitCdp();
 const cookies=(state.storage_state.cookies||[]).filter(c=>c.domain && (c.domain.includes('revopsglobal.com') || c.domain.includes('google.com'))).map(c=>({name:c.name,value:c.value,domain:c.domain,path:c.path||'/',expires:c.expires&&c.expires>0?c.expires:undefined,httpOnly:!!c.httpOnly,secure:c.secure!==false,sameSite:c.sameSite||'Lax'}));
 const token=(state.storage_state.cookies||[]).find(c=>c.name==='orca_session')?.value || '';
 const orcaPage=await newPage('https://orca.revopsglobal.com');
 await orcaPage.send('Network.enable');
 await orcaPage.send('Network.setCookies',{cookies});
 await orcaPage.send('Page.navigate',{url:'https://orca.revopsglobal.com?session='+encodeURIComponent(token)});
 await sleep(4000);
 const orca=await evalExpr(orcaPage, ` + "`({url:location.href,title:document.title,text:document.body.innerText.slice(0,300),hasPin:/Unlock Orca|PIN/.test(document.body.innerText),hasShell:!!document.querySelector('.voice-shell')})`" + `);
 const hubPage=await newPage('https://hub.revopsglobal.com');
 await hubPage.send('Network.enable');
 await hubPage.send('Network.setCookies',{cookies});
 await hubPage.send('Page.navigate',{url:'https://hub.revopsglobal.com'});
 await sleep(5000);
 const hub=await evalExpr(hubPage, ` + "`({url:location.href,title:document.title,text:document.body.innerText.slice(0,300),needsAuth:/Sign in|Continue with Google|send link|auth/i.test(document.body.innerText)})`" + `);
 const report={created_at:new Date().toISOString(),injected_cookie_count:cookies.length,orca_restored:!!orca.hasShell&&!orca.hasPin,hub_restored:!hub.needsAuth&&!/auth/.test(hub.url),orca,hub};
 fs.writeFileSync(base+'/restore-smoke-report.json', JSON.stringify(report,null,2));
 fs.chmodSync(base+'/restore-smoke-report.json',0o600);
 console.log(JSON.stringify(report,null,2));
 chrome.kill('SIGTERM');
})().catch(e=>{console.error(e.stack||e); try{chrome.kill('SIGTERM')}catch{}; process.exit(1)});
`;
  return `
import os, pathlib, subprocess
os.environ['INTERNAL_CRON_SECRET'] = ${JSON.stringify(secret)}
base = pathlib.Path('/root/.config/cortextos/orgo-vm-auth')
script = base / 'restore-smoke.js'
script.write_text(${JSON.stringify(nodeScript)})
os.chmod(script, 0o700)
print(subprocess.check_output(['node', str(script)], env=os.environ, text=True, timeout=90))
`;
}

async function smoke() {
  await pushBundle();
  const output = await orgoExec(remoteSmokeCode(requireEnv('INTERNAL_CRON_SECRET')), 120);
  process.stdout.write(output);
}

(async () => {
  if (process.argv.includes('--push-only')) {
    process.stdout.write(await pushBundle());
    return;
  }
  await smoke();
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
