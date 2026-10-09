import { readFile, appendFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { serveBridgeStdio } from '../../src/entrypoints/mcp.ts';

const ledger = process.env.MCP_TEST_LEDGER;
const caller = process.env.MCP_TEST_CALLER || 'owner';
const port = {
  async dispatch(operation, args) {
    await appendFile(ledger + '.calls', JSON.stringify({ caller, operation, args }) + '\n');
    if (operation === 'engine.list')
      return { engines: [{ engine: 'codex', available: true }], caller };
    if (operation === 'task.start') {
      const task = {
        taskId: 'task_11111111-1111-1111-1111-111111111111',
        state: 'running',
        sessionId: 'fixture-session',
        owner: caller
      };
      await writeFile(ledger, JSON.stringify(task));
      return task;
    }
    if (operation === 'task.get') return JSON.parse(await readFile(ledger, 'utf8'));
    return { operation, args };
  }
};
serveBridgeStdio(port);
