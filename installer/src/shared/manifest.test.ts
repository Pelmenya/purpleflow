import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assetUrl, parseManifest, pickAsset } from './manifest';

const MAC = `version: 0.7.0
files:
  - url: PurpleFlow-0.7.0-mac.zip
    sha512: AAA==
    size: 140098420
  - url: PurpleFlow-0.7.0-arm64-mac.zip
    sha512: BBB==
    size: 133138019
  - url: PurpleFlow-0.7.0-arm64.dmg
    sha512: CCC==
    size: 134365741
path: PurpleFlow-0.7.0-mac.zip
sha512: AAA==
releaseDate: '2026-11-23T13:11:24.728Z'
`;

const WIN = `version: 0.7.0
files:
  - url: PurpleFlow-Setup-0.7.0.exe
    sha512: ALL==
    size: 225037971
  - url: PurpleFlow-Setup-0.7.0-x64.exe
    sha512: X64==
    size: 115896529
  - url: PurpleFlow-Setup-0.7.0-arm64.exe
    sha512: ARM==
    size: 109786672
path: PurpleFlow-Setup-0.7.0.exe
`;

const LINUX = `version: 0.7.0
files:
  - url: PurpleFlow-0.7.0-x86_64.AppImage
    sha512: APP==
    size: 131414061
    blockMapSize: 137281
  - url: PurpleFlow-0.7.0-amd64.deb
    sha512: DEB==
    size: 104836556
path: PurpleFlow-0.7.0-x86_64.AppImage
`;

test('разбирает версию и файлы, не путая их с полями верхнего уровня', () => {
  const m = parseManifest(MAC);
  assert.equal(m.version, '0.7.0');
  assert.deepEqual(
    m.files.map((f) => [f.url, f.sha512, f.size]),
    [
      ['PurpleFlow-0.7.0-mac.zip', 'AAA==', 140098420],
      ['PurpleFlow-0.7.0-arm64-mac.zip', 'BBB==', 133138019],
      ['PurpleFlow-0.7.0-arm64.dmg', 'CCC==', 134365741],
    ],
  );
});

test('без версии — ошибка, а не пустой выпуск', () => {
  assert.throws(() => parseManifest('files: []\n'));
});

test('macOS: zip под архитектуру процессора', () => {
  const m = parseManifest(MAC);
  assert.equal(pickAsset(m, 'darwin', 'arm64')?.url, 'PurpleFlow-0.7.0-arm64-mac.zip');
  assert.equal(pickAsset(m, 'darwin', 'x64')?.url, 'PurpleFlow-0.7.0-mac.zip');
});

test('Windows: установщик своей архитектуры, а не общий на две', () => {
  const m = parseManifest(WIN);
  assert.equal(pickAsset(m, 'win32', 'x64')?.sha512, 'X64==');
  assert.equal(pickAsset(m, 'win32', 'arm64')?.sha512, 'ARM==');
  assert.equal(pickAsset(m, 'win32', 'ia32'), null);
});

test('Linux: AppImage; для arm64 сборки нет', () => {
  const m = parseManifest(LINUX);
  assert.equal(pickAsset(m, 'linux', 'x64')?.kind, 'appimage');
  assert.equal(pickAsset(m, 'linux', 'arm64'), null);
});

test('ссылка на файл ведёт на конкретную версию', () => {
  const a = pickAsset(parseManifest(MAC), 'darwin', 'arm64')!;
  assert.equal(assetUrl(a), 'https://github.com/PurpleSchool/purpleflow/releases/download/0.7.0/PurpleFlow-0.7.0-arm64-mac.zip');
});

test('GUID установки PurpleFlow на Windows совпадает с тем, что считает electron-builder', async () => {
  const { PURPLEFLOW_WIN_GUID } = await import('./manifest');
  const { UUID } = await import('builder-util-runtime');
  const fs = await import('node:fs');
  const yml = fs.readFileSync(new URL('../../../app/electron-builder.yml', import.meta.url), 'utf8');
  const appId = /^appId:\s*(\S+)/m.exec(yml)![1]!;
  // То же пространство имён, что ELECTRON_BUILDER_NS_UUID в app-builder-lib (targets/nsis/NsisTarget).
  assert.equal(UUID.v5(appId, UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3')), PURPLEFLOW_WIN_GUID);
});

test('путь установки читается из вывода reg query', async () => {
  const { parseRegValue } = await import('./manifest');
  const out =
    '\r\nHKEY_CURRENT_USER\\Software\\a211f1fe-28a4-5d3d-9110-7a8aa8fd497e\r\n    InstallLocation    REG_SZ    D:\\Apps\\Purple Flow\r\n\r\n';
  assert.equal(parseRegValue(out, 'InstallLocation'), 'D:\\Apps\\Purple Flow');
  assert.equal(parseRegValue(out, 'ShortcutName'), undefined);
});

test('файл обновления установщика — под систему, архитектуру и способ установки', async () => {
  const { installerAssetName } = await import('./manifest');
  assert.equal(installerAssetName('darwin', 'arm64'), 'PurpleFlow-Installer.dmg');
  assert.equal(installerAssetName('win32', 'x64'), 'PurpleFlow-Installer-x64.exe');
  assert.equal(installerAssetName('win32', 'arm64'), 'PurpleFlow-Installer-arm64.exe');
  assert.equal(installerAssetName('win32', 'ia32'), null);
  assert.equal(installerAssetName('linux', 'x64', 'deb'), 'PurpleFlow-Installer-amd64.deb');
  assert.equal(installerAssetName('linux', 'x64', 'rpm'), 'PurpleFlow-Installer-x86_64.rpm');
  assert.equal(installerAssetName('linux', 'x64', 'appimage'), 'PurpleFlow-Installer-x86_64.AppImage');
  assert.equal(installerAssetName('linux', 'arm64', 'deb'), null);
});

test('сравнение версий установщика', async () => {
  const { isNewerVersion } = await import('./manifest');
  assert.equal(isNewerVersion('0.9.0', '0.8.0'), true);
  assert.equal(isNewerVersion('0.10.0', '0.9.9'), true);
  assert.equal(isNewerVersion('0.8.0', '0.8.0'), false);
  assert.equal(isNewerVersion('0.7.9', '0.8.0'), false);
  assert.equal(isNewerVersion('0.8.0', '0.8.0-beta.1'), true);
  assert.equal(isNewerVersion('0.8.0-beta.1', '0.8.0'), false);
  assert.equal(isNewerVersion('v1.0.0', '0.9.0'), true);
});
