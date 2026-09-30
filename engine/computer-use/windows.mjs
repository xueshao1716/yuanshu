import { spawn as spawnProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Public Windows UI Automation only. No Codex runtime, keys, browser profile or helper.
export function createWindowsAdapter({platform=process.platform,spawn=spawnProcess}={}) {
  const supported=platform==='win32';
  const script=fileURLToPath(new URL('./windows-uia.ps1',import.meta.url));
  const executable=path.join(process.env.SystemRoot || 'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const call=(body,{signal}={})=>new Promise((resolve,reject)=>{
    if(!supported) return reject(new Error('当前适配器只支持 Windows'));
    if(signal?.aborted) return reject(new Error('操作已取消'));
    let child, output='', errors='', finished=false;
    const done=(error,result)=>{
      if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
      error?reject(error):resolve(result);
    };
    const abort=()=>{done(new Error('操作已取消，结果请人工核对'));child?.kill();};
    const timer=setTimeout(()=>{done(new Error('Windows 控件响应超时，请人工核对后重试观察'));child?.kill();},12000);
    try {
      child=spawn(executable,['-NoProfile','-NonInteractive','-File',script],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
      signal?.addEventListener('abort',abort,{once:true});
      child.on('error',e=>done(e));
      child.stdin.on('error',e=>done(e));
      child.stdout.on('data',chunk=>{output+=chunk; if(output.length>256000){done(new Error('Windows 控件响应过大'));child.kill();}});
      child.stderr.on('data',chunk=>{if(errors.length<4000)errors+=chunk;});
      child.on('close',code=>{
        if(finished)return;
        try {const result=JSON.parse(output.replace(/^\uFEFF/,''));if(code || result.error)throw new Error(result.error || 'Windows 控件操作失败');done(null,result);}
        catch(e){done(new Error(e instanceof SyntaxError?'Windows 控件响应不可解析':e.message));}
      });
      child.stdin.end(JSON.stringify(body));
    } catch(e){done(e);child?.kill();}
  });
  return {supported,windows:async()=> (await call({mode:'windows'})).windows,
    observe:(window,opts)=>call({mode:'observe',window},opts),
    act:(args,opts)=>call({mode:'act',...args},opts)};
}
