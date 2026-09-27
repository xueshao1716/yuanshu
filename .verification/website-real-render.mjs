import fs from 'node:fs';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const browser=await chromium.launch({headless:true});
const files=process.argv.slice(2);
try {
  for(const file of files){
    for(const [device,width,height] of [['desktop',1440,1050],['mobile',390,844]]){
      const page=await browser.newPage({viewport:{width,height}}),errors=[];
      page.on('pageerror',e=>errors.push(e.message));
      await page.setContent(fs.readFileSync(file,'utf8'));
      await page.evaluate(()=>document.fonts.ready);
      const facts=await page.evaluate(()=>({
        sections:[...document.querySelectorAll('[id^=site-section-]')].map(s=>({id:s.id,text:s.textContent.trim().length,height:s.getBoundingClientRect().height,background:getComputedStyle(s).backgroundColor})),
        headings:document.querySelectorAll('h1,h2,h3').length,
        width:innerWidth,scrollWidth:document.documentElement.scrollWidth,
        overflowElements:[...document.body.querySelectorAll('*')].filter(e=>e.getBoundingClientRect().right>innerWidth+1||e.getBoundingClientRect().left < -1).map(e=>({id:e.id,tag:e.tagName,left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right})).slice(0,8),
        imageFailures:[...document.images].filter(i=>!i.complete||!i.naturalWidth).length,
      }));
      console.log(JSON.stringify({file,device,...facts,errors}));
      assert.equal(facts.sections.length,2);
      assert.ok(facts.sections.every(s=>s.text>10&&s.height>100));
      assert.ok(facts.headings>=2);
      assert.ok(facts.scrollWidth<=width+1,`${device} overflow`);
      assert.equal(facts.imageFailures,0);assert.deepEqual(errors,[]);
      await page.screenshot({path:file.replace('.html',`-${device}.png`),fullPage:true});
      await page.close();
    }
  }
}finally{await browser.close();}
