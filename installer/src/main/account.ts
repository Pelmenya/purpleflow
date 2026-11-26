// Аккаунт PurpleSchool вместо вставки ключа: вход или регистрация, затем ключ AI-прокси берётся из аккаунта
// (или создаётся). Логика та же, что в PurpleFlow (app/src/main/account.ts).
// Вход запоминается между запусками: account.json в папке данных установщика, токен и ключ в нём зашифрованы
// системным хранилищем (Связка ключей macOS, DPAPI Windows, libsecret Linux) — так же хранит их PurpleFlow.
import fs from 'node:fs';
import path from 'node:path';
import { app, net, safeStorage } from 'electron';
import type { AccountResult, AccountState } from '../shared/connect';

const API = 'https://app.purpleschool.ru/api-v2';
const KEY_NAME = 'AI для кода';
const KNOWN_KEYS = [KEY_NAME, 'PurpleFlow'];
const TIMEOUT_MS = 20_000;

interface ApiKeyView {
  id: number;
  name: string;
  proxyKey: string;
  effectiveStatus: 'ACTIVE' | 'DEACTIVATED' | 'EXPIRED';
}

let token: string | null = null;
let email: string | null = null;
let key: string | null = null;
let name = '';
/** Фото профиля как data URL: CSP окна не пускает внешние картинки. */
let photo = '';
let loaded = false;
let profileTried = false;

interface Saved {
  email: string;
  tokenEnc: string;
  keyEnc: string;
  name?: string;
  photo?: string;
}

const PHOTO_MAX = 2 * 1024 * 1024;

const file = () => path.join(app.getPath('userData'), 'account.json');
const encrypt = (v: string) => safeStorage.encryptString(v).toString('base64');
const decrypt = (v: string) => safeStorage.decryptString(Buffer.from(v, 'base64'));

/** Читаем при первом обращении: safeStorage работает только после готовности приложения. */
function load() {
  if (loaded) return;
  loaded = true;
  try {
    const saved = JSON.parse(fs.readFileSync(file(), 'utf8')) as Saved;
    if (!safeStorage.isEncryptionAvailable()) return;
    email = saved.email || null;
    name = saved.name ?? '';
    photo = saved.photo ?? '';
    token = saved.tokenEnc ? decrypt(saved.tokenEnc) : null;
    key = saved.keyEnc ? decrypt(saved.keyEnc) : null;
  } catch {
    /* файла нет или его не расшифровать (другая учётная запись, сброшенная связка ключей) — входим заново */
    token = email = key = null;
    name = photo = '';
  }
}

/** Без системного шифрования вход не сохраняем: открытым текстом токен на диск не кладём. */
function save() {
  try {
    if (!email || !token || !safeStorage.isEncryptionAvailable()) return;
    const data: Saved = { email, tokenEnc: encrypt(token), keyEnc: key ? encrypt(key) : '', name, photo };
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(data), { mode: 0o600 });
  } catch {
    /* не сохранилось — вход действует до закрытия установщика */
  }
}

const normEmail = (e: string) => e.trim().toLowerCase();

async function request<T>(method: 'GET' | 'POST', route: string, body?: unknown, auth?: string) {
  let res: Response;
  try {
    res = await net.fetch(`${API}${route}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false as const, status: 0, error: 'Нет связи с PurpleSchool. Проверьте интернет и попробуйте ещё раз.' };
  }
  const json = (await res.json().catch(() => null)) as (T & { message?: string | string[] }) | null;
  if (res.ok) return { ok: true as const, data: json as T };
  const message = Array.isArray(json?.message) ? '' : (json?.message ?? '');
  if (res.status === 429) return { ok: false as const, status: 429, error: 'Слишком много попыток. Подождите минуту и попробуйте снова.' };
  if (res.status >= 500)
    return { ok: false as const, status: res.status, error: 'Сервер PurpleSchool сейчас не отвечает. Попробуйте чуть позже.' };
  return { ok: false as const, status: res.status, error: /[а-яё]/i.test(message) ? message : '' };
}

/** Фото скачиваем в main и отдаём окну data URL. Токен на хост фото не отправляем. */
async function photoDataUrl(src: string): Promise<string> {
  try {
    const url = new URL(src, `${new URL(API).origin}/`);
    if (url.protocol !== 'https:') return '';
    const res = await net.fetch(url.toString(), { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const type = res.headers.get('content-type')?.split(';')[0].trim() ?? '';
    if (!res.ok || !type.startsWith('image/')) return '';
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > PHOTO_MAX ? '' : `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    return '';
  }
}

/** Имя и аватар из профиля PurpleSchool (GET /user/profile) — как в аккаунте PurpleFlow. Не загрузилось — не беда. */
async function loadProfile() {
  if (!token) return;
  const today = new Date().toISOString().slice(0, 10);
  const r = await request<{ profile?: { name?: string | null; surname?: string | null; photo?: string | null } }>(
    'GET',
    `/user/profile?from=${today}&to=${today}`,
    undefined,
    token,
  );
  if (!r.ok || !r.data?.profile) return;
  const p = r.data.profile;
  name = [p.name, p.surname]
    .map((x) => x?.trim())
    .filter(Boolean)
    .join(' ');
  photo = p.photo ? await photoDataUrl(p.photo) : '';
  save();
}

/** После входа ключ нужен сразу: активный из аккаунта (сначала наши), а нет ни одного — новый. */
async function signedIn(accessToken: string | undefined, mail: string): Promise<AccountResult> {
  if (!accessToken) return { ok: false, error: 'PurpleSchool не вернул токен. Попробуйте ещё раз.' };
  token = accessToken;
  email = mail;
  key = null;
  name = photo = '';
  profileTried = true;
  await loadProfile();
  const list = await request<{ items: ApiKeyView[] }>(
    'GET',
    '/public/ai-proxy/api-keys?sortBy=createdAt&sortDirection=desc',
    undefined,
    token,
  );
  if (!list.ok) return { ok: false, error: list.error || 'Не удалось получить ключи аккаунта' };
  const active = (list.data?.items ?? []).filter((k) => k.effectiveStatus === 'ACTIVE');
  const found = KNOWN_KEYS.map((n) => active.find((k) => k.name === n)).find(Boolean) ?? active[0];
  if (found) {
    key = found.proxyKey;
    save();
    return { ok: true };
  }
  const created = await request<ApiKeyView>('POST', '/public/ai-proxy/api-keys', { name: KEY_NAME }, token);
  if (!created.ok || !created.data?.proxyKey)
    return { ok: false, error: created.ok ? 'PurpleSchool не вернул ключ' : created.error || 'Не удалось создать ключ' };
  key = created.data.proxyKey;
  save();
  return { ok: true };
}

export async function login(mail: string, password: string): Promise<AccountResult> {
  const r = await request<{ accessToken: string }>('POST', '/auth/login', { email: normEmail(mail), password });
  if (!r.ok) {
    if (r.status === 401) return { ok: false, error: 'Неверный email или пароль' };
    if (r.status === 400) return { ok: false, error: 'Проверьте email: похоже, в нём ошибка' };
    return { ok: false, error: r.error || 'Не удалось войти' };
  }
  return signedIn(r.data?.accessToken, normEmail(mail));
}

export async function register(p: { name: string; email: string; password: string; mailing: boolean }): Promise<AccountResult> {
  const mail = normEmail(p.email);
  const r = await request<{ accessToken: string }>('POST', '/auth/register', {
    name: p.name.trim(),
    email: mail,
    password: p.password,
    utm_source: 'purpleflow-installer',
    needAdvertisingMailing: p.mailing,
  });
  if (!r.ok) {
    if (r.status === 400 && /существует/i.test(r.error))
      return { ok: false, code: 'exists', error: 'Такой email уже зарегистрирован — войдите' };
    if (r.status === 400) return { ok: false, error: r.error || 'Проверьте имя и email' };
    return { ok: false, error: r.error || 'Не удалось зарегистрироваться' };
  }
  return signedIn(r.data?.accessToken, mail);
}

export async function restore(mail: string): Promise<AccountResult & { message?: string }> {
  const r = await request<{ message?: string }>('POST', '/auth/restore', { email: normEmail(mail) });
  if (!r.ok)
    return { ok: false, error: r.status === 400 ? 'Проверьте email: похоже, в нём ошибка' : r.error || 'Не удалось отправить письмо' };
  return { ok: true, message: r.data?.message || 'Если такой аккаунт есть, мы отправили письмо со ссылкой для смены пароля.' };
}

export function logout() {
  loaded = true;
  token = email = key = null;
  name = photo = '';
  fs.rmSync(file(), { force: true });
}

/** Что показать в панели аккаунта. Профиль сохранённого входа без имени и фото дотягиваем один раз за запуск. */
export async function accountState(): Promise<AccountState> {
  load();
  if (token && !profileTried && !name && !photo) {
    profileTried = true;
    await loadProfile();
  }
  return { email, name, photo };
}

export const accountEmail = () => (load(), email);
export const accountKey = () => (load(), key ?? undefined);
