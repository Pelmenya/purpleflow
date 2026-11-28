import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { ChatFile, ChatSummary, ProjectListItem, RunFile } from './types.js';
import { waitingRunFixture } from './server-testkit.test.js';
import { AccessError, admitCall, admitEvent, createAccessContext, filterResult, readChatSubject, redactSecrets } from './server/access.js';

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'purpleflow-access-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const allowed = path.join(root, 'allowed');
  const foreign = path.join(root, 'foreign');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(allowed);
  fs.mkdirSync(foreign);
  const context = createAccessContext({ dataDir, allowProject: (candidate) => candidate === allowed });
  return { root, dataDir, allowed, foreign, context };
}

function chat(dataDir: string, value: Pick<ChatFile, 'id'> & Partial<ChatFile>): ChatFile {
  const now = new Date().toISOString();
  const result: ChatFile = {
    agent: 'claude',
    model: '',
    edits: true,
    createdAt: now,
    updatedAt: now,
    messages: [],
    title: value.id,
    ...value,
  };
  const file = path.join(dataDir, 'chats', `${value.id}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(result));
  return result;
}

function denied(fn: () => void, code: 'forbidden' | 'unavailable' = 'forbidden'): void {
  assert.throws(fn, (error: unknown) => error instanceof AccessError && error.code === code);
}

function startInput(projectPath: string, attachmentPaths?: string[]) {
  return [{ type: 'run.start', input: { projectPath, task: 'Задача', testCommand: 'node --test', attachmentPaths } }];
}

test('допуск: чужие прогоны, чаты, проекты и команды отклоняются', (t) => {
  const { allowed, foreign, context } = fixture(t);
  const ownRun = waitingRunFixture(context.dataDir, allowed, { id: 'own-run', next: 'gate1' });
  const foreignRun = waitingRunFixture(context.dataDir, foreign, { id: 'foreign-run', next: 'gate1' });
  chat(context.dataDir, { id: 'own-chat', projectPath: allowed });
  chat(context.dataDir, { id: 'foreign-chat', projectPath: foreign });
  const withoutProject = chat(context.dataDir, { id: 'free-chat' });

  admitCall(context, 'getRun', [ownRun.id]);
  admitCall(context, 'getChat', ['own-chat']);
  admitCall(context, 'getChat', [withoutProject.id]);
  admitCall(context, 'detectProject', [allowed]);
  admitCall(context, 'dispatch', [{ type: 'gate.approve', runId: ownRun.id }]);

  denied(() => admitCall(context, 'getRun', [foreignRun.id]));
  denied(() => admitCall(context, 'getRun', ['missing-run']));
  denied(() => admitCall(context, 'getChat', ['foreign-chat']));
  denied(() => admitCall(context, 'detectProject', [foreign]));
  denied(() => admitCall(context, 'dispatch', startInput(foreign)));
  denied(() => admitCall(context, 'dispatch', [{ type: 'gate.approve', runId: foreignRun.id }]));
});

test('допуск: списки оставляют только допущенные проекты и чаты без проекта', (t) => {
  const { allowed, foreign, context } = fixture(t);
  const ownRun = waitingRunFixture(context.dataDir, allowed, { id: 'own-run', next: 'gate1' });
  waitingRunFixture(context.dataDir, foreign, { id: 'foreign-run', next: 'gate1' });
  const chats: ChatSummary[] = [
    { id: 'own', title: 'Свой', projectPath: allowed, agent: 'claude', updatedAt: '', busy: false, last: null },
    { id: 'foreign', title: 'Чужой', projectPath: foreign, agent: 'claude', updatedAt: '', busy: false, last: null },
    { id: 'free', title: 'Без проекта', agent: 'claude', updatedAt: '', busy: false, last: null },
  ];
  const projects: ProjectListItem[] = [
    { path: allowed, configured: true, exists: true, runs: 1, active: 0, lastRunAt: null },
    { path: foreign, configured: true, exists: true, runs: 1, active: 0, lastRunAt: null },
  ];

  assert.deepEqual(
    (filterResult(context, 'listRuns', context.store.list()) as { id: string }[]).map(({ id }) => id),
    [ownRun.id],
  );
  assert.deepEqual(
    (filterResult(context, 'listChats', chats) as ChatSummary[]).map(({ id }) => id),
    ['own', 'free'],
  );
  assert.deepEqual(filterResult(context, 'listProjects', projects), [projects[0]]);
});

test('допуск: run.start принимает только вложения допущенных прогонов и чатов', (t) => {
  const { root, allowed, foreign, context } = fixture(t);
  const runFile = path.join(root, 'run-attachment.txt');
  const foreignRunFile = path.join(root, 'foreign-run-attachment.txt');
  const chatFile = path.join(root, 'chat-attachment.txt');
  const foreignChatFile = path.join(root, 'foreign-chat-attachment.txt');
  for (const file of [runFile, foreignRunFile, chatFile, foreignChatFile]) fs.writeFileSync(file, file);
  waitingRunFixture(context.dataDir, allowed, { id: 'own-run', next: 'gate1', attachments: [runFile] });
  waitingRunFixture(context.dataDir, foreign, { id: 'foreign-run', next: 'gate1', attachments: [foreignRunFile] });
  chat(context.dataDir, {
    id: 'own-chat',
    projectPath: allowed,
    messages: [{ id: 'm1', role: 'user', at: '', text: 'Файл', attachments: [chatFile] }],
  });
  chat(context.dataDir, {
    id: 'foreign-chat',
    projectPath: foreign,
    messages: [{ id: 'm2', role: 'user', at: '', text: 'Файл', attachments: [foreignChatFile] }],
  });

  admitCall(context, 'dispatch', startInput(allowed, [runFile]));
  admitCall(context, 'dispatch', startInput(allowed, [chatFile]));
  denied(() => admitCall(context, 'dispatch', startInput(allowed, [foreignRunFile])));
  denied(() => admitCall(context, 'dispatch', startInput(allowed, [foreignChatFile])));
  denied(() => admitCall(context, 'dispatch', startInput(allowed, ['/etc/hostname'])));
  denied(() => admitCall(context, 'dispatch', startInput(allowed, [path.join(root, 'missing')])));
});

test('допуск: несуществующий и некорректный чат не доходят до ядра, хранилище недоступно', (t) => {
  const { context } = fixture(t);
  let coreCalls = 0;
  const call = (method: 'getChat' | 'getStorage' | 'cleanStorage', args: unknown[]) => {
    admitCall(context, method, args);
    coreCalls++;
  };

  denied(() => call('getChat', ['нет-такого']));
  denied(() => call('getChat', ['../x']));
  denied(() => call('getStorage', []), 'unavailable');
  denied(() => call('cleanStorage', ['worktrees-done']), 'unavailable');
  assert.equal(coreCalls, 0);
});

test('допуск: readChatSubject читает только простой id и корректный JSON', (t) => {
  const { context } = fixture(t);
  const own = chat(context.dataDir, { id: 'own-chat' });
  assert.equal(readChatSubject(context.dataDir, 'own-chat').id, own.id);
  fs.writeFileSync(path.join(context.dataDir, 'chats', 'broken.json'), '{');
  denied(() => readChatSubject(context.dataDir, 'broken'));
  denied(() => readChatSubject(context.dataDir, '../own-chat'));
});

test('допуск: необязательный проект, новый чат и возможности владельца', (t) => {
  const { allowed, foreign, context } = fixture(t);
  admitCall(context, 'listChatSkills', []);
  admitCall(context, 'listOpencodeModels', [allowed]);
  denied(() => admitCall(context, 'listChatSkills', [foreign]));
  admitCall(context, 'createChat', [{}]);
  admitCall(context, 'createChat', [{ projectPath: allowed }]);
  denied(() => admitCall(context, 'createChat', [{ projectPath: foreign }]));
  admitCall(context, 'detectTools', []);
});

test('редакция: секреты заменяются в строках, вложенных объектах и массивах', () => {
  const secret = 'sk-ant-secret-123';
  const input = { text: `до ${secret} после`, nested: [{ secret }, { bytes: new Uint8Array([1, 2]) }] };
  const result = redactSecrets(input, [secret, 'short']);
  assert.deepEqual(result, { text: 'до *** после', nested: [{ secret: '***' }, { bytes: new Uint8Array([1, 2]) }] });
  assert.equal(redactSecrets('short', ['short']), 'short');
  assert.notEqual(result, input);
});

test('допуск событий: проект фильтруется, удаление требует ранее увиденного id', (t) => {
  const { allowed, foreign, context } = fixture(t);
  const ownRun = waitingRunFixture(context.dataDir, allowed, { id: 'own-run', next: 'gate1' });
  const foreignRun = waitingRunFixture(context.dataDir, foreign, { id: 'foreign-run', next: 'gate1' });
  const ownChat = chat(context.dataDir, { id: 'own-chat', projectPath: allowed });
  const foreignChat = chat(context.dataDir, { id: 'foreign-chat', projectPath: foreign });
  const freeChat = chat(context.dataDir, { id: 'free-chat' });

  assert.equal(admitEvent(context, { type: 'run.updated', run: ownRun }), true);
  assert.equal(admitEvent(context, { type: 'run.updated', run: foreignRun }), false);
  assert.equal(admitEvent(context, { type: 'run.deleted', runId: 'unseen' }), false);
  assert.equal(admitEvent(context, { type: 'chat.updated', chat: ownChat, busy: false }), true);
  assert.equal(admitEvent(context, { type: 'chat.updated', chat: foreignChat, busy: false }), false);
  assert.equal(admitEvent(context, { type: 'chat.updated', chat: freeChat, busy: false }), false);
  assert.equal(admitEvent(context, { type: 'chat.deleted', chatId: 'unseen' }), false);

  const first = createAccessContext({ dataDir: context.dataDir, allowProject: context.allowProject });
  admitCall(first, 'dispatch', [{ type: 'run.delete', runId: ownRun.id, deleteBranch: false }]);
  assert.equal(admitEvent(first, { type: 'run.deleted', runId: ownRun.id }), true);
  admitCall(first, 'getChat', [ownChat.id]);
  assert.equal(admitEvent(first, { type: 'chat.deleted', chatId: ownChat.id }), true);
});

test('допуск событий: события с runId проверяются по текущей записи прогона', (t) => {
  const { allowed, foreign, context } = fixture(t);
  const ownRun: RunFile = waitingRunFixture(context.dataDir, allowed, { id: 'own-run', next: 'gate1' });
  waitingRunFixture(context.dataDir, foreign, { id: 'foreign-run', next: 'gate1' });
  assert.equal(admitEvent(context, { type: 'agent.output', runId: ownRun.id, stage: 'implement', text: 'текст' }), true);
  assert.equal(admitEvent(context, { type: 'agent.output', runId: 'foreign-run', stage: 'implement', text: 'текст' }), false);
  assert.equal(admitEvent(context, { type: 'agent.output', runId: 'missing', stage: 'implement', text: 'текст' }), false);
});
