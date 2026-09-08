// hook 层(bash)测试入口: 以子进程跑 test/hooks.sh, 断言其用例计数。
// bash 测试不写进 node 断言里 —— 断言放在 bash 侧便于逐条定位, 这里只看汇总。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const SCRIPT = __dirname + '/hooks.sh';

function runHooks(caseName) {
  try {
    const out = execFileSync('bash', [SCRIPT, caseName], { encoding: 'utf8', timeout: 30000 });
    return { status: 0, out };
  } catch (e) {
    return { status: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

test('hook 层: spool 开关/malformed config/drain/ensure_server', () => {
  const r = runHooks('all');
  assert.equal(r.status, 0, 'hooks.sh 用例未全通过:\n' + r.out);
  // 用例数变化时同步更新这里, 防止"少跑了几条还显示全绿"
  assert.match(r.out, /SUMMARY pass=\d+ fail=0/, '应有 fail=0 汇总行:\n' + r.out);
});
