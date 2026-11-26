// Фасад ядра: публичный API (CoreApi) поверх движка, стадий и сервисов.
// Логики здесь нет — только сборка ядра и разводка команд по модулям.
import fs from 'node:fs';
import path from 'node:path';
import { checkCommand, detectProjectCommands, findEnvFiles } from './detect.js';
import * as engine from './engine.js';
import { decide } from './gates.js';
import { detectTools, which } from './env.js';
import { Git } from './git.js';
import { Kernel, ShuttingDownError } from './kernel.js';
import { killAll, spawnScope } from './proc.js';
import type { CoreOptions, Listener } from './runtime.js';
import { getAttachment } from './services/attachments.js';
import * as chat from './services/chat.js';
import { listAgyModels, listOpencodeModels, testConnection } from './services/connection.js';
import { control } from './services/control.js';
import { cleanStorage, getStorage } from './services/disk.js';
import { askManager, getManagerChat, getManagerImage, resolveManagerAction } from './services/manager.js';
import * as pr from './services/pr.js';
import { getPreview, startPreview, stopPreview } from './services/preview.js';
import * as projects from './services/projects.js';
import { nestedRepos } from './services/repos.js';
import { getChangeDocs, getChangedFiles, getDiff } from './services/runs.js';
import { detectNode, installNode } from './services/node.js';
import { installTool } from './services/setup.js';
import { answer } from './stages/plan.js';
import { getVisualShot } from './stages/visual.js';
import { gitCommitDiff, gitGraph } from './services/gitview.js';
import { trace } from './trace.js';
import type {
  AgentKind,
  ChangeDocs,
  CommandIssue,
  CoreApi,
  CoreCommand,
  ManagerMessage,
  ProjectConfigInput,
  DetectedProject,
  ProjectKnowledge,
  ProjectLesson,
  StorageItem,
  ToolName,
} from './types.js';

/** .gitignore нового проекта: без зависимостей, сборки и секретов в первом коммите. */
const DEFAULT_GITIGNORE = `node_modules/
dist/
build/
out/
coverage/
.venv/
venv/
__pycache__/
target/
.env
.env.*
!.env.example
*.log
.DS_Store
Thumbs.db
.idea/
`;

export class Orchestrator implements CoreApi {
  readonly kernel: Kernel;
  private readonly scope = { stopped: false };
  private stopping?: Promise<void>;

  constructor(opts: CoreOptions) {
    this.kernel = spawnScope.run(this.scope, () => {
      const k = new Kernel(opts);
      k.engine = { drive: (run) => engine.drive(k, run), halt: (id) => engine.halt(k, id) };
      return k;
    });
  }

  private scoped<T>(fn: () => T): T {
    return spawnScope.run(this.scope, fn);
  }

  private accepted<T>(fn: () => T | Promise<T>): Promise<T> {
    return this.scoped(async () => {
      const k = this.kernel;
      if (k.closing) throw new ShuttingDownError();
      k.pending++;
      try {
        const result = await fn();
        if (k.closing) throw new ShuttingDownError();
        return result;
      } catch (error) {
        if (k.closing) throw new ShuttingDownError();
        throw error;
      } finally {
        k.pending--;
      }
    });
  }

  shutdown(): Promise<void> {
    if (this.stopping) return this.stopping;
    const k = this.kernel;
    k.closing = true;
    this.scope.stopped = true;
    for (const run of k.store.list()) k.cancelBackground(run.id);
    k.previewLaunches.clear();
    this.stopping = (async () => {
      await killAll();
      const busy = () => k.pending > 0 || k.driving.size > 0 || k.preparing.size > 0 || k.chatBusy.size > 0 || k.managerBusy.size > 0;
      let rounds = 0;
      while (busy() && rounds < 100) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        await killAll();
        rounds++;
      }
      if (busy()) trace('shutdown', new Error('Принятые вызовы не завершились за 100 кругов остановки'));
      await killAll();
    })();
    return this.stopping;
  }

  on(fn: Listener): () => void {
    return this.scoped(() => this.kernel.on(fn));
  }

  /** После перезапуска приложения: оборванные прогоны встают в очередь и продолжаются сами. */
  recover(): Promise<void> {
    return this.scoped(() => engine.recover(this.kernel));
  }

  /** Настройки поменялись (например, лимит одновременных прогонов) — может, кого-то пора запустить из очереди. */
  settingsChanged() {
    this.scoped(() => {
      void engine.pump(this.kernel);
    });
  }

  // ——— Команды прогона ———

  dispatch(cmd: CoreCommand): Promise<{ runId: string }> {
    return this.accepted(async () => {
      const k = this.kernel;
      if (cmd.type === 'run.start') return { runId: await engine.start(k, cmd.input) };
      switch (cmd.type) {
        case 'run.resume':
          await engine.resume(k, cmd.runId);
          break;
        case 'run.restore':
          await engine.restore(k, cmd.runId);
          break;
        case 'gate.approve':
          await decide(k, cmd.runId, 'approve', cmd.comment);
          break;
        case 'gate.reject':
          await decide(k, cmd.runId, 'reject', cmd.comment, cmd.lineComments);
          break;
        case 'gate.cancel':
          await decide(k, cmd.runId, 'cancel');
          break;
        case 'gate.accept':
          await decide(k, cmd.runId, 'accept');
          break;
        case 'gate.fix':
          await decide(k, cmd.runId, 'fix', cmd.comment, cmd.lineComments);
          break;
        case 'gate.answer':
          await answer(k, cmd.runId, cmd.answers);
          break;
        case 'run.stop':
          await engine.stop(k, cmd.runId);
          break;
        case 'run.control':
          await control(k, cmd.runId, cmd.action);
          break;
        case 'run.skipChecks':
          await engine.skipChecks(k, cmd.runId);
          break;
        case 'run.rerunVisual':
          await engine.rerunVisual(k, cmd.runId);
          break;
        case 'run.merge':
          await pr.merge(k, cmd.runId, cmd.target);
          break;
        case 'run.pr':
          await pr.openPr(k, cmd.runId, cmd.base);
          break;
        case 'run.prMerge':
          await pr.mergePrOf(k, cmd.runId);
          break;
        case 'run.prFollowup':
          await pr.prFollowup(k, cmd.runId, cmd.items, cmd.note);
          break;
        case 'run.updateBranch':
          await pr.updateBranch(k, cmd.runId);
          break;
        case 'run.delete':
          await engine.deleteRun(k, cmd.runId, cmd.deleteBranch);
          break;
      }
      return { runId: cmd.runId };
    });
  }

  // ——— Прогоны ———

  async listRuns() {
    return this.scoped(() => this.kernel.store.list());
  }
  async getRun(id: string) {
    return this.scoped(() => this.kernel.store.load(id));
  }
  async getLog(id: string) {
    return this.scoped(() => this.kernel.store.readLog(id));
  }
  async isDriving(id: string) {
    return this.scoped(() => this.kernel.driving.has(id));
  }
  getDiff(id: string) {
    return this.scoped(() => getDiff(this.kernel, id));
  }
  getChangedFiles(id: string) {
    return this.scoped(() => getChangedFiles(this.kernel, id));
  }
  getChangeDocs(id: string): Promise<ChangeDocs> {
    return this.scoped(() => getChangeDocs(this.kernel, id));
  }
  async getAttachment(id: string, index: number) {
    return this.scoped(() => getAttachment(this.kernel, id, index));
  }
  async getVisualShot(id: string, file: string) {
    return this.scoped(() => getVisualShot(this.kernel, id, file));
  }
  nextPartDraft(id: string) {
    return this.scoped(() => projects.nextPartDraft(this.kernel, id));
  }

  // ——— Ручная проверка ———

  startPreview(id: string) {
    return this.accepted(() => startPreview(this.kernel, id));
  }
  stopPreview(id: string) {
    return this.scoped(() => stopPreview(this.kernel, id));
  }
  async getPreview(id: string) {
    return this.scoped(() => getPreview(this.kernel, id));
  }

  // ——— Ветки и Pull Request ———

  listBranches(id: string) {
    return this.scoped(() => pr.listBranches(this.kernel, id));
  }
  mergeCheck(id: string, target?: string) {
    return this.scoped(() => pr.mergeCheck(this.kernel, id, target));
  }
  prReady(id: string) {
    return this.scoped(() => pr.prReady(this.kernel, id));
  }
  getPrStatus(id: string) {
    return this.scoped(() => pr.getPrStatus(this.kernel, id));
  }
  getPrDetails(id: string) {
    return this.scoped(() => pr.getPrDetails(this.kernel, id));
  }

  // ——— Менеджер прогона ———

  async getManagerChat(id: string): Promise<{ messages: ManagerMessage[]; thinking: boolean }> {
    return this.scoped(() => ({ messages: getManagerChat(this.kernel, id), thinking: this.kernel.managerBusy.has(id) }));
  }
  askManager(id: string, text: string, images?: { name: string; data: Uint8Array }[]) {
    return this.accepted(() => askManager(this.kernel, id, text, images));
  }
  async getManagerImage(id: string, file: string) {
    return this.scoped(() => getManagerImage(this.kernel, id, file));
  }
  resolveManagerAction(id: string, messageId: string, apply: boolean) {
    return this.accepted(() => resolveManagerAction(this.kernel, id, messageId, apply));
  }

  // ——— Инструменты и подключение ———

  detectTools() {
    return this.scoped(() => detectTools(this.kernel.opts.env, this.kernel.opts.getSettings().toolPaths));
  }
  installTool(name: ToolName) {
    return this.scoped(() => {
      const { env, getSettings } = this.kernel.opts;
      return installTool(name, env, getSettings().toolPaths[name]);
    });
  }
  detectNode() {
    return this.scoped(() => detectNode(this.kernel.opts.env));
  }
  installNode() {
    return this.scoped(() => installNode(this.kernel.opts.env));
  }
  testConnection() {
    return this.scoped(() => testConnection(this.kernel));
  }

  // ——— Проекты ———

  async detectProject(dir: string): Promise<DetectedProject> {
    return this.scoped(async () => {
      const { env, getSettings } = this.kernel.opts;
      const gitBin = getSettings().toolPaths.git || which('git', env) || 'git';
      const git = new Git(gitBin, env);
      const inside = await git.isRepo(dir).catch(() => false);
      // Подпапка чужого репозитория — не проект: прогон ушёл бы в корень того репозитория.
      const repoRoot = inside ? ((await git.enclosingRoot(dir).catch(() => null)) ?? undefined) : undefined;
      // Репозиторий без единого коммита: прогону не от чего ответвиться — как и обычной папке, ему нужен первый коммит.
      const empty = inside && !repoRoot && !(await git.head(dir).catch(() => ''));
      const base = {
        ...detectProjectCommands(dir),
        envFiles: findEnvFiles(dir),
        isRepo: inside && !repoRoot && !empty,
        repoRoot,
        empty: empty || undefined,
        name: path.basename(dir),
      };
      if (inside) return base;
      const projectOf = projects.projectOfRoot(this.kernel, dir) ?? undefined;
      const nested = nestedRepos(dir);
      return { ...base, nested: nested.length ? nested : undefined, projectOf };
    });
  }
  /** Проект с нуля: git init, .gitignore и первый коммит — дальше папка готова к прогонам. */
  async initRepo(dir: string): Promise<DetectedProject> {
    return this.scoped(async () => {
      const { env, getSettings } = this.kernel.opts;
      const git = new Git(getSettings().toolPaths.git || which('git', env) || 'git', env);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`Папка не найдена: ${dir}`);
      if (nestedRepos(dir).length) throw new Error('В папке есть другие репозитории — соберите проект из них, а не делайте общий');
      await git.initRepo(dir, DEFAULT_GITIGNORE);
      return this.detectProject(dir);
    });
  }
  async checkCommands(dir: string, cmds: Record<string, string>): Promise<Record<string, CommandIssue[]>> {
    return this.scoped(() => Object.fromEntries(Object.entries(cmds).map(([key, cmd]) => [key, cmd.trim() ? checkCommand(dir, cmd) : []])));
  }
  detectCommandsAI(dir: string) {
    return this.scoped(() => projects.detectCommandsAI(this.kernel, dir));
  }
  suggestMode(task: string) {
    return this.scoped(() => projects.suggestMode(this.kernel, task));
  }
  async listProjects() {
    return this.scoped(() => projects.listProjects(this.kernel));
  }
  projectOverview(dir: string) {
    return this.scoped(() => projects.projectOverview(this.kernel, dir));
  }
  async projectStats(dir: string) {
    return this.scoped(() => projects.projectStats(this.kernel, dir));
  }
  projectBranches(dir: string, fetch?: boolean) {
    return this.scoped(() => projects.projectBranches(this.kernel, dir, fetch));
  }
  async forgetProject(dir: string) {
    return this.scoped(() => projects.forgetProject(this.kernel, dir));
  }
  async getProjectConfig(dir: string) {
    return this.scoped(() => projects.getProjectConfig(this.kernel, dir));
  }
  async saveProjectConfig(dir: string, cfg: ProjectConfigInput) {
    return this.scoped(() => projects.saveProjectConfig(this.kernel, dir, cfg));
  }
  async detectForge(dir: string) {
    return this.scoped(() => projects.detectProjectForge(this.kernel, dir));
  }
  async getKnowledge(dir: string) {
    return this.scoped(() => projects.getKnowledge(this.kernel, dir));
  }
  async saveKnowledge(dir: string, k: ProjectKnowledge) {
    return this.scoped(() => projects.saveKnowledge(this.kernel, dir, k));
  }
  async saveKnowledgeProfile(dir: string, profile: string, expectedProfile?: string) {
    return this.scoped(() => projects.saveKnowledgeProfile(this.kernel, dir, profile, expectedProfile));
  }
  async removeKnowledgeLesson(dir: string, lesson: ProjectLesson) {
    return this.scoped(() => projects.removeKnowledgeLesson(this.kernel, dir, lesson));
  }
  refreshProfile(dir: string) {
    return this.scoped(() => projects.refreshProfile(this.kernel, dir));
  }
  cleanWorkingCopy(dir: string, how: 'stash' | 'discard') {
    return this.scoped(() => projects.cleanWorkingCopy(this.kernel, dir, how));
  }
  checkEnvironment(dir: string) {
    return this.scoped(() => projects.checkEnvironment(this.kernel, dir));
  }

  // ——— Место на диске ———

  getStorage() {
    return this.scoped(() => getStorage(this.kernel));
  }
  cleanStorage(id: StorageItem['id']) {
    return this.scoped(() => cleanStorage(this.kernel, id));
  }

  // ——— Чаты ———

  async listChats() {
    return this.scoped(() => chat.listChats(this.kernel));
  }
  async getChat(id: string) {
    return this.scoped(() => chat.getChat(this.kernel, id));
  }
  createChat(o: Parameters<typeof chat.createChat>[1]) {
    return this.scoped(() => chat.createChat(this.kernel, o));
  }
  async updateChat(id: string, patch: Parameters<typeof chat.updateChat>[2]) {
    return this.scoped(() => chat.updateChat(this.kernel, id, patch));
  }
  deleteChat(id: string) {
    return this.scoped(() => chat.deleteChat(this.kernel, id));
  }
  listChatFiles(projectPath: string) {
    return this.scoped(() => chat.listChatFiles(this.kernel, projectPath));
  }
  getGitGraph(projectPath: string, limit?: number) {
    return this.scoped(() => gitGraph(this.kernel, projectPath, limit));
  }
  getGitCommitDiff(projectPath: string, hash: string) {
    return this.scoped(() => gitCommitDiff(this.kernel, projectPath, hash));
  }
  async readChatFile(projectPath: string, rel: string) {
    return this.scoped(() => chat.readChatFile(projectPath, rel));
  }
  /** Сжатие идёт в фоне, как ход: результат приходит событиями chat.updated. */
  async compactChat(id: string): Promise<void> {
    return this.accepted(async () => {
      const run = chat.compactChat(this.kernel, id);
      // Отказ (не claude, агент занят) — сразу вызывающему; дальше всё в сообщении ответа.
      await Promise.race([run, new Promise((r) => setTimeout(r, 50))]);
      run.catch(() => {});
    });
  }
  async chatDefaultModel(agent: AgentKind) {
    return this.scoped(() => chat.chatDefaultModel(this.kernel, agent));
  }
  async listOpencodeModels(dir?: string) {
    return this.scoped(() => listOpencodeModels(this.kernel, dir));
  }
  async listAgyModels() {
    return this.scoped(() => listAgyModels(this.kernel));
  }
  async listChatSkills(projectPath?: string) {
    return this.scoped(() => chat.listChatSkills(this.kernel, projectPath));
  }
  /** Ход идёт в фоне: ответ приходит событиями chat.updated. */
  async sendChat(id: string, text: string, files?: { name: string; data: Uint8Array }[]): Promise<void> {
    return this.accepted(async () => {
      const turn = chat.sendChat(this.kernel, id, text, files);
      // Ошибки до начала хода (пустое сообщение) — сразу вызывающему; дальше всё в сообщении ответа.
      await Promise.race([turn, new Promise((r) => setTimeout(r, 50))]);
      turn.catch(() => {});
    });
  }
  async allowChatMcp(id: string, tool: { server: string; tool: string; always?: boolean }): Promise<void> {
    return this.accepted(async () => {
      const turn = chat.allowChatMcp(this.kernel, id, tool);
      await Promise.race([turn, new Promise((r) => setTimeout(r, 50))]);
      turn.catch(() => {});
    });
  }
  async grantChatFullAccess(id: string): Promise<void> {
    return this.accepted(async () => {
      const turn = chat.grantChatFullAccess(this.kernel, id);
      await Promise.race([turn, new Promise((r) => setTimeout(r, 50))]);
      turn.catch(() => {});
    });
  }
  async answerChatPermission(id: string, requestId: string, answer: 'once' | 'always' | 'deny') {
    return this.accepted(() => chat.answerChatPermission(id, requestId, answer));
  }
  stopChat(id: string) {
    return this.scoped(() => chat.stopChat(this.kernel, id));
  }
  async unqueueChat(id: string, messageId: string) {
    return this.scoped(() => chat.unqueueChat(this.kernel, id, messageId));
  }
  chatToTask(id: string) {
    return this.accepted(() => chat.chatToTask(this.kernel, id));
  }
  getChatDiff(id: string) {
    return this.scoped(() => chat.chatDiff(this.kernel, id));
  }
  getChatChangedFiles(id: string) {
    return this.scoped(() => chat.chatChangedFiles(this.kernel, id));
  }
}
