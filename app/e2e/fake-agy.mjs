// Фейковый `agy acp` для e2e: JSON-RPC по stdio. На «Отправь ветку» просит разрешение на git push
// и отвечает по решению человека. Ответы клиента на запросы пишет в FAKE_AGY_LOG.
import fs from 'node:fs';
import readline from 'node:readline';

const log = (x) => process.env.FAKE_AGY_LOG && fs.appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify(x) + '\n');
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const update = (u) => send({ method: 'session/update', params: { sessionId: 'S1', update: u } });
const waiting = new Map();
let next = 1;
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = String(next++);
    waiting.set(id, resolve);
    send({ id, method, params });
  });
const say = (text) => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

if (process.argv[2] === '--version') {
  console.log('1.5.17');
  process.exit(0);
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const m = JSON.parse(line);
  if (m.method === undefined) {
    log({ answer: m.result });
    waiting.get(String(m.id))?.(m);
    return;
  }
  if (m.method === 'session/new') return send({ id: m.id, result: { sessionId: 'S1', models: { availableModels: [] } } });
  if (m.method !== 'session/prompt') return send({ id: m.id, result: {} });
  const text = m.params.prompt.map((b) => b.text ?? '').join('\n');
  if (/Отправь ветку/.test(text)) {
    const call = { toolCallId: 'c1', name: 'run_command', kind: 'execute', rawInput: { CommandLine: 'git push origin main' } };
    update({ sessionUpdate: 'tool_call', ...call, status: 'pending' });
    const res = await ask('session/request_permission', {
      sessionId: 'S1',
      toolCall: call,
      options: [
        { optionId: 'allow', kind: 'allow_once' },
        { optionId: 'deny', kind: 'reject_once' },
      ],
    });
    const ok = res.result?.outcome?.optionId === 'allow';
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      status: ok ? 'completed' : 'failed',
      rawOutput: { output: ok ? 'Everything up-to-date' : 'denied' },
    });
    say(ok ? 'Отправил ветку.' : 'Не стал отправлять.');
  } else say('Готово.');
  send({ id: m.id, result: { stopReason: 'end_turn', usage: {} } });
});
