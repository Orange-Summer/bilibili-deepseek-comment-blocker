const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({headless:true, ...(process.env.BROWSER_CHANNEL ? {channel:process.env.BROWSER_CHANNEL} : {})});
  try {
    const page = await browser.newPage();
    await page.setContent('<bili-comments></bili-comments>');
    await page.evaluate(() => {
      window.GM_getValue = (_, fallback) => ({ ...fallback, allowedUIDs: ['456'] });
      window.GM_setValue = (_, value) => { window.__savedConfig = value; };
      window.GM_registerMenuCommand = () => {};
      const container = document.querySelector('bili-comments').attachShadow({mode:'open'});
      const thread = document.createElement('bili-comment-thread-renderer');
      container.append(thread);
      const threadRoot = thread.attachShadow({mode:'open'});
      window.makeItem = (uid, name, text, parent = threadRoot, type = 'bili-comment-renderer') => {
        const item = document.createElement(type); parent.append(item);
        const root = item.attachShadow({mode:'open'});
        const author = document.createElement('bili-comment-user-info'); root.append(author);
        const ar = author.attachShadow({mode:'open'});
        const a = document.createElement('a'); a.id='user-name'; a.href='https://space.bilibili.com/'+uid; a.textContent=name; ar.append(a);
        const rich = document.createElement('bili-rich-text'); root.append(rich);
        const rr = rich.attachShadow({mode:'open'});
        const contents = document.createElement('div'); contents.id='contents'; contents.textContent=text; rr.append(contents);
        return item;
      };
      window.normal = makeItem('123', '鱼丸', '回复 @鲸鱼: @朋友 这个视频不错——真的！');
      window.suspect = makeItem('456', '某人的大肥鱼', '本鱼也这么觉得');
      window.reply = makeItem('789', '真人', '我是正常楼中楼', threadRoot, 'bili-comment-reply-renderer');
    });
    let source = fs.readFileSync(path.join(__dirname, '..', 'bilibili-deepseek-comment-blocker.user.js'),'utf8');
    source = source.replace('  scan();\n  // 兜底', '  window.__test = { classify, validate, read, scan, save, defaults: DEFAULTS };\n  scan();\n  // 兜底');
    await page.addScriptTag({content:source});
    const results = await page.evaluate(async () => {
      const t = __test, c = t.defaults;
      const result = [];
      const check = (name, ok) => result.push([name,!!ok]);
      check('normal @, punctuation and fish name retained', !normal.hasAttribute('data-baf-fold'));
      check('combined persona signals folded', suspect.hasAttribute('data-baf-fold'));
      check('reply retained when root folded', !reply.hasAttribute('data-baf-fold') && reply.isConnected);
      check('author UID and name read from shadow', t.read(suspect).uid==='456' && t.read(suspect).name==='某人的大肥鱼');
      const record = {uid:'456',name:'某人的大肥鱼',text:'本鱼来了'};
      check('legacy exemptions do not bypass blacklist', t.classify(record,{...c,blockedUIDs:['456'],allowedUIDs:['456']}).fold);
      check('legacy fields stripped on import', !Object.hasOwn(t.validate({...c,allowedUIDs:['456']}),'allowedUIDs'));
      check('legacy fields cleared from stored config', window.__savedConfig && !Object.hasOwn(window.__savedConfig,'allowedUIDs'));
      check('trust button removed', ![...suspect.shadowRoot.querySelectorAll('button')].some(b=>b.textContent.includes('信任')));
      check('observe does not fold blacklist', !t.classify(record,{...c,mode:'observe',blockedUIDs:['456']}).fold);
      check('nickname alone only marks', !t.classify({...record,text:'普通内容'}).fold);
      check('strict folds weak signal', t.classify({...record,text:'普通内容'},{...c,mode:'strict'}).fold);
      check('disabled retains all', !t.classify(record,{...c,enabled:false,blockedUIDs:['456']}).fold);
      check('reply prefix does not trigger phrase', !t.classify({uid:'123',name:'真人',text:'回复 @本鱼: 好的'},{...c,blockedPhrases:['本鱼']}).fold);
      check('custom phrase normalized', t.classify({uid:'123',name:'真人',text:'ＡＢＣ'},{...c,blockedPhrases:['abc']}).fold);
      let invalid=false; try { t.validate({...c,blockedUIDs:[123]}); } catch(e) {invalid=true;}
      check('numeric UID rejected',invalid);
      const toggle = [...suspect.shadowRoot.querySelectorAll('button')].find(b=>b.textContent==='展开原文');
      toggle.click(); t.scan();
      check('expand original', !suspect.hasAttribute('data-baf-fold'));
      t.save({...c,blockedUIDs:['123']}); t.scan();
      check('blacklist re-evaluates loaded comments', normal.hasAttribute('data-baf-fold'));
      t.save({...c,enabled:false}); t.scan();
      check('pause restores loaded comments', !normal.hasAttribute('data-baf-fold') && !suspect.hasAttribute('data-baf-fold'));
      t.save(c); t.scan();
      const label = suspect.shadowRoot.querySelector('[data-baf-ui]');
      await new Promise(r=>setTimeout(r,800));
      check('observer render converges', label === suspect.shadowRoot.querySelector('[data-baf-ui]'));
      return result;
    });
    for (const [name, ok] of results) { console.log((ok?'PASS ':'FAIL ')+name); assert(ok,name); }
    console.log(results.length+' checks passed; synthetic DOM only.');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
