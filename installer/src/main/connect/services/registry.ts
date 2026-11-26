import type { Service } from '../core/types.js';
import { codeService } from './code/index.js';
import { openaiCodexService } from './openaiCodex/index.js';

// services.length > 1 — CLI автоматически показывает шаг выбора провайдера/сервиса первым делом.
export const services: Service[] = [codeService, openaiCodexService];
