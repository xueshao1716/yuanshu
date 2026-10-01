// Focused verification uses the same isolated environment as the full suite.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {verificationEnvironment} from './verification-runner.mjs';
const root=path.resolve(import.meta.dirname,'..');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'yuanshu-causal-learning-'));
const tests=fs.readdirSync(path.join(root,'tests/unit')).filter(name=>
  /^(cultivation-|knowledge-|aibody-causal-)/.test(name)&&name.endsWith('.test.mjs'));
const result=spawnSync(process.execPath,['--import',pathToFileURL(path.join(root,'scripts/verification-preload.mjs')).href,
  '--test','--test-concurrency=1',...tests.map(name=>`tests/unit/${name}`)],
  {cwd:root,env:verificationEnvironment(temp),stdio:'inherit',windowsHide:true,timeout:300000});
if(result.error)console.error(result.error.code);
console.log(`Isolated verification workspace: ${temp}`);
process.exitCode=result.status===0&&!result.error?0:1;
