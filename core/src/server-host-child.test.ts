import { startHost, type StartHostOptions } from './server/host.js';

if (process.env.PF_HOST_CHILD) {
  const options = JSON.parse(process.env.PF_HOST_CHILD) as StartHostOptions;
  const host = await startHost(options);
  console.log(JSON.stringify(await host.snapshot()));
  console.log('ready');
  await new Promise<void>(() => {});
}
