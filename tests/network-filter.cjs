const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
  try {
    const page = await browser.newPage();
    const comment = (uid, rpid, message = '普通评论', replies = []) => ({ rpid, member: { mid: uid, uname: '某人的大肥鱼' }, content: { message }, rcount: replies.length + 10, replies });
    const payload = { code: 0, data: {
      replies: [comment('123', '1', '本鱼来了', [comment('456', '11'), comment('789', '12')]), comment('456', '2'), comment('9007199254740993', '3')],
      top_replies: [comment('456', '4')], top: { upper: comment('456', '5'), admin: comment('789', '6') },
      cursor: { next: 42, is_end: false }, page: { count: 100, num: 1 }
    } };
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'www.bilibili.com') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' });
      const variant = url.searchParams.get('case');
      if (variant === 'abort') return route.abort('failed');
      const data = variant === 'business-error' ? { ...payload, code: -400 } : variant === 'invalid-mid' ? { code: 0, data: { replies: [comment(9007199254740992, '7'), comment(456, '8')] } } : payload;
      return route.fulfill({ status: variant === 'http-error' ? 503 : 200,
        headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', etag: 'original' },
        body: variant === 'broken' ? '{broken' : JSON.stringify(data) });
    });
    let source = fs.readFileSync(path.join(__dirname, '..', 'bilibili-deepseek-comment-blocker.user.js'), 'utf8');
    source = source.replace('  scan();\n  // 兜底', '  window.__networkTest = { filterPayload, replyEndpoint, save, defaults: DEFAULTS, network };\n  scan();\n  // 兜底');
    await page.addInitScript(() => {
      window.GM_getValue = (_, defaults) => ({ ...defaults, blockedUIDs: ['456', '9007199254740993'] });
      window.GM_setValue = () => {};
      window.GM_registerMenuCommand = () => {};
    });
    await page.addInitScript({ content: source });
    await page.goto('https://www.bilibili.com/video/test');
    const checks = await page.evaluate(async () => {
      const t = __networkTest;
      const result = [];
      const check = (name, ok) => result.push([name, !!ok]);
      const endpoint = 'https://api.bilibili.com/x/v2/reply/wbi/main';
      const config = { ...t.defaults, blockedUIDs: ['456', '9007199254740993'] };
      const get = async suffix => (await fetch(endpoint + suffix)).json();
      const xhr = (url, responseType = '', existing = new XMLHttpRequest()) => new Promise((resolve, reject) => {
        // 故意先注册 load，确保页面提前注册的监听器也只能读取过滤后的数据。
        existing.onload = () => {
          try {
            const value = responseType === 'json' ? existing.response : JSON.parse(existing.responseText);
            resolve({ value, request: existing, same: existing.response === existing.response,
              textMatches: responseType === 'json' || existing.response === existing.responseText });
          } catch (e) { reject(e); }
        };
        existing.onerror = reject;
        existing.open('GET', url); existing.responseType = responseType; existing.send();
      });
      const response = await fetch(endpoint);
      const data = await response.json();
      check('fetch removes blacklisted roots', data.data.replies.length === 1 && data.data.replies[0].rpid === '1');
      check('fetch removes only blacklisted child', data.data.replies[0].replies.length === 1 && data.data.replies[0].replies[0].member.mid === '789');
      check('text signals stay in response', data.data.replies[0].content.message === '本鱼来了');
      check('blacklisted pinned comments removed', data.data.top_replies.length === 0 && data.data.top.upper === null && data.data.top.admin.member.mid === '789');
      check('cursor and server counts retained', data.data.cursor.next === 42 && !data.data.cursor.is_end && data.data.page.count === 100 && data.data.replies[0].rcount === 12);
      check('fetch metadata and stale headers', response.url === endpoint && response.status === 200 && !response.headers.has('etag'));
      const urlResponse = await fetch(new URL(endpoint));
      check('URL object input filtered', (await urlResponse.json()).data.replies.length === 1);
      const requestResponse = await fetch(new Request(endpoint));
      const cloned = requestResponse.clone();
      check('Request input and cloned metadata retained', cloned.url === endpoint && (await cloned.json()).data.replies.length === 1 && (await requestResponse.json()).data.replies.length === 1);
      const post = await fetch(endpoint, { method: 'POST' });
      check('POST untouched', (await post.json()).data.replies.length === 3);
      const other = await fetch('https://api.bilibili.com/x/v2/reply/action');
      check('unrelated endpoint untouched', (await other.json()).data.replies.length === 3);
      const spoof = await fetch('https://example.com/x/v2/reply/wbi/main');
      check('other host untouched', (await spoof.json()).data.replies.length === 3);
      check('unknown endpoint variant untouched', !t.replyEndpoint(endpoint + '/extra'));
      check('business failure untouched', (await get('?case=business-error')).data.replies.length === 3);
      const httpError = await fetch(endpoint + '?case=http-error');
      check('HTTP failure untouched', httpError.status === 503 && (await httpError.json()).data.replies.length === 3);
      const broken = await fetch(endpoint + '?case=broken');
      check('malformed JSON untouched', await broken.text() === '{broken');
      let failed = false;
      try { await fetch(endpoint + '?case=abort'); } catch { failed = true; }
      check('network rejection propagated', failed);
      const unsafe = await get('?case=invalid-mid');
      check('unsafe numeric UID retained, safe numeric UID blocked', unsafe.data.replies.length === 1 && unsafe.data.replies[0].rpid === '7');
      t.save({ ...config, allowedUIDs: ['456'] });
      check('allowlist wins in response', (await get('')).data.replies.some(r => r.member.mid === '456'));
      t.save({ ...config, mode: 'observe' });
      check('observe mode does not delete', (await get('')).data.replies.length === 3);
      t.save({ ...config, enabled: false });
      check('pause does not delete', (await get('')).data.replies.length === 3);
      t.save(config);
      const text = await xhr(endpoint);
      check('XHR text filtered before early load listener', text.value.data.replies.length === 1 && text.textMatches);
      const beforeJson = t.network.responses;
      const json = await xhr('https://api.bilibili.com/x/v2/reply/reply', 'json');
      check('XHR json filtered and stable', json.value.data.replies.length === 1 && json.same);
      check('repeated XHR reads counted once', t.network.responses === beforeJson + 1);
      let nativeError = false;
      try { void json.request.responseText; } catch (e) { nativeError = e.name === 'InvalidStateError'; }
      check('XHR json responseText keeps native error', nativeError);
      const reused = await xhr('https://api.bilibili.com/unrelated', '', text.request);
      check('reused XHR skips unrelated request', reused.value.data.replies.length === 3);
      const reusedAgain = await xhr(endpoint, 'text', text.request);
      check('reused XHR filters next comment response', reusedAgain.value.data.replies.length === 1);
      const binary = await new Promise((resolve, reject) => {
        const req = new XMLHttpRequest(); req.onload = () => resolve(req.response); req.onerror = reject;
        req.open('GET', endpoint); req.responseType = 'arraybuffer'; req.send();
      });
      check('XHR binary response unchanged', JSON.parse(new TextDecoder().decode(binary)).data.replies.length === 3);
      t.save({ ...config, enabled: false });
      check('pause applies to subsequent XHR', (await xhr(endpoint, 'json')).value.data.replies.length === 3);
      t.save({ ...config, blockedUIDs: ['123', '456', '789', '9007199254740993'] });
      const empty = await get('');
      check('all hidden page keeps server cursor', empty.data.replies.length === 0 && !empty.data.cursor.is_end && empty.data.cursor.next === 42);
      t.save(config);
      const earlierFetch = window.fetch;
      check('hooks installed', t.network.fetch && t.network.xhr && typeof earlierFetch === 'function');
      check('network counters recorded', t.network.responses > 0 && t.network.removed > 0);
      return result;
    });
    for (const [name, ok] of checks) { console.log((ok ? 'PASS ' : 'FAIL ') + name); assert(ok, name); }
    console.log(checks.length + ' response-layer checks passed; intercepted local fixtures only.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
