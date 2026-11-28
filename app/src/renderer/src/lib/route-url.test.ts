import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { View } from './reducer';
import { pathToView, viewToPath } from './route-url';

const routes: Array<[View, string]> = [
  [{ name: 'new' }, '/'],
  [{ name: 'new', project: '/tmp/demo' }, '/?project=%2Ftmp%2Fdemo'],
  [{ name: 'run', runId: 'r1' }, '/runs/r1'],
  [{ name: 'run', runId: 'r1', tab: 'log' }, '/runs/r1/log'],
  [{ name: 'settings' }, '/settings'],
  [{ name: 'settings', tab: 'models' }, '/settings/models'],
  [{ name: 'start' }, '/start'],
  [{ name: 'chat' }, '/chats'],
  [{ name: 'chat', project: '/tmp/demo' }, '/chats?project=%2Ftmp%2Fdemo'],
  [{ name: 'chat', chatId: 'c1' }, '/chats/c1'],
  [{ name: 'projects' }, '/projects'],
  [{ name: 'project', path: '/tmp/demo' }, '/projects/%2Ftmp%2Fdemo'],
  [{ name: 'project', path: '/tmp/demo', tab: 'git' }, '/projects/%2Ftmp%2Fdemo/git'],
];

test('route-url: круговой перевод всех постоянных экранов', () => {
  for (const [view, path] of routes) {
    assert.equal(viewToPath(view), path);
    const url = new URL(path, 'http://localhost');
    assert.deepEqual(pathToView(url.pathname, url.search), view);
  }
  assert.equal(viewToPath({ name: 'welcome' }), '/');
});

test('route-url: путь проекта сохраняет пробелы, служебные символы и кириллицу', () => {
  const view: View = { name: 'project', path: '/tmp/мой проект #1?', tab: 'commands' };
  const path = viewToPath(view);
  assert.equal(path, '/projects/%2Ftmp%2F%D0%BC%D0%BE%D0%B9%20%D0%BF%D1%80%D0%BE%D0%B5%D0%BA%D1%82%20%231%3F/commands');
  const url = new URL(path, 'http://localhost');
  assert.deepEqual(pathToView(url.pathname, url.search), view);
});

test('route-url: временные поля и неизвестные вкладки в адрес не попадают', () => {
  assert.equal(viewToPath({ name: 'chat', project: '/tmp/demo', text: 'не сохраняется' }), '/chats?project=%2Ftmp%2Fdemo');
  assert.deepEqual(pathToView('/settings/unknown', ''), { name: 'settings' });
  assert.deepEqual(pathToView('/projects/%2Ftmp%2Fdemo/unknown', ''), { name: 'project', path: '/tmp/demo' });
});

test('route-url: неизвестный или испорченный адрес открывает новую задачу без исключения', () => {
  for (const [pathname, search] of [
    ['/unknown', ''],
    ['/runs/', ''],
    ['/runs/r1/', ''],
    ['/settings/', ''],
    ['/projects/%2Ftmp%2Fdemo/', ''],
    ['/projects/%E0%A4%A', ''],
    ['/', '?project=%E0%A4%A'],
  ] as const) {
    assert.deepEqual(pathToView(pathname, search), { name: 'new' });
  }
});
