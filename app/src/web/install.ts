import { createWebBridge } from './bridge';

window.purpleflow = createWebBridge({ fetch, EventSource, location });
