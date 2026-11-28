import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { makeSandbox } from './harness';
import { startWebService, type WebService } from './web-service';

test('веб-служба: хранит хеш и принимает исходный секрет при входе', async () => {
  const box = makeSandbox();
  let service: WebService | undefined;
  try {
    service = await startWebService(box);
    const stored = fs.readFileSync(path.join(box.root, 'web-secret'), 'utf8');
    expect(stored).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(stored).not.toContain(service.secret);

    const login = await fetch(`${service.origin}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: service.origin, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: service.secret, returnTo: '/' }),
    });
    expect(login.status).toBe(303);
    expect(login.headers.get('location')).toBe('/');
  } finally {
    if (service) await service.stop();
    box.cleanup();
  }
});
