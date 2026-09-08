const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
const repoPath = '/home/azrael/kylie-worktrees/pr-194';
const ci = '/home/azrael/kylie/scripts/ci';

function harness(summary) {
  const tasks = [];
  const terminals = [];
  const vscode = {
    workspace: { getConfiguration: () => ({ get: () => ci }) },
    window: {
      createOutputChannel: () => ({}),
      showInputBox: async () => summary,
      createTerminal: (options) => {
        terminals.push(options);
        return { show() {}, sendText() {} };
      },
    },
    TaskScope: { Workspace: 2 },
    TaskRevealKind: { Always: 1 },
    TaskPanelKind: { Dedicated: 2 },
    ProcessExecution: class {
      constructor(process, args, options) { Object.assign(this, { process, args, options }); }
    },
    Task: class {
      constructor(definition, scope, name, source, execution, problemMatchers) {
        Object.assign(this, { definition, scope, name, source, execution, problemMatchers });
      }
    },
    tasks: { executeTask: async (task) => { tasks.push(task); } },
  };
  const Provider = vm.runInNewContext(source + '\nStatsViewProvider;', {
    module: { exports: {} },
    require: (name) => {
      if (name === 'vscode') return vscode;
      if (name === 'child_process') return {};
      return require(name);
    },
  });
  return { provider: new Provider(), tasks, terminals, vscode };
}

test('preview starts as a process task outside shell auto-activation', async () => {
  const { provider, tasks, terminals, vscode } = harness();
  await provider.runCi('preview', repoPath, '194');

  assert.equal(tasks.length, 1, 'preview must use a task terminal to avoid Python activation');
  assert.equal(terminals.length, 0, 'do not send preview text into a newly activating shell');
  const task = tasks[0];
  assert.ok(task.execution instanceof vscode.ProcessExecution);
  assert.equal(task.execution.process, ci);
  assert.deepEqual(Array.from(task.execution.args), ['preview', '194']);
  assert.equal(task.execution.options.cwd, repoPath);
  assert.equal(task.presentationOptions.reveal, vscode.TaskRevealKind.Always);
  assert.equal(task.presentationOptions.focus, true);
});

for (const [command, expected] of [
  ['test', ['test', '194', '--fix']],
  ['land', ['land', '194']],
  ['new', ['new', 'preview-startup-race', '--case', '6654']],
]) {
  test(`${command} preserves its arguments and worktree in the task`, async () => {
    const { provider, tasks } = harness('#6654 preview startup race');
    await provider.runCi(command, repoPath, '194');

    assert.equal(tasks.length, 1);
    assert.deepEqual(Array.from(tasks[0].execution.args), expected);
    assert.equal(tasks[0].execution.options.cwd, repoPath);
  });
}

test('invalid PR serial launches nothing', async () => {
  const { provider, tasks, terminals } = harness();
  await provider.runCi('preview', repoPath, '194; echo invalid');
  assert.equal(tasks.length, 0);
  assert.equal(terminals.length, 0);
});
