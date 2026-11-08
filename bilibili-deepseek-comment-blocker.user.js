// ==UserScript==
// @name         屏蔽 B站 DeepSeek AI 评论
// @namespace    local.bilibili.agent-filter
// @version      0.2.0
// @description  UID 黑名单从评论响应中拦截，其他规则在页面折叠；支持白名单和楼中楼。
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/bangumi/play/*
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-start
// @noframes
// @license      MIT
// ==/UserScript==

(() => {
  'use strict';
  const KEY = 'agent-filter-v1';
  const DEFAULTS = {
    enabled: true,
    mode: 'balanced', // observe: 只标记；balanced: 强规则折叠；strict: 弱规则也折叠
    blockedUIDs: [],
    allowedUIDs: [],
    blockedPhrases: [], // 用户明确指定的正文片段；不是 AI 身份证据
    personaRules: true
  };
  function validate(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('配置必须是对象');
    const c = { ...DEFAULTS, ...input };
    if (typeof c.enabled !== 'boolean' || typeof c.personaRules !== 'boolean') throw Error('开关必须是 true/false');
    if (!['observe', 'balanced', 'strict'].includes(c.mode)) throw Error('mode 应为 observe / balanced / strict');
    for (const key of ['blockedUIDs', 'allowedUIDs', 'blockedPhrases']) {
      if (!Array.isArray(c[key]) || c[key].length > 1000) throw Error(key + ' 必须是数组，最多 1000 项');
      c[key] = [...new Set(c[key].map(value => {
        if (typeof value !== 'string') throw Error(key + ' 中请使用字符串，UID 必须带引号');
        const s = value.trim();
        if (!s || s.length > 200 || (key !== 'blockedPhrases' && !/^[1-9]\d*$/.test(s))) throw Error(key + ' 含无效值');
        return s;
      }))];
    }
    return c;
  }
  let config;
  try { config = validate(GM_getValue(KEY, DEFAULTS)); }
  catch (e) { config = { ...DEFAULTS }; console.warn('[Agent过滤] 配置无效，使用默认值', e); }

  const normalize = s => String(s || '').normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  function classify({ uid, name, text }, c = config) {
    if (!c.enabled || (uid && c.allowedUIDs.includes(uid))) return { score: 0, reasons: [], fold: false };
    const reasons = [];
    let score = 0;
    let hard = false;
    if (uid && c.blockedUIDs.includes(uid)) { hard = true; reasons.push('UID 黑名单'); }
    const body = normalize(text).replace(/^回复\s*@.{1,80}?[:：]\s*/, '');
    const phrase = c.blockedPhrases.find(p => body.toLowerCase().includes(normalize(p).toLowerCase()));
    if (phrase) { hard = true; reasons.push('自定义正文片段：' + phrase); }
    if (c.personaRules) {
      if (/(?:大肥鱼|大肥鲸|鲸鱼娘)$/.test(normalize(name))) { score += 3; reasons.push('昵称符合人格账号样式 +3'); }
      if (/(?:本鱼|本鲸|本肥鱼)/.test(body)) { score += 2; reasons.push('正文有人格自称 +2'); }
      if (/^(?:你好[，,！!。\s]*)?(?:我是一(?:个|名)|作为一?(?:个|名)?)(?:AI|人工智能|语言模型|智能助手)/i.test(body)) {
        score += 3; reasons.push('正文自述 AI 身份 +3（可能为引用或模仿）');
      }
    }
    const hit = hard || score >= 2;
    const fold = c.mode !== 'observe' && (hard || score >= (c.mode === 'strict' ? 2 : 5));
    return { score, reasons: hit ? reasons : [], fold };
  }

  const W = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
  const network = { fetch: false, xhr: false, responses: 0, removed: 0 };
  function replyEndpoint(input, method = 'GET') {
    if (String(method).toUpperCase() !== 'GET') return false;
    try {
      const raw = typeof input === 'string' ? input : input?.url || String(input);
      const url = new URL(raw, location.href);
      return url.protocol === 'https:' && url.hostname === 'api.bilibili.com'
        && ['/x/v2/reply', '/x/v2/reply/main', '/x/v2/reply/wbi/main', '/x/v2/reply/reply'].includes(url.pathname);
    } catch { return false; }
  }
  // 只看 author/member.mid，不根据昵称、@ 链接或正文推断黑名单。
  function filterPayload(payload, c = config) {
    if (!c.enabled || c.mode === 'observe' || !c.blockedUIDs.length
      || payload?.code !== 0 || !payload.data || typeof payload.data !== 'object') return 0;
    const denied = new Set(c.blockedUIDs);
    const allowed = new Set(c.allowedUIDs);
    let removed = 0;
    function blocked(reply) {
      const mid = reply?.member?.mid;
      const uid = typeof mid === 'string' ? mid : Number.isSafeInteger(mid) ? String(mid) : '';
      return /^[1-9]\d*$/.test(uid) && denied.has(uid) && !allowed.has(uid);
    }
    function list(replies) {
      return replies.filter(reply => {
        if (blocked(reply)) { removed++; return false; }
        if (Array.isArray(reply?.replies)) reply.replies = list(reply.replies);
        return true;
      });
    }
    const data = payload.data;
    for (const key of ['replies', 'top_replies', 'hots']) {
      if (Array.isArray(data[key])) data[key] = list(data[key]);
    }
    if (data.top && typeof data.top === 'object' && !Array.isArray(data.top)) {
      for (const key of ['upper', 'admin', 'vote']) {
        const reply = data.top[key];
        if (blocked(reply)) { data.top[key] = null; removed++; }
        else if (Array.isArray(reply?.replies)) reply.replies = list(reply.replies);
      }
    }
    // 游标、page.count、rcount 都是服务端的分页/总数信息，不按当前预览数量改写。
    return removed;
  }
  function account(removed) {
    network.responses++;
    network.removed += removed;
  }
  function pageFunction(fn) {
    return typeof exportFunction === 'function' ? exportFunction(fn, W) : fn;
  }
  function responseMetadata(response, original) {
    for (const key of ['url', 'type', 'redirected']) {
      Object.defineProperty(response, key, { configurable: true, value: original[key] });
    }
    Object.defineProperty(response, 'clone', { configurable: true, value: pageFunction(function () {
      return responseMetadata(W.Response.prototype.clone.call(this), original);
    }) });
    return response;
  }
  function installNetworkHooks() {
    if (typeof W.fetch === 'function') {
      try {
        const nativeFetch = W.fetch;
        W.fetch = pageFunction(function (input, init) {
          const request = nativeFetch.apply(this, arguments);
          if (!replyEndpoint(input, init?.method || input?.method || 'GET')) return request;
          return request.then(async response => {
            if (!response.ok || !config.enabled || config.mode === 'observe' || !config.blockedUIDs.length) return response;
            try {
              const payload = W.JSON.parse(await response.clone().text());
              const removed = filterPayload(payload);
              if (!removed) return response;
              const headers = new W.Headers(response.headers);
              for (const key of ['content-length', 'content-encoding', 'content-md5', 'etag', 'digest']) headers.delete(key);
              const replacement = responseMetadata(new W.Response(W.JSON.stringify(payload), {
                status: response.status, statusText: response.statusText, headers
              }), response);
              account(removed);
              return replacement;
            } catch { return response; } // 格式变化、解析或构造失败时保留原响应
          });
        });
        network.fetch = true;
      } catch (e) { console.warn('[评论屏蔽] Fetch 钩子未安装，保留页面折叠', e); }
    }
    const proto = W.XMLHttpRequest?.prototype;
    const textDescriptor = proto && Object.getOwnPropertyDescriptor(proto, 'responseText');
    const responseDescriptor = proto && Object.getOwnPropertyDescriptor(proto, 'response');
    if (!textDescriptor?.get || !responseDescriptor?.get) return;
    try {
      const nativeOpen = proto.open;
      const requests = new WeakMap();
      function output(xhr) {
        const state = requests.get(xhr);
        if (!state?.target || xhr.readyState !== 4 || xhr.status < 200 || xhr.status >= 300) return null;
        if (state.done) return state.result;
        state.done = true;
        try {
          const type = xhr.responseType;
          if (type !== '' && type !== 'text' && type !== 'json') return null;
          if (!config.enabled || config.mode === 'observe' || !config.blockedUIDs.length) return null;
          const original = type === 'json' ? responseDescriptor.get.call(xhr) : textDescriptor.get.call(xhr);
          // json 模式也复制后再过滤，避免改变浏览器持有的原对象。
          const payload = W.JSON.parse(type === 'json' ? W.JSON.stringify(original) : original);
          const removed = filterPayload(payload);
          if (!removed) return null;
          state.result = { value: type === 'json' ? payload : W.JSON.stringify(payload) };
          account(removed);
          return state.result;
        } catch { return null; }
      }
      proto.open = pageFunction(function (method, url) {
        const returned = nativeOpen.apply(this, arguments);
        const state = { target: replyEndpoint(url, method), done: false, result: null };
        requests.set(this, state);
        if (state.target && !Object.hasOwn(this, 'response') && !Object.hasOwn(this, 'responseText')) {
          try {
            Object.defineProperties(this, {
              responseText: { configurable: true, get: pageFunction(function () {
                // 非文本类型保留原生 InvalidStateError。
                if (this.responseType !== '' && this.responseType !== 'text') return textDescriptor.get.call(this);
                return output(this)?.value ?? textDescriptor.get.call(this);
              }) },
              response: { configurable: true, get: pageFunction(function () {
                return output(this)?.value ?? responseDescriptor.get.call(this);
              }) }
            });
          } catch { /* 无法覆盖时沿用页面折叠 */ }
        }
        return returned;
      });
      network.xhr = true;
    } catch (e) { console.warn('[评论屏蔽] XHR 钩子未安装，保留页面折叠', e); }
  }
  installNetworkHooks();

  const ITEM = 'bili-comment-renderer,bili-comment-reply-renderer';
  const states = new WeakMap();
  const observers = new Map();
  let timer = null;
  let lastURL = location.href;
  let scanned = 0;
  let hits = 0;
  let folded = 0;
  function schedule() {
    if (timer !== null) return;
    timer = setTimeout(() => { timer = null; scan(); }, 250);
  }
  // 遍历开放 shadow root。读取单条评论时不进入其他评论，避免串入子回复。
  function walk(root, visit, skipItems = false) {
    for (const el of root.children || []) {
      if (el.hasAttribute('data-baf-ui') || el.hasAttribute('data-baf-style')) continue;
      if (skipItems && el.matches(ITEM)) continue;
      visit(el);
      if (el.shadowRoot) walk(el.shadowRoot, visit, skipItems);
      walk(el, visit, skipItems);
    }
  }
  function read(item) {
    const root = item.shadowRoot || item;
    let content = null;
    let uid = '';
    let name = '';
    walk(root, el => {
      if (!content && el.matches('bili-rich-text')) {
        content = el.shadowRoot?.querySelector('#contents') || el;
      }
      if (!content && el.matches('.reply-content,.reply-text,.text-con')) content = el;
      // 只从作者区域取 UID；正文里的 @ 用户链接不能当作作者。
      const authorArea = el.matches('bili-comment-user-info,bili-comment-user-avatar,#user-name,#user-avatar,.user-name,.sub-user-name,.user-face');
      if (!authorArea) return;
      const authorNodes = [el];
      walk(el.shadowRoot || el, child => authorNodes.push(child), true);
      for (const a of uid ? [] : authorNodes) {
        const mid = a.getAttribute('data-user-id') || a.getAttribute('data-mid');
        const match = (a.getAttribute('href') || '').match(/^(?:https?:)?\/\/space\.bilibili\.com\/([1-9]\d*)(?:[/?#]|$)/);
        if (mid && /^[1-9]\d*$/.test(mid)) uid = mid;
        else if (match) uid = match[1];
        if (uid) break;
      }
      // 用户信息组件可能还包含等级等信息，优先取姓名节点。
      let nameEl = el.shadowRoot?.querySelector('#user-name,#name,.user-name,a[href*="space.bilibili.com"]');
      if (!nameEl && el.matches('#user-name,.user-name,.sub-user-name')) nameEl = el;
      if (nameEl) name = normalize(nameEl.textContent);
    }, true);
    if (!content) return null; // 不猜测整楼 textContent
    return { uid, name, text: normalize(content.textContent) };
  }
  function save(next) {
    try { next = validate(next); GM_setValue(KEY, next); config = next; }
    catch (e) { alert('未保存：' + e.message); return; }
    // 同一条已展开评论在规则修改后重新判定。
    ruleVersion++;
    schedule();
  }
  let ruleVersion = 0;
  function button(label, action) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label;
    b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); action(); });
    return b;
  }
  function render(item, record, result) {
    const root = item.shadowRoot || item;
    let state = states.get(item);
    const identity = JSON.stringify([location.pathname, record.uid, record.text]);
    if (!state || state.identity !== identity) {
      state?.ui.remove(); state?.style.remove();
      state = { identity, expanded: false, version: ruleVersion, signature: '' };
      states.set(item, state);
    }
    if (state.version !== ruleVersion) { state.expanded = false; state.version = ruleVersion; }
    const isFolded = result.fold && !state.expanded;
    const signature = JSON.stringify([record.uid, record.name, result, isFolded, config.enabled, ruleVersion]);
    if (state.signature === signature && state.ui?.parentNode === root && state.style?.parentNode === root) return isFolded;
    state.signature = signature;
    state.ui?.remove(); state.style?.remove();
    const ui = document.createElement('div');
    ui.setAttribute('data-baf-ui', '');
    const style = document.createElement('style');
    style.setAttribute('data-baf-style', '');
    // 只隐藏当前 renderer 的内容，主楼的回复列表（位于 thread 内）保留。
    const target = item.shadowRoot ? ':host([data-baf-fold])' : '[data-baf-fold]';
    style.textContent = `${target} > :not([data-baf-ui]):not(style):not(.sub-reply-container):not(.reply-box) {display:none!important}
      [data-baf-ui]{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:4px 0;font:12px/1.6 sans-serif;color:var(--text2,#888)}
      [data-baf-ui] button{font:inherit;color:inherit;background:transparent;border:1px solid #8886;border-radius:4px;cursor:pointer;padding:0 5px}`;
    item.toggleAttribute('data-baf-fold', isFolded);
    if (result.reasons.length) {
      const label = document.createElement('span');
      label.textContent = (isFolded ? '已折叠 · ' : '规则命中 · ') + result.reasons.join('；');
      ui.append(label);
      if (result.fold) ui.append(button(isFolded ? '展开原文' : '重新折叠', () => { state.expanded = !state.expanded; state.signature = ''; schedule(); }));
    }
    if (record.uid && config.enabled) {
      if (config.blockedUIDs.includes(record.uid)) {
        ui.append(button('移出黑名单', () => save({ ...config, blockedUIDs: config.blockedUIDs.filter(x => x !== record.uid) })));
      } else if (!config.allowedUIDs.includes(record.uid)) {
        ui.append(button('屏蔽此 UID', () => save({ ...config, blockedUIDs: [...config.blockedUIDs, record.uid] })));
      }
      if (result.reasons.length) ui.append(button('信任此 UID', () => save({ ...config, allowedUIDs: [...config.allowedUIDs, record.uid] })));
    }
    ui.title = 'UID: ' + (record.uid || '未读到；可在设置中手动添加') + '。文本规则不能证实是否由 Agent 发送。';
    state.ui = ui; state.style = style;
    root.prepend(style, ui);
    return isFolded;
  }
  function observe(root) {
    if (observers.has(root)) return;
    const observer = new MutationObserver(records => {
      // 忽略自己的 UI 变化，避免渲染触发循环。
      const relevant = records.some(r => {
        const p = r.target.nodeType === 1 ? r.target : r.target.parentElement;
        if (p?.closest('[data-baf-ui],[data-baf-style]')) return false;
        if (r.type === 'characterData') return true;
        return [...r.addedNodes, ...r.removedNodes].some(n => !(n.nodeType === 1 && (n.hasAttribute('data-baf-ui') || n.hasAttribute('data-baf-style'))));
      });
      if (relevant) schedule();
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    observers.set(root, observer);
  }
  function scan() {
    scanned = hits = folded = 0;
    if (lastURL !== location.href) { lastURL = location.href; ruleVersion++; }
    for (const [root, observer] of observers) {
      if (!root.host?.isConnected && !root.isConnected) { observer.disconnect(); observers.delete(root); }
    }
    const items = new Set();
    const containers = document.querySelectorAll('bili-comments,#commentapp,#comment,.bili-comment');
    for (const container of containers) {
      observe(container);
      if (container.shadowRoot) observe(container.shadowRoot);
      walk(container.shadowRoot || container, el => {
        if (el.shadowRoot) observe(el.shadowRoot);
        if (el.matches(ITEM)) items.add(el);
      });
    }
    for (const item of items) {
      const record = read(item);
      if (!record) continue;
      scanned++;
      const result = classify(record);
      if (result.reasons.length) hits++;
      if (render(item, record, result)) folded++;
    }
  }
  GM_registerMenuCommand('设置 / 导入导出 JSON', () => {
    const raw = prompt('可复制备份。白名单优先；UID 请用字符串。mode: observe 只标记 / balanced 保守折叠 / strict 扩大折叠', JSON.stringify(config, null, 2));
    if (raw === null) return;
    try { save(JSON.parse(raw)); } catch (e) { alert('JSON 无效：' + e.message); }
  });
  GM_registerMenuCommand('暂停 / 恢复（响应中已移除的评论需刷新）', () => save({ ...config, enabled: !config.enabled }));
  GM_registerMenuCommand('当前扫描状态', () => alert(`已读取 ${scanned} 条；规则命中 ${hits} 条；当前折叠 ${folded} 条。\n页面计数仅包含已加载且可读取的评论。0 条可能是尚未加载或页面结构变化。\n响应层累计移除 ${network.removed} 个命中节点，涉及 ${network.responses} 份响应（含重复返回）。\nFetch 钩子：${network.fetch}；XHR 钩子：${network.xhr}。\n响应中已移除的评论需暂停或移出黑名单后刷新恢复。\n模式：${config.mode}；启用：${config.enabled}`));
  scan();
  // 兜底发现延迟 attachShadow 和评论区整体重建；后台标签不轮询。
  setInterval(() => { if (!document.hidden) schedule(); }, 2500);
})();
