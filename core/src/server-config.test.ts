import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildAgentEnv, loadServerConfig, readSecret, SERVER_DEFAULTS } from './server/config.js';

function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-server-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeConfig(dir: string, value: unknown): string {
  const file = path.join(dir, 'server.json');
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function minimalConfig(dir: string) {
  return {
    dataDir: path.join(dir, 'data'),
    projects: [{ id: 'project-1', path: path.join(dir, 'project') }],
    publicOrigin: 'https://purpleflow.example.com',
    port: 4173,
    secretFile: path.join(dir, 'secret'),
  };
}

test('конфиг: минимальный файл даёт значения по умолчанию и пустой proxy', (t) => {
  const dir = tempDir(t);
  const file = writeConfig(dir, minimalConfig(dir));

  const config = loadServerConfig(file);

  assert.deepEqual(config, {
    ...minimalConfig(dir),
    promptsDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts'),
    settings: {
      toolPaths: {},
      proxy: { baseUrl: '', apiKey: '' },
      models: { planner: 'opus', executor: 'sonnet', reviewer: '', visual: '', manager: '', scan: '' },
      efforts: {},
      agents: { planner: 'claude', executor: 'claude', reviewer: 'codex' },
      enabledAgents: ['claude', 'codex'],
      claudeAuth: 'login',
      userConfig: true,
      maxParallel: 2,
      agentTimeoutMin: 30,
      testTimeoutMin: 10,
    },
  });
});

function assertConfigError(file: string, field: string, forbidden?: string): void {
  assert.throws(
    () => loadServerConfig(file),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(file), error.message);
      assert.ok(error.message.includes(field), error.message);
      if (forbidden) assert.ok(!error.message.includes(forbidden), error.message);
      return true;
    },
  );
}

test('конфиг: повреждённый JSON — ошибка называет файл и не содержит метку из содержимого', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'broken.json');
  const marker = 'метка-из-содержимого';
  fs.writeFileSync(file, `{"dataDir":"${marker}",`);

  assertConfigError(file, 'JSON', marker);
});

test('конфиг: неизвестный ключ, относительный путь, повтор и границы id, origin, порт и proxy отклонены с путём поля', (t) => {
  const dir = tempDir(t);
  const base = minimalConfig(dir);
  const project = (id: string, projectPath = path.join(dir, id)) => ({ id, path: projectPath });
  const cases: { value: unknown; field: string }[] = [
    { value: { ...base, unknown: true }, field: 'unknown' },
    { value: { ...base, dataDir: 'relative/data' }, field: 'dataDir' },
    { value: { ...base, promptsDir: 'relative/prompts' }, field: 'promptsDir' },
    { value: { ...base, secretFile: 'relative/secret' }, field: 'secretFile' },
    { value: { ...base, projects: [] }, field: 'projects' },
    { value: { ...base, projects: [{ id: 'p1' }] }, field: 'projects[0].path' },
    { value: { ...base, projects: [project('p1'), project('p1')] }, field: 'projects[1].id' },
    ...['team/a', 'a..b', 'p1\n', 'p1\r\n', 'p1\u2028'].map((id) => ({
      value: { ...base, projects: [project(id)] },
      field: 'projects[0].id',
    })),
    { value: { ...base, projects: [{ ...project('p1'), extra: true }] }, field: 'projects[0].extra' },
    { value: { ...base, publicOrigin: 'https://purpleflow.example.com/path' }, field: 'publicOrigin' },
    { value: { ...base, publicOrigin: 'http://purpleflow.example.com' }, field: 'publicOrigin' },
    { value: { ...base, publicOrigin: 'не URL' }, field: 'publicOrigin' },
    { value: { ...base, port: 0 }, field: 'port' },
    { value: { ...base, proxy: { baseUrl: '', apiKey: '' } }, field: 'proxy' },
    { value: { ...base, settings: { proxy: { baseUrl: '', apiKey: '' } } }, field: 'settings.proxy' },
  ];

  for (const [index, item] of cases.entries()) {
    const file = writeConfig(dir, item.value);
    assert.throws(
      () => loadServerConfig(file),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(file), `случай ${index}: ${error.message}`);
        assert.ok(error.message.includes(item.field), `случай ${index}: ${error.message}`);
        return true;
      },
    );
  }
});

test('конфиг: неверные models, agents и claudeAuth отклонены с полным путём поля', (t) => {
  const dir = tempDir(t);
  const base = minimalConfig(dir);
  const cases: { settings: unknown; field: string }[] = [
    { settings: { models: null }, field: 'settings.models' },
    { settings: { models: { planner: 42 } }, field: 'settings.models.planner' },
    { settings: { models: { foo: 'opus' } }, field: 'settings.models.foo' },
    { settings: { agents: { planner: 'gpt' } }, field: 'settings.agents.planner' },
    { settings: { agents: { visual: 'agy' } }, field: 'settings.agents.visual' },
    { settings: { claudeAuth: 'env' }, field: 'settings.claudeAuth' },
  ];

  for (const item of cases) {
    const file = writeConfig(dir, { ...base, settings: item.settings });
    assertConfigError(file, item.field);
  }
});

test('конфиг: частичные settings.models и settings.agents независимо сохраняют остальные значения по умолчанию', (t) => {
  const dir = tempDir(t);
  const file = writeConfig(dir, {
    ...minimalConfig(dir),
    settings: { models: { planner: 'custom-planner' }, agents: { visual: 'opencode' } },
  });

  const config = loadServerConfig(file);

  assert.deepEqual(config.settings.models, { ...SERVER_DEFAULTS.models, planner: 'custom-planner' });
  assert.deepEqual(config.settings.agents, { ...SERVER_DEFAULTS.agents, visual: 'opencode' });
  assert.deepEqual(config.settings.proxy, { baseUrl: '', apiKey: '' });
});

test('секрет: пустой файл и файл с правами 0644 отклонены, текст ошибки без секрета', { skip: process.platform !== 'linux' }, (t) => {
  const dir = tempDir(t);
  const empty = path.join(dir, 'empty');
  fs.writeFileSync(empty, '', { mode: 0o600 });
  assert.throws(() => readSecret(empty), /пуст/);

  const insecure = path.join(dir, 'insecure');
  const secret = 'секретная-метка';
  fs.writeFileSync(insecure, secret, { mode: 0o644 });
  assert.throws(
    () => readSecret(insecure),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(secret), error.message);
      return true;
    },
  );
});

test(
  'секрет: файл 0600 читается обрезанным, после исправления прав 0644 → 0600 повторный вызов успешен',
  { skip: process.platform !== 'linux' },
  (t) => {
    const dir = tempDir(t);
    const file = path.join(dir, 'secret');
    const secret = 'секрет-с-пробелами';
    fs.writeFileSync(file, `  ${secret}\n`, { mode: 0o600 });
    assert.equal(readSecret(file), secret);

    fs.chmodSync(file, 0o644);
    assert.throws(
      () => readSecret(file),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes(secret), error.message);
        return true;
      },
    );
    fs.chmodSync(file, 0o600);
    assert.equal(readSecret(file), secret);
  },
);

test(
  'окружение агента: переменная службы не проходит ни через login shell, ни через запасной путь, а запасной путь содержит системный PATH',
  { skip: process.platform !== 'linux' },
  (t) => {
    const dir = tempDir(t);
    const shell = path.join(dir, 'sh');
    fs.writeFileSync(shell, '#!/bin/sh\nexec /bin/sh -c "$2"\n', { mode: 0o755 });
    const base = {
      SHELL: shell,
      HOME: dir,
      PATH: '/opt/service-bin',
      HTTPS_PROXY: 'http://127.0.0.1:8899',
      SERVICE_MARKER: 'не-передавать',
      ANTHROPIC_API_KEY: 'не-передавать',
    };

    const loginEnv = buildAgentEnv(base);
    assert.equal(loginEnv.SERVICE_MARKER, undefined);
    assert.equal(loginEnv.ANTHROPIC_API_KEY, undefined);
    assert.equal(loginEnv.HTTPS_PROXY, 'http://127.0.0.1:8899');
    assert.ok(!loginEnv.PATH?.includes('/opt/service-bin'));

    const fallbackEnv = buildAgentEnv({ ...base, SHELL: path.join(dir, 'missing-shell') });
    assert.equal(fallbackEnv.SERVICE_MARKER, undefined);
    assert.equal(fallbackEnv.ANTHROPIC_API_KEY, undefined);
    const fallbackPath = fallbackEnv.PATH;
    assert.ok(fallbackPath);
    assert.ok(fallbackPath.includes('/usr/bin'));
    assert.ok(fallbackPath.includes('/bin'));
    assert.ok(!fallbackPath.includes('/opt/service-bin'));
  },
);

test('конфиг: остальные разделы settings проходят белый список, скаляры и enabledAgents заменяются', (t) => {
  const dir = tempDir(t);
  const promptsDir = path.join(dir, 'custom-prompts');
  const file = writeConfig(dir, {
    ...minimalConfig(dir),
    promptsDir,
    settings: {
      toolPaths: { git: path.join(dir, 'git') },
      efforts: { executor: 'high' },
      agents: { executor: 'codex', manager: 'codex' },
      enabledAgents: ['codex'],
      claudeAuth: 'login',
      userConfig: false,
      maxParallel: 8,
      agentTimeoutMin: 45,
      testTimeoutMin: 15,
    },
  });

  const config = loadServerConfig(file);

  assert.equal(config.promptsDir, promptsDir);
  assert.deepEqual(config.settings, {
    ...SERVER_DEFAULTS,
    toolPaths: { git: path.join(dir, 'git') },
    efforts: { executor: 'high' },
    agents: { ...SERVER_DEFAULTS.agents, executor: 'codex', manager: 'codex' },
    enabledAgents: ['codex'],
    claudeAuth: 'login',
    userConfig: false,
    maxParallel: 8,
    agentTimeoutMin: 45,
    testTimeoutMin: 15,
    proxy: { baseUrl: '', apiKey: '' },
  });
});

test('конфиг: типы и диапазоны остальных полей проверяются рекурсивно', (t) => {
  const dir = tempDir(t);
  const base = minimalConfig(dir);
  const cases: { value: unknown; field: string }[] = [
    { value: null, field: '<корень>' },
    { value: [], field: '<корень>' },
    { value: { ...base, projects: [{ id: 'p1', path: 'relative' }] }, field: 'projects[0].path' },
    { value: { ...base, publicOrigin: null }, field: 'publicOrigin' },
    { value: { ...base, port: 65536 }, field: 'port' },
    { value: { ...base, port: 1.5 }, field: 'port' },
    { value: { ...base, settings: null }, field: 'settings' },
    { value: { ...base, settings: [] }, field: 'settings' },
    { value: { ...base, settings: { unknown: true } }, field: 'settings.unknown' },
    { value: { ...base, settings: { toolPaths: null } }, field: 'settings.toolPaths' },
    { value: { ...base, settings: { toolPaths: { unknown: '/bin/tool' } } }, field: 'settings.toolPaths.unknown' },
    { value: { ...base, settings: { toolPaths: { git: 42 } } }, field: 'settings.toolPaths.git' },
    { value: { ...base, settings: { efforts: null } }, field: 'settings.efforts' },
    { value: { ...base, settings: { efforts: { visual: 'high' } } }, field: 'settings.efforts.visual' },
    { value: { ...base, settings: { efforts: { planner: 42 } } }, field: 'settings.efforts.planner' },
    { value: { ...base, settings: { agents: null } }, field: 'settings.agents' },
    { value: { ...base, settings: { agents: { unknown: 'claude' } } }, field: 'settings.agents.unknown' },
    { value: { ...base, settings: { enabledAgents: 'claude' } }, field: 'settings.enabledAgents' },
    { value: { ...base, settings: { enabledAgents: ['gpt'] } }, field: 'settings.enabledAgents[0]' },
    { value: { ...base, settings: { enabledAgents: ['claude', 'claude'] } }, field: 'settings.enabledAgents[1]' },
    { value: { ...base, settings: { userConfig: 'true' } }, field: 'settings.userConfig' },
    { value: { ...base, settings: { maxParallel: 0 } }, field: 'settings.maxParallel' },
    { value: { ...base, settings: { maxParallel: 9 } }, field: 'settings.maxParallel' },
    { value: { ...base, settings: { maxParallel: 1.5 } }, field: 'settings.maxParallel' },
    { value: { ...base, settings: { agentTimeoutMin: 0 } }, field: 'settings.agentTimeoutMin' },
    { value: { ...base, settings: { agentTimeoutMin: 1.5 } }, field: 'settings.agentTimeoutMin' },
    { value: { ...base, settings: { testTimeoutMin: 0 } }, field: 'settings.testTimeoutMin' },
  ];

  for (const item of cases) {
    const file = writeConfig(dir, item.value);
    assertConfigError(file, item.field);
  }
});
