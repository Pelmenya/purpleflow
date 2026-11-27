import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import { renderAcceptance } from './server/accept-page.js';
import { loadServerConfig } from './server/config.js';
import { createServerApp } from './server/main.js';
import {
  Browser,
  listen,
  makeServerStand,
  postDecision,
  serverTestsSkip,
  startTestHost,
  untilGate,
  waitingRunFixture,
} from './server-testkit.test.js';

function deferred(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

async function acceptanceFixture(t: TestContext, opts: { testCommand?: string } = {}) {
  const stand = makeServerStand(opts);
  const config = loadServerConfig(stand.configFile);
  const fixture = await startTestHost({ dataDir: stand.dataDir, settings: config.settings, project: stand.project });
  t.after(() => fixture.close());
  const origin = await listen(t, createServerApp(config, fixture.host));
  const first = new Browser();
  const second = new Browser();
  assert.equal((await first.login(origin)).status, 303);
  assert.equal((await second.login(origin)).status, 303);
  return { ...fixture, stand, config, origin, first, second };
}

async function waitingAcceptanceFixture(t: TestContext) {
  const fixture = await acceptanceFixture(t);
  const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture.stand.root, encoding: 'utf8' }).trim();
  const run = waitingRunFixture(fixture.dataDir, fixture.stand.root, { next: 'gate2', baseCommit });
  return { ...fixture, run };
}

test('приёмка: второй клиент видит дифф, последние проверки и ревью', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const fixture = await acceptanceFixture(t);
  const started = await fixture.host.startTask('p1', {
    task: 'Добавь функцию mul в src/math.js',
    submissionId: crypto.randomUUID(),
  });
  assert.equal(started.status, 'started');
  const runId = started.status === 'started' ? started.runId : '';
  const gate1 = await untilGate(fixture.core, runId, 'gate1');
  assert.equal(
    (await postDecision(fixture.first, fixture.origin, runId, { expectedWaitId: gate1.waitId!, action: 'approve' })).status,
    303,
  );
  await untilGate(fixture.core, runId, 'gate2');

  const response = await fixture.second.request(fixture.origin, `/runs/${runId}`);
  assert.equal(response.status, 200);
  const page = await response.text();
  const run = (await fixture.core.getRun(runId))!;
  const latestTest = run.tests.at(-1)!;
  assert.match(page, /src\/math\.js/);
  assert.match(page, /export const add = \(a, b\) =&gt; a \+ b;/);
  assert.match(page, /export const mul = \(a, b\) =&gt; a \* b;/);
  assert.match(page, new RegExp(latestTest.command));
  assert.ok(page.includes(latestTest.output.trim()));
  assert.match(page, /Ревью/);
});

test('renderAcceptance: последняя запись, экранирование, пустые и двоичные', { skip: serverTestsSkip }, () => {
  const stand = makeServerStand();
  const run = waitingRunFixture(stand.dataDir, stand.root, {
    next: 'gate2',
    tests: [
      { at: '1', command: 'старая команда', passed: false, exitCode: 1, durationMs: 1, output: 'старый вывод' },
      { at: '2', command: 'новая <script>&"', passed: true, exitCode: 0, durationMs: 1, output: 'новый <script>&"' },
    ],
    reviews: [
      { at: '1', blocking: [], notes: [{ file: 'old.js', line: 1, message: 'старое ревью' }] },
      {
        at: '2',
        blocking: [{ file: null, line: null, message: 'блокер <script>&"' }],
        notes: [{ file: 'new.js', line: 7, message: 'заметка <script>&"' }],
      },
    ],
  });
  const page = renderAcceptance(
    run,
    [{ path: 'image.png', status: 'M', original: 'не показывать исходник', modified: 'не показывать бинарь', binary: true }],
    'shown-wait',
  );
  assert.ok(!page.includes('старая команда'));
  assert.ok(!page.includes('старый вывод'));
  assert.ok(!page.includes('старое ревью'));
  assert.ok(page.includes('новая &lt;script&gt;&amp;&quot;'));
  assert.ok(page.includes('новый &lt;script&gt;&amp;&quot;'));
  assert.ok(page.includes('блокер &lt;script&gt;&amp;&quot;'));
  assert.ok(page.includes('заметка &lt;script&gt;&amp;&quot;'));
  assert.ok(page.includes('—:—'));
  assert.ok(page.includes('двоичный файл'));
  assert.ok(!page.includes('не показывать исходник'));
  assert.ok(!page.includes('не показывать бинарь'));
  assert.ok(page.includes('value="shown-wait"'));

  const empty = renderAcceptance({ ...run, tests: [], reviews: [] }, [], 'shown-wait');
  assert.match(empty, /Проверка не запускалась/);
  assert.match(empty, /Ревью не было/);
});

test('приёмка: дифф меняется во время чтения', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const once = await waitingAcceptanceFixture(t);
  const entered = deferred();
  const release = deferred();
  const original = once.core.getDiff.bind(once.core);
  let calls = 0;
  t.mock.method(once.core, 'getDiff', async (id: string) => {
    calls++;
    if (calls === 1) {
      entered.open();
      await release.promise;
    }
    return original(id);
  });
  const pending = once.second.request(once.origin, `/runs/${once.run.id}`);
  await entered.promise;
  once.core.kernel.save({ ...once.run, waitId: 'new-wait' });
  release.open();
  const response = await pending;
  assert.equal(response.status, 200);
  const page = await response.text();
  assert.ok(page.includes('value="new-wait"'));
  assert.ok(!page.includes(`value="${once.run.waitId}"`));

  const unstable = await waitingAcceptanceFixture(t);
  const originalUnstable = unstable.core.getDiff.bind(unstable.core);
  let unstableCalls = 0;
  t.mock.method(unstable.core, 'getDiff', async (id: string) => {
    unstableCalls++;
    const current = (await unstable.core.getRun(id))!;
    unstable.core.kernel.save({ ...current, waitId: `changed-${unstableCalls}` });
    return originalUnstable(id);
  });
  const changing = await unstable.second.request(unstable.origin, `/runs/${unstable.run.id}`);
  assert.equal(changing.status, 200);
  const changingPage = await changing.text();
  assert.match(changingPage, /Дифф меняется — обновите страницу/);
  assert.ok(!changingPage.includes('name="action"'));
  assert.equal(unstableCalls, 3);
});

test('приёмка: прогон удалён во время чтения диффа', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const fixture = await waitingAcceptanceFixture(t);
  const entered = deferred();
  const release = deferred();
  const original = fixture.core.getDiff.bind(fixture.core);
  t.mock.method(fixture.core, 'getDiff', async (id: string) => {
    entered.open();
    await release.promise;
    return original(id);
  });
  const pending = fixture.second.request(fixture.origin, `/runs/${fixture.run.id}`);
  await entered.promise;
  try {
    await fixture.core.dispatch({ type: 'run.delete', runId: fixture.run.id, deleteBranch: false });
  } finally {
    release.open();
  }
  const response = await pending;
  assert.equal(response.status, 404);
});

test('приёмка: ошибка диффа при существующем прогоне не маскируется', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const fixture = await waitingAcceptanceFixture(t);
  t.mock.method(fixture.core, 'getDiff', async () => {
    throw new Error('дифф недоступен');
  });
  const response = await fixture.second.request(fixture.origin, `/runs/${fixture.run.id}`);
  assert.equal(response.status, 500);
  assert.ok(await fixture.core.getRun(fixture.run.id));
});

async function runToGate2(fixture: Awaited<ReturnType<typeof acceptanceFixture>>) {
  const started = await fixture.host.startTask('p1', {
    task: 'Добавь функцию mul в src/math.js',
    submissionId: crypto.randomUUID(),
  });
  assert.equal(started.status, 'started');
  const runId = started.status === 'started' ? started.runId : '';
  const gate1 = await untilGate(fixture.core, runId, 'gate1');
  assert.equal(
    (await postDecision(fixture.first, fixture.origin, runId, { expectedWaitId: gate1.waitId!, action: 'approve' })).status,
    303,
  );
  const gate2 = await untilGate(fixture.core, runId, 'gate2');
  return { runId, gate2 };
}

test('приёмка: повтор и устаревшая форма', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const fixture = await acceptanceFixture(t);
  const { runId, gate2 } = await runToGate2(fixture);
  const fields = { expectedWaitId: gate2.waitId!, action: 'approve' };
  assert.equal((await postDecision(fixture.first, fixture.origin, runId, fields)).status, 303);

  const repeated = await postDecision(fixture.second, fixture.origin, runId, fields);
  assert.equal(repeated.status, 409);
  const repeatedPage = await repeated.text();
  assert.match(repeatedPage, /Решение уже принято на другом устройстве/);
  const current = (await fixture.core.getRun(runId))!;
  assert.match(repeatedPage, new RegExp(`data-status="${current.status}"`));
  assert.match(repeatedPage, new RegExp(`<dt>Стадия</dt><dd>${current.next}</dd>`));
  assert.equal(current.gates.filter((gate) => gate.gate === 'gate2').length, 1);

  const stale = await postDecision(fixture.second, fixture.origin, runId, {
    expectedWaitId: gate2.waitId!,
    action: 'reject',
    comment: 'Поздний возврат',
  });
  assert.equal(stale.status, 409);
  const staleEmpty = await postDecision(fixture.second, fixture.origin, runId, {
    expectedWaitId: gate2.waitId!,
    action: 'reject',
    comment: '   ',
  });
  assert.equal(staleEmpty.status, 409);
});

test('приёмка: принятие даёт коммит в ветке', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const fixture = await acceptanceFixture(t);
  const { runId, gate2 } = await runToGate2(fixture);
  const accepted = await postDecision(fixture.second, fixture.origin, runId, {
    expectedWaitId: gate2.waitId!,
    action: 'approve',
  });
  assert.equal(accepted.status, 303);

  let run = (await fixture.host.readRun(runId))!;
  for (let i = 0; i < 300 && !run.commit; i++) {
    assert.notEqual(run.status, 'stopped', run.message);
    await new Promise((resolve) => setTimeout(resolve, 100));
    run = (await fixture.host.readRun(runId))!;
  }
  assert.equal(run.status, 'finished');
  assert.ok(run.commit);
  const head = execFileSync('git', ['rev-parse', run.branch], { cwd: fixture.stand.root, encoding: 'utf8' }).trim();
  assert.equal(run.commit, head);
});

test(
  'приёмка: возврат с комментарием запускает новый круг, второй клиент видит данные последнего круга',
  { skip: serverTestsSkip, timeout: 60_000 },
  async (t) => {
    const counter = `${process.env.TMPDIR ?? '/tmp'}/purpleflow-accept-counter-${crypto.randomUUID()}`;
    const testCommand = `${process.execPath} -e 'const fs=require("node:fs");const f=${JSON.stringify(counter)};const n=Number(fs.existsSync(f)?fs.readFileSync(f,"utf8"):"0")+1;fs.writeFileSync(f,String(n));console.log("прогон №"+n)'`;
    const fixture = await acceptanceFixture(t, { testCommand });
    const { runId, gate2 } = await runToGate2(fixture);
    const firstRun = (await fixture.core.getRun(runId))!;
    assert.equal(firstRun.tests.at(-1)!.command, testCommand);
    const out1 = firstRun.tests.at(-1)!.output;
    const beforeInvalid = {
      status: firstRun.status,
      next: firstRun.next,
      waitId: firstRun.waitId,
      gates: firstRun.gates,
      feedback: firstRun.feedback,
      attempts: firstRun.attempts.length,
      implAttemptsUsed: firstRun.implAttemptsUsed,
    };
    const empty = await postDecision(fixture.second, fixture.origin, runId, {
      expectedWaitId: gate2.waitId!,
      action: 'reject',
      comment: '   ',
    });
    assert.equal(empty.status, 400);
    const afterInvalid = (await fixture.core.getRun(runId))!;
    assert.deepEqual(
      {
        status: afterInvalid.status,
        next: afterInvalid.next,
        waitId: afterInvalid.waitId,
        gates: afterInvalid.gates,
        feedback: afterInvalid.feedback,
        attempts: afterInvalid.attempts.length,
        implAttemptsUsed: afterInvalid.implAttemptsUsed,
      },
      beforeInvalid,
    );

    const comment = 'Нужен ещё один круг';
    const rejected = await postDecision(fixture.second, fixture.origin, runId, {
      expectedWaitId: gate2.waitId!,
      action: 'reject',
      comment,
    });
    assert.equal(rejected.status, 303);
    const decision = (await fixture.core.getRun(runId))!.gates.find((gate) => gate.gate === 'gate2');
    assert.equal(decision?.decision, 'reject');
    assert.equal(decision?.comment, comment);
    const secondGate = await untilGate(fixture.core, runId, 'gate2');
    assert.notEqual(secondGate.waitId, gate2.waitId);
    const secondRun = (await fixture.core.getRun(runId))!;
    assert.equal(secondRun.tests.at(-1)!.command, testCommand);
    assert.ok(secondRun.attempts.some((attempt) => attempt.stage === 'implement' && attempt.attempt === 2));
    const out2 = secondRun.tests.at(-1)!.output;
    assert.notEqual(out2, out1);
    const marker1 = /прогон №\d+/.exec(out1)?.[0];
    const marker2 = /прогон №\d+/.exec(out2)?.[0];
    assert.ok(marker1);
    assert.ok(marker2);

    const page = await (await fixture.first.request(fixture.origin, `/runs/${runId}`)).text();
    assert.ok(page.includes(marker2));
    assert.ok(!page.includes(marker1));
    assert.match(page, /Нужен ещё один круг/);
  },
);

test('ревью кода: только завершить или отменить, без коммита', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const stand = makeServerStand();
  const config = loadServerConfig(stand.configFile);
  const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: stand.root, encoding: 'utf8' }).trim();
  const run = waitingRunFixture(stand.dataDir, stand.root, {
    next: 'gate2',
    mode: 'review',
    baseCommit,
    tests: [],
    reviews: [
      {
        at: '1',
        blocking: [{ file: 'src/math.js', line: 1, message: 'Блокирующее замечание' }],
        notes: [{ file: null, line: null, message: 'Заметка ревьюера' }],
      },
    ],
  });
  const fixture = await startTestHost({ dataDir: stand.dataDir, settings: config.settings, project: stand.project });
  t.after(() => fixture.close());
  const origin = await listen(t, createServerApp(config, fixture.host));
  const browser = new Browser();
  assert.equal((await browser.login(origin)).status, 303);

  const page = await (await browser.request(origin, `/runs/${run.id}`)).text();
  assert.match(page, /Блокирующее замечание/);
  assert.match(page, /Заметка ревьюера/);
  assert.match(page, /Проверка не запускалась/);
  assert.match(page, /Завершить разбор/);
  assert.match(page, /Отменить/);
  assert.ok(!page.includes('Вернуть с комментарием'));

  const withRunLock = t.mock.method(fixture.core.kernel, 'withRunLock');
  const rejected = await postDecision(browser, origin, run.id, {
    expectedWaitId: run.waitId!,
    action: 'reject',
    comment: 'Недопустимый возврат',
  });
  assert.equal(rejected.status, 400);
  assert.equal(withRunLock.mock.callCount(), 0);

  const commitsBefore = execFileSync('git', ['rev-list', '--count', run.branch], { cwd: stand.root, encoding: 'utf8' }).trim();
  const approved = await postDecision(browser, origin, run.id, { expectedWaitId: run.waitId!, action: 'approve' });
  assert.equal(approved.status, 303);
  const finished = (await fixture.core.getRun(run.id))!;
  assert.equal(finished.status, 'finished');
  assert.equal(finished.commit, undefined);
  const commitsAfter = execFileSync('git', ['rev-list', '--count', run.branch], { cwd: stand.root, encoding: 'utf8' }).trim();
  assert.equal(commitsAfter, commitsBefore);
});
