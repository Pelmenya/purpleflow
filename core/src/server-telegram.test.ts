import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import './server/main.js';
import type { AttentionIntent } from './server/attention.js';
import { startTelegram } from './server/telegram.js';
import { listen } from './server-testkit.test.js';

const runId = crypto.randomUUID();
const waitIntent: AttentionIntent = { key: `wait:${runId}:w1`, runId, kind: 'wait', reasonCode: 'gate1' };
const stoppedIntent: AttentionIntent = {
  key: `stopped:${runId}:s1`,
  runId,
  kind: 'stopped',
  reasonCode: 'stage_failed',
};

class FakeHost {
  current: AttentionIntent[] = [];
  private listeners = new Set<(runId: string, intent: AttentionIntent | null) => void>();

  intents(): AttentionIntent[] {
    return this.current;
  }

  onIntentChange(fn: (runId: string, intent: AttentionIntent | null) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(intent: AttentionIntent | null, id = runId): void {
    this.current = intent ? this.current.filter((item) => item.runId !== id).concat(intent) : this.current.filter((item) => item.runId !== id);
    for (const listener of this.listeners) listener(id, intent);
  }
}

function tempDir(t: TestContext): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-telegram-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function waitFor(check: () => boolean, message: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('телеграм: ожидание доставляется один раз со ссылкой на прогон', async (t) => {
  const messages: { chat_id: string | number; text: string }[] = [];
  const apiBase = await listen(t, (req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      messages.push(JSON.parse(body) as { chat_id: string | number; text: string });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    });
  });
  const host = new FakeHost();
  const handle = startTelegram({
    dataDir: tempDir(t),
    token: 'secret-token',
    chatId: 'owner',
    apiBase,
    publicOrigin: 'https://purpleflow.example',
    host,
  });
  t.after(handle.stop);

  host.emit(waitIntent);
  await waitFor(() => messages.length === 1, 'Ожидание не доставлено');
  assert.equal(messages[0]?.chat_id, 'owner');
  assert.match(messages[0]?.text ?? '', /утверждение плана/i);
  assert.ok(messages[0]?.text.includes(`https://purpleflow.example/runs/${runId}`));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(messages.length, 1);

  host.emit(stoppedIntent);
  await waitFor(() => messages.length === 2, 'Остановка не доставлена');
  assert.match(messages[1]?.text ?? '', /остановлен с ошибкой/i);
  assert.ok(messages[1]?.text.includes(`https://purpleflow.example/runs/${runId}/log`));
});
