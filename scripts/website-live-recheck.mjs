// Offline recheck of a completed live run. Never makes model calls or rewrites its report/project.
// node scripts/website-live-recheck.mjs isolated-live-workspace
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseHTML} from 'linkedom';
import {assertOutsideSelectionUnchanged} from './website-edit-acceptance.mjs';
import {selectedHtml,exportWebsite} from '../engine/website-document.mjs';

const root=path.resolve(process.argv[2]||'');
assert.ok(path.basename(root).startsWith('yuanshu-website-live-'),'Use an isolated live-check workspace');
const reportFile=path.join(root,'report.json'),reportBytes=fs.readFileSync(reportFile);
const original=JSON.parse(reportBytes);
assert.equal(original.generation.status,'completed');
assert.equal(original.edit.status,'completed');
assert.equal(original.sourceUnchanged,true);
const dir=path.join(root,'workshop-out','website-projects');
const files=fs.readdirSync(dir).filter(f=>/^[a-f0-9-]{36}\.json$/.test(f));
assert.equal(files.length,1);
const file=path.join(dir,files[0]),bytes=fs.readFileSync(file),project=JSON.parse(bytes);
const edited=project.versions.find(v=>v.id===project.run.resultVersion);
const generated=project.versions.find(v=>v.id===project.run.request.baseVersion);
assert.ok(edited&&generated,'Completed edit and its base version are required');
assert.equal(project.selectedVersion,generated.id,'Original canvas must not be auto-adopted');
const target=project.run.request.targetId;
assertOutsideSelectionUnchanged(generated.doc,edited.doc,target);
const element=doc=>parseHTML(`<html><body>${selectedHtml(doc,target)}</body></html>`).document.body.firstElementChild;
const before=element(generated.doc),after=element(edited.doc);
assert.equal(after.style.getPropertyValue('border-top').replace(/\s+/g,' ').trim(),'4px solid #d35400');
assert.notEqual(after.outerHTML,before.outerHTML);
assert.equal(after.innerHTML,before.innerHTML);
const attrs=el=>Object.fromEntries([...el.attributes].filter(a=>a.name!=='style').map(a=>[a.name,a.value]));
assert.deepEqual(attrs(after),attrs(before));
const styles=el=>Object.fromEntries(Array.from({length:el.style.length},(_,i)=>el.style[i])
  .filter(key=>key!=='border-top').map(key=>[key,el.style.getPropertyValue(key)]));
assert.deepEqual(styles(after),styles(before));
const delivery=exportWebsite(edited.doc,project.title);
assert.ok(delivery.startsWith('<!doctype html>'));
fs.writeFileSync(path.join(root,'delivery-rechecked.html'),delivery,{flag:'wx'});
assert.deepEqual(fs.readFileSync(file),bytes);
assert.deepEqual(fs.readFileSync(reportFile),reportBytes);
const report={passed:true,mode:'offline-recheck-no-model-calls',checkedAt:new Date().toISOString(),
  originalReportPassed:original.passed,originalReportSha256:createHash('sha256').update(reportBytes).digest('hex'),
  projectUnchanged:true,outsideSelectionUnchanged:true,exactRequestedChange:true,exportBytes:Buffer.byteLength(delivery),
  generatedVersion:generated.id,editedVersion:edited.id,actualModel:project.run.actualModel,
  note:'Initial string-replacement assertion mishandled sanitized void elements; original failed report retained.'};
fs.writeFileSync(path.join(root,'recheck-report.json'),JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify(report,null,2));
