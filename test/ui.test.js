const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ui/index.html 的内联脚本此前完全没被执行过: `node --check` 只查语法不查引用,
// 0.2.7 就靠这个缺口把 `parentId is not defined` 带上了线 —— 首屏出现一张带归属的 TOOL 卡时
// render() 抛 ReferenceError, loadPrompts 的 Promise 拒绝, 整个「提示词记录」列表保持空白。
// 这里用最小 DOM stub 真跑一遍脚本并调用 render(), 把未定义标识符/运行期异常挡在 CI 外面。

function uiScript() {
  const html = fs.readFileSync(path.join(__dirname, '../ui/index.html'), 'utf8');
  return html.match(/<script>([\s\S]*?)<\/script>/)[1];
}

// 链式 Proxy: 任意属性读取返回空值, 任意方法调用返回新的链式 stub。
// 目的是让脚本能跑到底 —— 断言的是"有没有抛异常 + promptList 有没有拿到 HTML", 不是 DOM 行为。
// 同一 id 复用同一节点, 这样 innerHTML 的 += 才能像浏览器里那样累加。
function runUi() {
  const nodes = new Map();
  function chain(id) {
    if (nodes.has(id)) return nodes.get(id);
    const t = { id, _html: '', _text: '' };
    const p = new Proxy(t, {
      get(o, k) {
        if (k === 'innerHTML') return o._html;
        if (k === 'textContent') return o._text;
        if (k === 'value') return o._value || '';
        if (k === 'style') return style;
        if (k === 'dataset') return {};
        if (k === 'classList') return { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false };
        if (typeof k === 'string') return (...a) => chain(id + '.' + k);
        return undefined;
      },
      set(o, k, v) {
        if (k === 'innerHTML') o._html = v;
        if (k === 'textContent') o._text = v;
        if (k === 'value') o._value = v;
        return true;
      }
    });
    nodes.set(id, p);
    return p;
  }
  const style = new Proxy({}, { get: (t, k) => t[k] ?? '', set: () => true });

  let exposed = null;
  const sandbox = {
    console, setTimeout, clearTimeout,
    setInterval: () => 0, clearInterval: () => {},
    URLSearchParams, TextEncoder, TextDecoder,
    location: { href: 'http://127.0.0.1:37889/', origin: 'http://127.0.0.1:37889' },
    localStorage: { getItem: () => null, setItem: () => {} },
    confirm: () => false, alert: () => {}, scrollTo: () => {},
    // init() 末尾会触发真实加载; 返回合法空数据, 让异步链正常结束而不产生未处理的 rejection
    fetch: async () => ({ json: async () => ({ projects: [], prompts: [], summaries: [], total: 0 }) }),
    __expose: o => { exposed = o; },
  };
  sandbox.window = sandbox;
  sandbox.document = new Proxy({}, {
    get: (o, k) => {
      if (k === 'getElementById') return id => chain('el.' + id);
      if (k === 'createElement') return tag => chain('new.' + tag);
      if (k === 'querySelectorAll') return () => [];
      if (k === 'body') return chain('body');
      return (...a) => chain('doc.' + k);
    },
    set: () => true
  });

  // 脚本末尾的 init() 会跑真实加载; 附加一行把内部函数暴露出来供断言
  const code = uiScript()
    + '\n;__expose({ render, sessionCard, buildLoadedIds, get_prompts: () => prompts, set_prompts: v => { prompts = v; } });';
  vm.runInNewContext(code, sandbox, { filename: 'ui/index.html' });
  assert.ok(exposed, '脚本执行到底没有抛异常(__expose 未被调用 = 中途抛了)');
  return {
    ...exposed,
    // render() 没有返回值, 它把 HTML 追加到 promptList —— 只能从 DOM 读回
    promptListHtml: () => (nodes.get('el.promptList') || { innerHTML: '' }).innerHTML,
    reset: () => { if (nodes.has('el.promptList')) nodes.get('el.promptList').innerHTML = ''; }
  };
}

test('render 渲染 PROMPT 卡 + 带归属的 TOOL 卡, 不抛异常且产出卡片 HTML', () => {
  const ui = runUi();
  const rows = [
    { id: 11, type: 'PROMPT', session_id: 's1', prompt: '改一下按钮样式', project_dir: '/p/app',
      summary_status: 'success', summary: '调整了按钮圆角', seq: 42, created_at: '2026-09-14T07:00:00Z' },
    { id: 12, type: 'TOOL', session_id: 's1', prompt: 'Edit: ', tool_name: 'Edit', project_dir: '/p/app',
      summary: '修改按钮样式', summary_meta: JSON.stringify({ title: '改按钮圆角', result: '已更新' }),
      parent_id: 11, parent_seq: 42, seq: 43, created_at: '2026-09-14T07:00:05Z' },
    { id: 13, type: 'TOOL', session_id: 's1', prompt: 'Bash: ', tool_name: 'Bash', project_dir: '/p/app',
      summary: '', summary_meta: '', seq: 44, created_at: '2026-09-14T07:00:06Z' }
  ];
  ui.set_prompts(rows);
  ui.reset();
  ui.render(rows);
  const out = ui.promptListHtml();

  assert.ok(out.includes('class="card'), '应产出卡片, 实际长度 ' + out.length);
  // 序号必须走落库的 seq, 不是 db autoid
  assert.ok(out.includes('#42'), 'PROMPT 卡页脚应显示 seq');
  assert.ok(out.includes('#43'), 'TOOL 卡页脚应显示 seq');
  // 归属链接: 父卡已在列表中, onclick 必须是可执行的 jumpToPrompt(<父行 id>)
  assert.ok(out.includes('jumpToPrompt('), '带归属的 TOOL 卡应渲染归属链接');
  assert.ok(out.includes('jumpToPrompt(11)'), 'onclick 参数应为父行 id —— 0.2.7 这里曾是未定义的 parentId');
  assert.ok(out.includes('归属提示词 #42'), '归属编号应显示父行 seq');
  // 无摘要的 TOOL 行不渲染
  assert.ok(!out.includes('data-id="13"'), '无摘要的 TOOL 行应被过滤');
  assert.equal((out.match(/<div class="card( |")/g) || []).length, 2, '只剩 2 张卡');
});

test('render 在父卡不在列表时仍渲染归属编号且不给 onclick 死链', () => {
  const ui = runUi();
  const rows = [
    { id: 21, type: 'TOOL', session_id: 's1', prompt: 'Read: ', tool_name: 'Read', project_dir: '/p',
      summary: '读了配置文件', summary_meta: JSON.stringify({ title: '读配置', result: 'ok', count: 3 }),
      parent_id: 5, parent_seq: 8, seq: 22, created_at: '2026-09-14T07:10:00Z' }
  ];
  ui.set_prompts(rows);
  ui.reset();
  ui.render(rows);
  const out = ui.promptListHtml();

  assert.ok(out.includes('归属提示词 #8'), '父卡不在列表时编号仍要显示');
  assert.ok(!out.includes('jumpToPrompt('), '父卡不在列表时不应生成可点击的 onclick');
  assert.ok(out.includes('3 次合并'), '合并次数徽标仍在');
});

test('sessionCard 使用 session_summaries 的 seq 而非 db id', () => {
  const ui = runUi();
  const out = ui.sessionCard({
    id: 9, session_id: 'abcdef12-3456-7890-abcd-ef1234567890', seq: 57,
    request: '重构工具队列', investigated: '', learned: '内存队列更合适', completed: '完成队列化',
    next_steps: '验证边界', notes: '', project_dir: '/p', created_at: '2026-09-14T07:20:00Z', ended_at: '2026-09-14T07:30:00Z'
  });
  assert.ok(out.includes('#57'), '会话摘要卡应显示 seq');
  assert.ok(!out.includes('摘要 #'), '不应再出现"摘要 #id"这种混排口径');
});
