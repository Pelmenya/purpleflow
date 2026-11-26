// Отдельный процесс настройки: один запуск — одно сообщение от окна, ответ и выход. Ключ сюда приходит только
// из main-процесса и никуда не пишется, кроме конфигов выбранных приложений.
import { applyChanges, existingKey, scan } from './run.js';
import { jetbrainsInstalled } from './core/os.js';
import type { WorkerRequest, WorkerResponse } from '../../shared/connect';

const port = process.parentPort;
const send = (m: WorkerResponse) => port.postMessage(m);

port.once('message', async (e: { data: WorkerRequest }) => {
  const req = e.data;
  try {
    if (req.type === 'scan') send({ type: 'scan', clients: await scan(), hasKey: Boolean(existingKey()), jetbrains: jetbrainsInstalled() });
    else {
      const key = req.apiKey ?? existingKey();
      send({ type: 'apply', results: await applyChanges(key, req.enable, req.disable, (p) => send({ type: 'progress', progress: p })) });
    }
  } catch (err) {
    send({ type: 'error', error: err instanceof Error ? err.message : String(err) });
  }
  // Сам не выходим: выход мог опередить доставку ответа, и окно видело «процесс завершился» вместо результата.
  // Процесс закрывает main, когда ответ получен.
});
