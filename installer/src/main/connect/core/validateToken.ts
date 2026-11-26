import { parseModelsResponse, type ModelCatalog } from './models.js';

export type TokenCheckStatus = 'valid' | 'invalid' | 'unknown';
export type ProxyAuthScheme = 'anthropic' | 'openai';

export interface TokenCheckResult {
  status: TokenCheckStatus;
  /** Модели, которые прокси вернул на /v1/models. Есть только при status === "valid" и разборчивом ответе. */
  models?: ModelCatalog;
}

function authHeaders(apiKey: string, scheme: ProxyAuthScheme): Record<string, string> {
  return scheme === 'openai' ? { Authorization: `Bearer ${apiKey}` } : { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '');
}

/**
 * Pings a PurpleSchool AI proxy with a lightweight, side-effect-free request to confirm the
 * token actually authenticates before we touch any config files. Assumes the proxy forwards
 * paths 1:1 to the upstream API (GET /v1/models) — the same convention every documented IDE
 * integration on purpleschool.ru already relies on. `scheme` picks the auth header style:
 * Anthropic's x-api-key/anthropic-version vs. OpenAI's Authorization: Bearer.
 *
 * The same response carries the proxy's model catalogue, which we return so targets can pin
 * and list models the proxy actually serves instead of a hardcoded list that goes stale.
 */
export async function checkPurpleSchoolToken(
  baseUrl: string,
  apiKey: string,
  scheme: ProxyAuthScheme = 'anthropic',
): Promise<TokenCheckResult> {
  try {
    // Node < 18 has no global fetch; requireSupportedNode() gates that at startup, but keep the
    // catch below honest about it in case this is ever called from somewhere else.
    const res = await fetch(`${trimBase(baseUrl)}/v1/models`, {
      method: 'GET',
      headers: authHeaders(apiKey, scheme),
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401 || res.status === 403) return { status: 'invalid' };
    if (res.status !== 200) return { status: 'unknown' };

    let models: ModelCatalog | undefined;
    try {
      models = parseModelsResponse(await res.json());
    } catch {
      // Ключ подтверждён статусом 200 — неразборчивый список моделей это не отменяет.
      models = undefined;
    }
    return { status: 'valid', models };
  } catch {
    return { status: 'unknown' };
  }
}

export interface ProbeResult {
  ok: boolean;
  /** The model accepted the request, but the output reached the probe's token budget. */
  limited?: boolean;
  /** HTTP-статус, если ответ вообще пришёл. */
  status?: number;
  /** Короткое описание ошибки для пользователя. */
  detail?: string;
}

/**
 * Настоящий запрос к модели через прокси (max_tokens: 1 — стоит пару токенов). Проверка ключа
 * через /v1/models подтверждает только авторизацию; этот запрос ловит то, что /v1/models не
 * видит: модель, которой нет на прокси (400 Model not supported), и пустой баланс (402).
 */
export async function probeAnthropicMessage(baseUrl: string, apiKey: string, model: string): Promise<ProbeResult> {
  try {
    const res = await fetch(`${trimBase(baseUrl)}/v1/messages`, {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
      headers: { ...authHeaders(apiKey, 'anthropic'), 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
    });
    let body: { type?: unknown; content?: unknown; message?: unknown; error?: { message?: unknown } | null };
    try {
      const parsed: unknown = await res.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Not a message object');
      body = parsed;
    } catch {
      return { ok: false, status: res.status, detail: 'Прокси вернул некорректный JSON вместо результата генерации.' };
    }
    if (res.status === 200 && body.type === 'message' && Array.isArray(body.content) && body.error == null)
      return { ok: true, status: 200 };
    const message = body.error?.message ?? body.message;
    return {
      ok: false,
      status: res.status,
      detail: typeof message === 'string' ? message : 'Ответ не соответствует успешному сообщению Anthropic.',
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Checks the exact selected OpenAI model over Responses, not a different cheap model. */
export async function probeOpenaiResponse(baseUrl: string, apiKey: string, model: string): Promise<ProbeResult> {
  try {
    const res = await fetch(`${trimBase(baseUrl)}/v1/responses`, {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
      headers: { ...authHeaders(apiKey, 'openai'), 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: 'Reply OK', max_output_tokens: 128, store: false }),
    });
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = await res.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Not a response object');
      body = parsed as Record<string, unknown>;
    } catch {
      return { ok: false, status: res.status, detail: 'Прокси вернул некорректный JSON вместо результата генерации.' };
    }
    const error = body.error;
    const errorMessage = error && typeof error === 'object' ? (error as { message?: unknown }).message : undefined;
    const detail = typeof errorMessage === 'string' ? errorMessage : typeof body.message === 'string' ? body.message : undefined;
    if (res.status !== 200 || error != null) return { ok: false, status: res.status, detail: detail ?? 'Генерация завершилась ошибкой.' };
    if (body.object !== 'response' || !Array.isArray(body.output)) {
      return { ok: false, status: res.status, detail: 'Ответ не соответствует формату OpenAI Responses.' };
    }
    if (body.status === 'completed') return { ok: true, status: res.status };
    const incomplete = body.incomplete_details as { reason?: unknown } | null | undefined;
    if (body.status === 'incomplete' && incomplete?.reason === 'max_output_tokens') {
      return {
        ok: true,
        limited: true,
        status: res.status,
        detail: 'Модель приняла запрос, но генерация ограничена проверочным лимитом токенов.',
      };
    }
    return { ok: false, status: res.status, detail: detail ?? `Генерация не завершена успешно (status: ${String(body.status)}).` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
