import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertEditorProduct, editors, readEditorProduct, nativeEditorSettingsPath } from '../../src/main/connect/core/editors.js';

const activeCommit = '1234567890abcdef1234567890abcdef12345678';
const oldCommit = 'abcdef1234567890abcdef1234567890abcdef12';
const version = `1.139.1\r\n${activeCommit}\r\nx64\r\n`;

function installation(action: (root: string, command: string) => void, launcher = 'bin/code.cmd') {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ai-editor-test-'));
  const directory = path.join(root, 'Microsoft VS Code');
  const command = path.join(directory, launcher);
  try {
    fs.mkdirSync(path.dirname(command), { recursive: true });
    fs.writeFileSync(command, '@echo off\r\n');
    action(directory, command);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function write(root: string, file: string, value: unknown) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
  return target;
}

for (const launcher of ['bin/code.cmd', 'Code.exe']) {
  test(`Windows legacy metadata remains readable: ${launcher}`, () =>
    installation((root, command) => {
      write(root, 'resources/app/product.json', { applicationName: 'code' });
      assert.equal(readEditorProduct(command, version)?.applicationName, 'code');
    }, launcher));

  test(`Windows active versioned metadata is found: ${launcher}`, () =>
    installation((root, command) => {
      write(root, `${activeCommit.slice(0, 10)}/resources/app/product.json`, { applicationName: 'code', nameShort: 'Active Code' });
      assert.equal(readEditorProduct(command, version)?.nameShort, 'Active Code');
    }, launcher));
}

test('Windows uses the active hash rather than stale versioned or flat metadata', () =>
  installation((root, command) => {
    write(root, `${oldCommit.slice(0, 10)}/resources/app/product.json`, { applicationName: 'devin', nameShort: 'Old installation' });
    write(root, 'resources/app/product.json', { applicationName: 'cursor', nameShort: 'Stale flat metadata' });
    write(root, `${activeCommit.slice(0, 10)}/resources/app/product.json`, { applicationName: 'code', nameShort: 'Active Code' });
    assert.equal(readEditorProduct(command, version)?.nameShort, 'Active Code');
  }));

for (const invalid of ['missing', 'invalid JSON', 'unreadable'] as const) {
  test(`Windows does not fall back to stale metadata when the active file is ${invalid}`, () =>
    installation((root, command) => {
      write(root, 'resources/app/product.json', { applicationName: 'code' });
      const activeFile = path.join(root, activeCommit.slice(0, 10), 'resources/app/product.json');
      fs.mkdirSync(path.dirname(activeFile), { recursive: true });
      if (invalid === 'invalid JSON') fs.writeFileSync(activeFile, '{broken');
      if (invalid === 'unreadable') fs.mkdirSync(activeFile);
      const diagnostics: string[] = [];
      assert.equal(readEditorProduct(command, version, diagnostics), undefined);
      assert.ok(diagnostics.some((line) => line.includes(activeFile)));
      assert.match(
        diagnostics.join('\n'),
        invalid === 'missing' ? /не найден/ : invalid === 'invalid JSON' ? /некорректный JSON/ : /не удалось прочитать/,
      );
    }));
}

test('Windows never chooses a random versioned folder when --version contains no valid hash', () =>
  installation((root, command) => {
    write(root, `${oldCommit.slice(0, 10)}/resources/app/product.json`, { applicationName: 'code' });
    const diagnostics: string[] = [];
    assert.equal(readEditorProduct(command, '1.139.1\nx64\n', diagnostics), undefined);
    assert.match(diagnostics.join('\n'), /хеш/);
  }));

test('Windows rejects another product even when legacy metadata says Code', () =>
  installation((root, command) => {
    write(root, 'resources/app/product.json', { applicationName: 'code' });
    write(root, `${activeCommit.slice(0, 10)}/resources/app/product.json`, { applicationName: 'devin', nameShort: 'Devin' });
    assert.throws(() => assertEditorProduct(editors[0]!, readEditorProduct(command, version)), /найден Devin/);
  }));

test('missing metadata error includes the launcher and checked paths', () =>
  installation((_root, command) => {
    const diagnostics: string[] = [];
    const product = readEditorProduct(command, version, diagnostics);
    assert.throws(
      () => assertEditorProduct(editors[0]!, product, { command, diagnostics }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(command));
        assert.ok(error.message.includes('product.json'));
        assert.match(error.message, /не найден/);
        return true;
      },
    );
  }));

test('a malformed legacy candidate does not hide another readable candidate', () =>
  installation((root, command) => {
    write(root, 'resources/app/product.json', '{broken');
    write(root, 'product.json', { applicationName: 'code' });
    assert.equal(readEditorProduct(command)?.applicationName, 'code');
  }));

test('product metadata accepts UTF-8 BOM and rejects missing applicationName', () =>
  installation((root, command) => {
    const file = write(root, 'resources/app/product.json', '\ufeff{"applicationName":"code"}');
    assert.equal(readEditorProduct(command)?.applicationName, 'code');
    for (const value of [null, [], { nameShort: 'Code' }, { applicationName: 42 }]) {
      fs.writeFileSync(file, JSON.stringify(value));
      const diagnostics: string[] = [];
      assert.equal(readEditorProduct(command, version, diagnostics), undefined);
      assert.ok(diagnostics.some((line) => line.includes(file)));
    }
  }));

for (const launcher of ['bin/code.cmd', 'Code.exe', 'bin/code']) {
  test(`portable settings stay beside the installation: ${launcher}`, () =>
    installation((root, command) => {
      fs.mkdirSync(path.join(root, 'data'));
      assert.equal(
        nativeEditorSettingsPath(editors[0]!, command, { applicationName: 'code' }),
        path.join(root, 'data/user-data/User/settings.json'),
      );
    }, launcher));
}

test('macOS portable storage is beside the application bundle', () =>
  installation((root, command) => {
    const portable = path.join(root, 'custom-portable-data');
    fs.mkdirSync(portable);
    assert.equal(
      nativeEditorSettingsPath(editors[0]!, command, { portable: 'custom-portable-data' }),
      path.join(portable, 'user-data/User/settings.json'),
    );
  }, 'Visual Studio Code.app/Contents/Resources/app/bin/code'));

test('Windows installers ignore portable data, while unverified forks stop', () =>
  installation((root, command) => {
    fs.mkdirSync(path.join(root, 'data'));
    assert.ok(!nativeEditorSettingsPath(editors[0]!, command, { target: 'user' }).startsWith(path.join(root, 'data')));
    assert.throws(() => nativeEditorSettingsPath(editors[1]!, command, { applicationName: 'cursor' }), /ручной проверки/);
  }));

test('portable override is used only when it is an existing absolute directory', () =>
  installation((root, command) => {
    const previous = process.env.VSCODE_PORTABLE;
    try {
      const portable = path.join(root, 'custom-data');
      fs.mkdirSync(portable);
      process.env.VSCODE_PORTABLE = portable;
      assert.equal(nativeEditorSettingsPath(editors[0]!, command), path.join(portable, 'user-data/User/settings.json'));
      process.env.VSCODE_PORTABLE = 'relative-data';
      assert.throws(() => nativeEditorSettingsPath(editors[0]!, command), /абсолютный путь/);
      process.env.VSCODE_PORTABLE = path.join(root, 'missing-data');
      assert.throws(() => nativeEditorSettingsPath(editors[0]!, command), /не найден/);
    } finally {
      if (previous === undefined) delete process.env.VSCODE_PORTABLE;
      else process.env.VSCODE_PORTABLE = previous;
    }
  }));
