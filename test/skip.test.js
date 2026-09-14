const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isLowSignalTool, isReadOnlyBash } = require('../lib/skip');

test('hard-skip tools: LS/Glob/Grep/TodoWrite', () => {
  assert.ok(isLowSignalTool({ tool_name: 'LS' }));
  assert.ok(isLowSignalTool({ tool_name: 'Glob' }));
  assert.ok(isLowSignalTool({ tool_name: 'Grep' }));
  assert.ok(isLowSignalTool({ tool_name: 'TodoWrite' }));
});

test('read-only Bash commands are low-signal', () => {
  assert.ok(isLowSignalTool({ tool_name: 'Bash', tool_input: { command: 'ls -la' } }));
  assert.ok(isLowSignalTool({ tool_name: 'Bash', tool_input: { command: 'git status' } }));
  assert.ok(isLowSignalTool({ tool_name: 'Bash', tool_input: { command: 'git log --oneline -5' } }));
  assert.ok(isLowSignalTool({ tool_name: 'Bash', tool_input: { command: 'cat README.md' } }));
  assert.ok(isLowSignalTool({ tool_name: 'Bash', tool_input: { command: 'grep -r foo .' } }));
  // 管道/&& 前是只读命令也算
  assert.ok(isLowSignalTool({ tool_name: 'Bash', tool_input: { command: 'ls && echo done' } }));
});

test('write/execute Bash commands are NOT low-signal', () => {
  // 带 stdout 的写/执行命令: 不应被只读判定或空输出判定跳过
  const resp = { stdout: 'some output', stderr: '' };
  assert.ok(!isLowSignalTool({ tool_name: 'Bash', tool_input: { command: 'npm install' }, tool_response: resp }));
  assert.ok(!isLowSignalTool({ tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, tool_response: resp }));
  assert.ok(!isLowSignalTool({ tool_name: 'Bash', tool_input: { command: 'node lib/server.js' }, tool_response: resp }));
  assert.ok(!isLowSignalTool({ tool_name: 'Bash', tool_input: { command: '/usr/local/bin/mybin' }, tool_response: resp }));
});

test('silent Bash (empty output) is low-signal', () => {
  assert.ok(isLowSignalTool({ tool_name: 'Bash', tool_input: { command: 'mkdir -p build' }, tool_response: { stdout: '', stderr: '' } }));
  assert.ok(isLowSignalTool({ tool_name: 'Bash', tool_input: { command: 'mkdir build' }, tool_response: { noOutputExpected: true } }));
});

test('write tools with output are NOT low-signal', () => {
  assert.ok(!isLowSignalTool({ tool_name: 'Write', tool_input: { file_path: 'a.js' }, tool_response: { stdout: 'created' } }));
  assert.ok(!isLowSignalTool({ tool_name: 'Edit', tool_input: { file_path: 'a.js' }, tool_response: { stdout: 'edited' } }));
  assert.ok(!isLowSignalTool({ tool_name: 'Read', tool_input: { file_path: 'a.js' }, tool_response: { stdout: 'contents' } }));
});

// Read 的响应形状是 { type, file }, 没有 stdout。库里的 1251 条 Read 摘要全是"内容为空",
// 就是因为旧实现只判 stdout, 内容进了 file 却被当成空输出 —— 白烧 LLM 换一张 skip 卡。
test('Read with real content is NOT low-signal', () => {
  assert.ok(!isLowSignalTool({
    tool_name: 'Read', tool_input: { file_path: 'a.js' },
    tool_response: { type: 'text', file: { filePath: 'a.js', content: 'const x = 1;' } }
  }));
});

test('Read with no readable content is hard-skipped', () => {
  assert.ok(isLowSignalTool({ tool_name: 'Read', tool_input: { file_path: 'nope.js' }, tool_response: { type: 'text' } }));
  assert.ok(isLowSignalTool({ tool_name: 'Read', tool_input: { file_path: 'nope.js' }, tool_response: {} }));
  assert.ok(isLowSignalTool({ tool_name: 'Read', tool_input: { file_path: 'nope.js' } }));
  // 空文件: 有 file 结构但内容为空, 同样不值得记
  assert.ok(isLowSignalTool({
    tool_name: 'Read', tool_input: { file_path: 'empty.js' },
    tool_response: { type: 'text', file: { filePath: 'empty.js', content: '' } }
  }));
});

test('isReadOnlyBash edge cases', () => {
  assert.ok(isReadOnlyBash('git diff --stat'));
  assert.ok(!isReadOnlyBash('git commit -am x'));
  assert.ok(isReadOnlyBash('/usr/bin/ls'));  // 路径前缀去掉
  assert.ok(!isReadOnlyBash('npm test'));
  assert.ok(!isReadOnlyBash(''));
});
