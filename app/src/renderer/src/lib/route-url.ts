import type { ProjectTab, SettingsTab, View } from './reducer';

const SETTINGS_TABS: SettingsTab[] = ['account', 'stats', 'tools', 'models', 'window'];
const PROJECT_TABS: ProjectTab[] = ['overview', 'commands', 'knowledge', 'git'];

function oneOf<T extends string>(value: string, values: T[]): T | undefined {
  return values.find((item) => item === value);
}

function withProject(path: string, project?: string): string {
  return project ? `${path}?project=${encodeURIComponent(project)}` : path;
}

export function viewToPath(view: View): string {
  switch (view.name) {
    case 'new':
      return withProject('/', view.project);
    case 'run':
      return `/runs/${view.runId}${view.tab === 'log' ? '/log' : ''}`;
    case 'settings':
      return `/settings${view.tab ? `/${view.tab}` : ''}`;
    case 'welcome':
      return '/';
    case 'start':
      return '/start';
    case 'chat':
      return view.chatId ? `/chats/${view.chatId}` : withProject('/chats', view.project);
    case 'projects':
      return '/projects';
    case 'project':
      return `/projects/${encodeURIComponent(view.path)}${view.tab ? `/${view.tab}` : ''}`;
  }
}

export function pathToView(pathname: string, search: string): View {
  try {
    decodeURIComponent(search);
    const project = new URLSearchParams(search).get('project') || undefined;
    const parts = pathname.split('/').slice(1);

    if (pathname === '/') return { name: 'new', ...(project ? { project } : {}) };
    if (pathname === '/start') return { name: 'start' };
    if (pathname === '/projects') return { name: 'projects' };
    if (pathname === '/chats') return { name: 'chat', ...(project ? { project } : {}) };

    if (parts[0] === 'settings' && (parts.length === 1 || (parts.length === 2 && parts[1]))) {
      const tab = parts[1] ? oneOf(parts[1], SETTINGS_TABS) : undefined;
      return { name: 'settings', ...(tab ? { tab } : {}) };
    }
    if (parts[0] === 'runs' && parts[1] && (parts.length === 2 || (parts.length === 3 && parts[2] === 'log'))) {
      return { name: 'run', runId: decodeURIComponent(parts[1]), ...(parts[2] === 'log' ? { tab: 'log' as const } : {}) };
    }
    if (parts[0] === 'chats' && parts[1] && parts.length === 2) {
      return { name: 'chat', chatId: decodeURIComponent(parts[1]) };
    }
    if (parts[0] === 'projects' && parts[1] && (parts.length === 2 || (parts.length === 3 && parts[2]))) {
      const path = decodeURIComponent(parts[1]);
      if (path === '.' || path === '..') return { name: 'new' };
      const tab = parts[2] ? oneOf(parts[2], PROJECT_TABS) : undefined;
      return { name: 'project', path, ...(tab ? { tab } : {}) };
    }
  } catch {
    return { name: 'new' };
  }
  return { name: 'new' };
}
