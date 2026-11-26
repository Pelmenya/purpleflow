import type { Service } from '../../core/types.js';
import { OPENAI_BASE_URL } from '../../constants.js';
import { codexEditors } from './targets/codexEditors.js';
import { buildCrush, buildOpenCode, buildPi, buildNeovim, buildQwen } from '../shared/proxyClients.js';
import { openaiCodexCli, setOpenaiKeyConsumers } from './targets/openaiCodexCli.js';

const keyConsumers = [buildOpenCode('openai'), buildQwen('openai'), buildPi('openai'), buildNeovim('openai'), buildCrush('openai')];
setOpenaiKeyConsumers(keyConsumers);

export const openaiCodexService: Service = {
  id: 'openai-codex',
  title: 'OpenAI/Codex (семейство моделей GPT)',
  baseUrl: OPENAI_BASE_URL,
  authScheme: 'openai',
  targets: [openaiCodexCli, ...codexEditors, ...keyConsumers],
};
