import type { CoreApi, CoreEvent } from '@purpleflow/core';
import { parse, stringify } from 'devalue';
import { coreMethodNames, type AccountResult, type PublicSettings, type PurpleFlowBridge } from '../shared/ipc';

interface WebLocation {
  pathname: string;
  search: string;
  reload(): void;
  assign(url: string): void;
}

export interface WebBridgeDeps {
  fetch: typeof fetch;
  EventSource: typeof EventSource;
  location: WebLocation;
  setTimeout: typeof window.setTimeout;
}

type CoreReply = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };

type ServerSettings = Pick<
  PublicSettings,
  | 'toolPaths'
  | 'models'
  | 'efforts'
  | 'agents'
  | 'enabledAgents'
  | 'agentTimeoutMin'
  | 'testTimeoutMin'
  | 'maxParallel'
  | 'claudeAuth'
  | 'userConfig'
> & { proxy: { baseUrl: string; codexBaseUrl?: string; hasKey: boolean } };

const coreEventNames: Record<CoreEvent['type'], true> = {
  'stage.started': true,
  'agent.output': true,
  'tests.result': true,
  'review.result': true,
  'gate.waiting': true,
  'stage.failed': true,
  'run.finished': true,
  'visual.frame': true,
  'preview.state': true,
  'run.updated': true,
  'manager.updated': true,
  'run.deleted': true,
  'chat.updated': true,
  'chat.deleted': true,
};

class ServiceError extends Error {
  constructor(readonly status: number) {
    super(`Служба ответила ${status}`);
  }
}

export function createWebBridge(deps: Partial<WebBridgeDeps> = {}): PurpleFlowBridge {
  const webFetch = deps.fetch ?? window.fetch.bind(window);
  const EventSourceConstructor = deps.EventSource ?? window.EventSource;
  const location = deps.location ?? window.location;
  const schedule = deps.setTimeout ?? window.setTimeout.bind(window);
  let reloading = false;
  let checkingSession = false;
  let source: EventSource | undefined;
  const subscribers = new Set<(event: CoreEvent) => void>();

  const login = () => `/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`;

  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    const response = await webFetch(url, { ...init, credentials: 'same-origin' });
    if (response.status === 401) {
      location.assign(login());
      throw new ServiceError(401);
    }
    return response;
  }

  function reload(): void {
    if (reloading) return;
    reloading = true;
    location.reload();
  }

  async function checkSession(): Promise<void> {
    try {
      const response = await request('/api/settings', { method: 'GET' });
      if (response.status === 200) {
        checkingSession = false;
        reload();
      } else if (response.status >= 500 && response.status <= 599) {
        schedule(() => void checkSession(), 2000);
      } else {
        checkingSession = false;
      }
    } catch (error) {
      if (error instanceof ServiceError && error.status === 401) {
        checkingSession = false;
        return;
      }
      schedule(() => void checkSession(), 2000);
    }
  }

  function eventSource(): EventSource {
    if (source) return source;
    source = new EventSourceConstructor('/api/events');
    const publish = (event: CoreEvent) => {
      for (const subscriber of subscribers) subscriber(event);
    };
    source.addEventListener('message', (event) => {
      publish(parse((event as MessageEvent).data) as CoreEvent);
    });
    for (const type of Object.keys(coreEventNames) as CoreEvent['type'][]) {
      source.addEventListener(type, (event) => {
        publish(JSON.parse((event as MessageEvent).data) as CoreEvent);
      });
    }
    source.addEventListener('reset', reload);
    source.addEventListener('error', () => {
      if (source?.readyState !== 2 || checkingSession || reloading) return;
      checkingSession = true;
      void checkSession();
    });
    return source;
  }

  const core = Object.fromEntries(
    coreMethodNames.map((method) => [
      method,
      async (...args: unknown[]) => {
        const response = await request(`/api/core/${method}`, { method: 'POST', body: stringify(args) });
        let reply: CoreReply;
        try {
          reply = parse(await response.text()) as CoreReply;
        } catch {
          throw new ServiceError(response.status);
        }
        if (reply?.ok === true && 'result' in reply) return reply.result;
        if (reply?.ok === false && typeof reply.error?.message === 'string') {
          const error = new Error(reply.error.message) as Error & { code?: string };
          error.code = reply.error.code;
          throw error;
        }
        throw new ServiceError(response.status);
      },
    ]),
  ) as unknown as CoreApi;

  const unavailable = (phase: number) => async (): Promise<never> => {
    throw new Error(`Недоступно в браузере до Ф${phase}`);
  };
  const unavailableAccount = (phase: number) => async (): Promise<AccountResult<never>> => ({
    ok: false,
    error: `Недоступно в браузере до Ф${phase}`,
  });
  const unavailableSubscription = () => () => {};

  return {
    web: true,
    reportsErrors: false,
    core,
    onEvent(fn) {
      eventSource();
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    account: {
      login: unavailableAccount(11),
      register: unavailableAccount(11),
      restore: unavailableAccount(11),
      logout: unavailable(11),
      profile: unavailableAccount(11),
      keys: unavailableAccount(11),
      createKey: unavailableAccount(11),
      useKey: unavailableAccount(11),
      autoKey: unavailableAccount(11),
      overview: unavailableAccount(11),
      usage: unavailableAccount(11),
      initialBalance: unavailableAccount(11),
      requestEmailCode: unavailableAccount(11),
      confirmEmailCode: unavailableAccount(11),
      claimInitialBalance: unavailableAccount(11),
      trialModels: unavailableAccount(11),
    },
    settings: {
      async get() {
        const response = await request('/api/settings', { method: 'GET' });
        let settings: ServerSettings;
        try {
          settings = JSON.parse(await response.text()) as ServerSettings;
        } catch {
          throw new ServiceError(response.status);
        }
        if (!settings || typeof settings !== 'object' || !settings.proxy || typeof settings.proxy !== 'object') {
          throw new ServiceError(response.status);
        }
        return {
          ...settings,
          proxy: {
            baseUrl: settings.proxy.baseUrl,
            codexBaseUrl: settings.proxy.codexBaseUrl ?? '',
            hasKey: settings.proxy.hasKey,
            enabled: settings.proxy.hasKey,
          },
          onboarded: true,
          authPrompted: true,
          accountEnabled: false,
          diagnostics: false,
          windowGlass: false,
          notify: false,
          sound: false,
          unreadable: false,
          account: null,
        };
      },
      set: unavailable(7),
      encryptionAvailable: unavailable(7),
      onRecovered: unavailableSubscription,
    },
    proxyModels: async () => null,
    pickFolder: unavailable(9),
    pickFile: unavailable(9),
    openPath: unavailable(9),
    pathForFile: () => '',
    dictation: {
      status: async () => ({ engine: false, models: [] }),
      download: unavailable(11),
      cancel: unavailable(11),
      remove: unavailable(11),
      mic: unavailable(11),
      transcribe: unavailable(11),
      onProgress: unavailableSubscription,
    },
    previewEmulate: unavailable(12),
    appCache: { size: unavailable(11), clear: unavailable(11) },
    onChime: unavailableSubscription,
    onGo: unavailableSubscription,
    testNotification: unavailable(8),
    setupStep: () => {},
    update: {
      state: async () => ({ kind: 'idle' }),
      onState: unavailableSubscription,
      onReveal: unavailableSubscription,
      check: unavailable(10),
      download: unavailable(10),
      install: unavailable(10),
    },
    reportBug: unavailable(11),
    whatsNew: {
      releases: async () => ({ releases: [] }),
      versions: async () => ({ current: '', seen: '' }),
      seen: async () => {},
    },
    platform: 'web',
    material: 'none',
    onMaterial: unavailableSubscription,
  } satisfies PurpleFlowBridge;
}
