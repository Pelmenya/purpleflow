import type { Service } from '../../core/types.js';
import { ANTHROPIC_BASE_URL } from '../../constants.js';
import { buildClaudeCodeCli } from './targets/claudeCodeCli.js';
import { vscode, cursor, windsurf } from './targets/vscodeLike.js';
import { neovimAvante } from './targets/neovimAvante.js';
import { openCode } from './targets/opencode.js';
import { buildCrush, buildQwen } from '../shared/proxyClients.js';
import { piCli } from './targets/pi.js';

const qwen = buildQwen('anthropic');
const crush = buildCrush('anthropic');
const claudeCodeCli = buildClaudeCodeCli({ key: [openCode, piCli, neovimAvante, qwen, crush], core: [vscode, cursor, windsurf] });

export const codeService: Service = {
  id: 'code',
  title: 'Anthropic/ClaudeCode (семейство моделей opus/sonnet/haiku)',
  baseUrl: ANTHROPIC_BASE_URL,
  targets: [claudeCodeCli, openCode, piCli, vscode, cursor, windsurf, neovimAvante, qwen, crush],
};
