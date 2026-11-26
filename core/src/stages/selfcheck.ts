// Самопроверка исполнителя: приложение из рабочей копии и браузер (pw) на время стадии «Реализация».
import fs from 'node:fs';
import path from 'node:path';
import { c, crlf } from '../agents/common.js';
import { prependPath, which } from '../env.js';
import type { Kernel } from '../kernel.js';
import { expandPorts, portEnv, waitForUrl } from '../net.js';
import { killGroup, run as runProc } from '../proc.js';
import { workDir } from '../services/repos.js';
import { prepareApp } from '../services/workspace.js';
import type { RunFile } from '../types.js';
import { closePw, writePw } from './visual.js';

export interface SelfCheck {
  /** Блок для промпта исполнителя: адрес приложения, папка скриншотов, что проверять. */
  block: string;
  /** Окружение агента: pw в PATH. */
  env: NodeJS.ProcessEnv;
  stop(): Promise<void>;
}

/**
 * Включается вместе с визуальной проверкой прогона: у проекта есть команда запуска и адрес, и человек согласился
 * поднимать приложение. codex — в песочнице workspace-write: сеть у исполнителя есть, но npx (кэш ~/.npm) и браузер
 * Playwright (~/Library/Caches/ms-playwright) писать туда не могут. Поэтому для него браузер открывает ядро снаружи,
 * а pw вызывает уже скачанный Playwright CLI через node. На Windows у codex своя песочница — там не проверяли, не включаем.
 */
export function selfCheckReason(
  run: Pick<RunFile, 'visual' | 'runCommand' | 'appUrl' | 'agents'>,
  platform: NodeJS.Platform = process.platform,
): 'on' | 'codex' | 'off' | 'codex-win' {
  if (!run.visual || !run.runCommand?.trim() || !run.appUrl?.trim()) return 'off';
  if (run.agents.executor !== 'codex') return 'on';
  return platform === 'win32' ? 'codex-win' : 'codex';
}

/** Путь к playwright-cli.js из кэша npx: скачать (если ещё нет) и найти, не запуская браузер. */
export async function playwrightCliPath(env: NodeJS.ProcessEnv, cwd: string): Promise<string | null> {
  const r = await runProc('npx', ['-y', '-p', '@playwright/cli@latest', 'sh', '-c', 'command -v playwright-cli'], {
    cwd,
    env,
    timeoutMs: 180_000,
  });
  const bin = r.code === 0 ? r.stdout.trim().split('\n').pop() : '';
  if (!bin) return null;
  try {
    return fs.realpathSync(bin);
  } catch {
    return null;
  }
}

/** pw для песочницы codex: node и скрипт Playwright CLI напрямую, без npx. */
export function writeDirectPw(dir: string, session: string, node: string, cli: string): void {
  fs.writeFileSync(path.join(dir, 'pw'), `#!/bin/sh\ncd "${dir}" && exec "${node}" "${cli}" -s=${session} "$@"\n`, { mode: 0o755 });
}

/**
 * Поднять приложение в фоне (подготовка из команд проекта, затем команда запуска на свободном порту) и выдать
 * исполнителю pw. Агента не ждём: он пишет код, а к экрану приходит, когда приложение уже отвечает.
 * Сервер — в группе `${id}:server`: «Стоп» прогона гасит его вместе со стадией.
 */
export async function startSelfCheck(k: Kernel, run: RunFile, attempt: number): Promise<SelfCheck | null> {
  const why = selfCheckReason(run);
  if (why === 'codex-win') {
    k.log(run, c.dim('Самопроверка в браузере для codex на Windows пока не поддерживается.') + '\n');
    return null;
  }
  if (why === 'off') return null;
  // Рядом с папками визуальной проверки: удаление прогона убирает и их.
  const dir = path.join(k.opts.dataDir, 'visual', run.id, `self-${attempt}`);
  fs.mkdirSync(dir, { recursive: true });
  const session = `purpleflow-self-${run.id.slice(0, 8)}`;
  // codex: браузер открываем сами, снаружи песочницы, и отдаём pw без npx.
  const outside = why === 'codex';
  if (outside) {
    const node = which('node', k.opts.env);
    const cli = node ? await playwrightCliPath(k.opts.env, dir) : null;
    if (!node || !cli) {
      k.log(run, c.dim('Самопроверка в браузере: не удалось скачать Playwright CLI — исполнитель обойдётся без неё.') + '\n');
      return null;
    }
    writeDirectPw(dir, session, node, cli);
    const opened = await runProc(path.join(dir, 'pw'), ['open', 'about:blank'], {
      cwd: dir,
      env: k.opts.env,
      group: run.id,
      timeoutMs: 120_000,
    });
    if (opened.code !== 0) {
      k.log(run, c.dim('Самопроверка в браузере: браузер не открылся — исполнитель обойдётся без неё.') + '\n');
      return null;
    }
  } else writePw(dir, session);
  const { port, url, command } = await expandPorts(run.appUrl!, run.runCommand!);
  const group = `${run.id}:server`;
  let stopped = false;
  const log = (t: string) => k.log(run, c.dim(crlf(t)), false);
  void (async () => {
    try {
      await prepareApp(k, { repo: run.projectPath, cwd: workDir(run), group, onOutput: log });
      if (stopped) return;
      k.log(run, c.sky(`$ ${command}`) + c.dim(`  # приложение для самопроверки на ${url}`) + '\n');
      let exited = false;
      void runProc(command, [], {
        cwd: workDir(run),
        env: { ...k.opts.env, ...portEnv(run.runCommand!, port), BROWSER: 'none', CI: '1' },
        shell: true,
        group,
        waitForOutput: true,
        onStdout: log,
        onStderr: log,
      }).then(() => {
        exited = true;
      });
      const ready = await waitForUrl(url, 120_000, () => exited || stopped);
      if (!stopped)
        k.log(
          run,
          (ready
            ? c.mint(`✓ приложение для самопроверки отвечает на ${url}`)
            : c.dim(`приложение для самопроверки не ответило на ${url}`)) + '\n',
        );
    } catch (e) {
      if (!stopped) k.log(run, c.dim(`самопроверка: приложение не поднялось — ${(e as Error).message.split('\n')[0]}`) + '\n');
    }
  })();
  return {
    block: k.prompts.render('selfcheck.md', {
      url,
      dir,
      open: outside
        ? `Браузер уже открыт и подключён к pw — не вызывай \`pw open\` и \`pw close\`, переходи командой \`pw goto ${url}\`.`
        : `Открой браузер командой \`pw open ${url}\`, в конце закрой — \`pw close\`.`,
    }),
    env: prependPath(k.opts.env, dir),
    async stop() {
      stopped = true;
      await closePw(k, dir, session, `${run.id}:visual-cleanup`);
      await killGroup(group);
    },
  };
}
