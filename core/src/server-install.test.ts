import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { claudeEnv } from './agents/claude.js';
import { buildAgentEnv, loadServerConfig } from './server/config.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CHECKOUT = ROOT.replace(/[\\/]$/, '');
const linuxOnly = { skip: process.platform !== 'linux' };

function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-server-install-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function installConfig(dir: string, dataDir = path.join(dir, 'service-data')) {
  return {
    dataDir,
    promptsDir: path.join(CHECKOUT, 'core', 'prompts'),
    projects: [{ id: 'project', path: path.join(dir, 'project'), testCommand: 'node --version' }],
    publicOrigin: 'https://purpleflow.example.com',
    port: 4173,
    secretFile: path.join(dir, 'secret'),
    settings: {
      toolPaths: {
        claude: path.join(dir, 'bin', 'claude'),
        openspec: path.join(CHECKOUT, 'node_modules', '.bin', 'openspec'),
      },
      agents: { planner: 'claude', executor: 'claude', reviewer: 'claude' },
      enabledAgents: ['claude'],
    },
  };
}

function writeConfig(dir: string, value: unknown): string {
  const file = path.join(dir, 'server.json');
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  return file;
}

function substituted(file: string, replacements: Record<string, string>): string {
  let text = fs.readFileSync(file, 'utf8');
  for (const [placeholder, value] of Object.entries(replacements)) text = text.replaceAll(placeholder, value);
  return text;
}

function validateUnit(text: string): void {
  const values = new Map(
    text
      .split('\n')
      .map((line) => line.match(/^([A-Za-z]+)=(.*)$/) as [string, string] | null)
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => [match[1], match[2]]),
  );
  const command = values.get('ExecStart')?.split(' ') ?? [];
  assert.equal(command.length, 4);
  const [node, main, configFlag, config] = command;
  assert.ok(node && path.isAbsolute(node), 'исполняемый файл node должен быть абсолютным');
  assert.equal(path.basename(node), 'node');
  assert.equal(main, path.join(CHECKOUT, 'core', 'dist', 'server', 'main.js'));
  assert.ok(path.isAbsolute(main));
  assert.ok(fs.existsSync(main), 'сначала соберите core/dist/server/main.js');
  assert.equal(configFlag, '--config');
  assert.ok(config && path.isAbsolute(config), 'путь конфига должен быть абсолютным');
  assert.equal(values.get('KillMode'), 'control-group');
  assert.equal(values.get('Restart'), 'on-failure');
  assert.equal(values.get('WantedBy'), 'default.target');
}

test('пример unit совпадает со сборкой', linuxOnly, () => {
  const file = path.join(CHECKOUT, 'docs', 'server', 'purpleflow.service');
  const replacements = {
    __NODE__: process.execPath,
    __CHECKOUT__: CHECKOUT,
    __CONFIG__: path.join(CHECKOUT, 'purpleflow.json'),
  };
  const valid = substituted(file, replacements);
  validateUnit(valid);

  const execStart = valid.split('\n').find((line) => line.startsWith('ExecStart='));
  assert.ok(execStart);
  const invalid = [
    execStart.replace(process.execPath, 'node'),
    execStart.replace(path.join(CHECKOUT, 'core', 'dist', 'server', 'main.js'), 'core/dist/server/main.js'),
    execStart.replace(path.join(CHECKOUT, 'purpleflow.json'), 'purpleflow.json'),
  ];
  for (const command of invalid) {
    assert.throws(() => validateUnit(valid.replace(execStart, command)));
  }
});

function readExampleConfig(dir: string): { file: string; value: ReturnType<typeof installConfig> } {
  const secretFile = path.join(dir, 'secret');
  fs.writeFileSync(secretFile, 'секрет владельца', { mode: 0o600 });
  const text = substituted(path.join(CHECKOUT, 'docs', 'server', 'config.example.json'), {
    __CHECKOUT__: CHECKOUT,
    __DATA_DIR__: path.join(dir, 'service-data'),
    __PROJECT_DIR__: path.join(dir, 'project'),
    __SECRET_FILE__: secretFile,
    __CLAUDE__: path.join(dir, 'bin', 'claude'),
    __CODEX__: path.join(dir, 'bin', 'codex'),
  });
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, text, { mode: 0o600 });
  return { file, value: JSON.parse(text) as ReturnType<typeof installConfig> };
}

test('пример конфига разбирается loadServerConfig', linuxOnly, (t) => {
  const dir = tempDir(t);
  const { file, value } = readExampleConfig(dir);
  const config = loadServerConfig(file);
  assert.equal(config.dataDir, value.dataDir);
  assert.equal(config.promptsDir, value.promptsDir);
  assert.deepEqual(config.projects, value.projects);
  assert.equal(config.publicOrigin, value.publicOrigin);
  assert.equal(config.port, value.port);
  assert.equal(config.secretFile, value.secretFile);
  assert.deepEqual(config.settings.toolPaths, value.settings.toolPaths);
  assert.equal(config.settings.claudeAuth, 'login');
  assert.equal(config.telegram, undefined);
});

test('пример конфига: пути toolPaths абсолютные', linuxOnly, (t) => {
  const { value } = readExampleConfig(tempDir(t));
  for (const toolPath of Object.values(value.settings.toolPaths)) assert.ok(path.isAbsolute(toolPath), toolPath);
});

test('каталог данных настольного приложения отклоняется', linuxOnly, (t) => {
  const dir = tempDir(t);
  const xdg = path.join(dir, 'config');
  const previous = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    HOME: process.env.HOME,
    PURPLEFLOW_USER_DATA: process.env.PURPLEFLOW_USER_DATA,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.XDG_CONFIG_HOME = xdg;
  delete process.env.PURPLEFLOW_USER_DATA;

  const rejects = (dataDir: string) => {
    const file = writeConfig(dir, installConfig(dir, dataDir));
    assert.throws(() => loadServerConfig(file), /dataDir.*настольного приложения/);
  };

  rejects(path.join(xdg, 'PurpleFlow', 'data'));
  rejects(path.join(xdg, 'PS Flow', 'data'));

  const dangling = path.join(dir, 'pf-data');
  fs.symlinkSync(path.join(xdg, 'PurpleFlow', 'data'), dangling, 'dir');
  rejects(dangling);

  fs.mkdirSync(path.join(dir, 'x'));
  fs.symlinkSync(path.join(xdg, 'PurpleFlow', 'sub'), path.join(dir, 'x', 'link'), 'dir');
  rejects(`${dir}/x/link/../data`);

  fs.symlinkSync(path.join(xdg, 'PurpleFlow'), path.join(dir, 'pf-link'), 'dir');
  rejects(`${dir}/pf-missing/../pf-link/data`);

  fs.symlinkSync(path.join(dir, 'loop-b'), path.join(dir, 'loop-a'), 'dir');
  fs.symlinkSync(path.join(dir, 'loop-a'), path.join(dir, 'loop-b'), 'dir');
  const loop = writeConfig(dir, installConfig(dir, path.join(dir, 'loop-a')));
  assert.throws(() => loadServerConfig(loop), /слишком много символических ссылок/);

  fs.mkdirSync(xdg, { recursive: true });
  fs.writeFileSync(path.join(xdg, 'PurpleFlow'), 'не каталог');
  assert.doesNotThrow(() => loadServerConfig(writeConfig(dir, installConfig(dir))));

  process.env.PURPLEFLOW_USER_DATA = path.join(dir, 'desktop-profile');
  rejects(path.join(process.env.PURPLEFLOW_USER_DATA, 'data'));

  delete process.env.XDG_CONFIG_HOME;
  delete process.env.PURPLEFLOW_USER_DATA;
  process.env.HOME = dir;
  rejects(path.join(dir, '.config', 'PurpleFlow', 'data'));
  rejects(path.join(dir, '.config', 'PS Flow', 'data'));
  assert.doesNotThrow(() => loadServerConfig(writeConfig(dir, installConfig(dir, path.join(dir, 'separate-data')))));
});

test('вход через провайдера: переменная из ~/.bash_profile доходит до claude', { skip: process.platform !== 'linux' || !fs.existsSync('/bin/bash') }, (t) => {
  const home = tempDir(t);
  fs.writeFileSync(path.join(home, '.bash_profile'), 'export ANTHROPIC_BASE_URL=https://provider.example/\n', { mode: 0o600 });

  const env = buildAgentEnv({ HOME: home, USER: 'service', LOGNAME: 'service', SHELL: '/bin/bash' });
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://provider.example/');
  assert.equal(claudeEnv({ env, claudeAuth: 'env' }).ANTHROPIC_BASE_URL, 'https://provider.example/');
  assert.equal(claudeEnv({ env, claudeAuth: 'login' }).ANTHROPIC_BASE_URL, undefined);
});
