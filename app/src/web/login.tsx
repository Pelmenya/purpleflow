import { useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '../renderer/src/styles/tokens.css';
import '../renderer/src/styles/app.css';
import { Button, Field, Input } from '../renderer/src/components/ui';
import './login.css';

function Login() {
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError('');
    const returnTo = new URLSearchParams(location.search).get('returnTo') ?? '/';
    try {
      const response = await fetch('/login', {
        method: 'POST',
        body: new URLSearchParams({ secret, returnTo }),
        redirect: 'follow',
      });
      if (response.ok && response.redirected) {
        location.assign(new URL(response.url).origin === location.origin ? response.url : '/');
        return;
      }
      if (response.status === 401) setError('Неверный секрет');
      else if (response.status === 429) {
        const retryAfter = Math.max(1, Number(response.headers.get('Retry-After')) || 1);
        setError(`Слишком много попыток, повторите через ${retryAfter} с`);
      } else setError('Не удалось войти. Повторите попытку.');
    } catch {
      setError('Нет связи со службой. Проверьте соединение и повторите попытку.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="login-title">
        <h1 id="login-title">PurpleFlow</h1>
        <p>Введите секрет владельца, чтобы открыть окно приложения.</p>
        <form onSubmit={(event) => void submit(event)}>
          <Field label="Секрет">
            <Input
              type="password"
              name="secret"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              required
              autoFocus
              autoComplete="current-password"
            />
          </Field>
          {error && (
            <p className="login-error" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" tone="primary" busy={busy}>
            Войти
          </Button>
        </form>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Login />);
