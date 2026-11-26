// Запуск настройки так же, как её запускает процесс установщика: без вопросов, по спискам «включить» и «выключить».
import { applyChanges, existingKey, scan } from '../../../src/main/connect/run.js';

const list = (v: string | undefined) => (v ? v.split(',').filter(Boolean) : []);
if (process.argv[2] === 'scan') console.log(JSON.stringify(await scan()));
else {
  const key = process.env.TEST_KEY === undefined ? existingKey() : process.env.TEST_KEY || undefined;
  console.log(JSON.stringify(await applyChanges(key, list(process.env.TEST_ENABLE), list(process.env.TEST_DISABLE), () => {})));
}
