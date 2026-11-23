import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LINES = 85;
const BRANCHES = 75;
const FUNCTIONS = 85;

type Metric = 'LF' | 'LH' | 'BRF' | 'BRH' | 'FNF' | 'FNH';
type CoverageRecord = Record<Metric, number> & { file: string };

function serverModules(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return serverModules(file);
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [file] : [];
  });
}

function parseLcov(text: string): CoverageRecord[] {
  const records: CoverageRecord[] = [];
  let current: CoverageRecord | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      current = { file: line.slice(3), LF: 0, LH: 0, BRF: 0, BRH: 0, FNF: 0, FNH: 0 };
      continue;
    }
    if (!current) continue;
    if (line === 'end_of_record') {
      records.push(current);
      current = null;
      continue;
    }
    const metric = /^(LF|LH|BRF|BRH|FNF|FNH):(\d+)$/.exec(line);
    if (metric) current[metric[1] as Metric] = Number(metric[2]);
  }
  return records;
}

function percent(hit: number, total: number) {
  return total === 0 ? 100 : Math.round((10000 * hit) / total) / 100;
}

function belowThreshold(hit: number, total: number, threshold: number) {
  return total > 0 && 100 * hit < threshold * total;
}

if (process.platform !== 'linux') {
  console.log('Покрытие серверного модуля: пропущено — серверные тесты идут только на Linux');
} else {
  const rootFlag = process.argv.indexOf('--root');
  const root = path.resolve(rootFlag === -1 ? fileURLToPath(new URL('..', import.meta.url)) : (process.argv[rootFlag + 1] ?? '.'));
  const src = path.join(root, 'src');
  const tests = fs.existsSync(src)
    ? fs
        .readdirSync(src, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /^server-.+\.test\.ts$/.test(entry.name))
        .map((entry) => path.join(src, entry.name))
        .sort()
    : [];
  const main = path.join(src, 'server', 'main.ts');
  const modules = serverModules(path.join(src, 'server'))
    .filter((file) => file !== main)
    .sort();

  if (tests.length === 0 && modules.length === 0) {
    console.log('Покрытие серверного модуля: серверных тестов нет');
  } else if (tests.length === 0) {
    console.error('Покрытие серверного модуля: серверные модули без тестов');
    for (const file of modules) console.error(path.relative(root, file));
    process.exitCode = 1;
  } else {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-server-coverage-'));
    const lcov = path.join(tempDir, 'coverage.lcov');
    try {
      const args = [
        '--enable-source-maps',
        '--import',
        import.meta.resolve('tsx'),
        ...modules.flatMap((file) => ['--import', pathToFileURL(file).href]),
        '--test',
        '--experimental-test-coverage',
        '--test-coverage-include=src/server/**/*.ts',
        '--test-coverage-exclude=src/server/main.ts',
        '--test-coverage-exclude=src/**/*.test.ts',
        `--test-coverage-lines=${LINES}`,
        `--test-coverage-branches=${BRANCHES}`,
        `--test-coverage-functions=${FUNCTIONS}`,
        '--test-reporter=spec',
        '--test-reporter-destination=stdout',
        '--test-reporter=lcov',
        `--test-reporter-destination=${lcov}`,
        ...tests,
      ];
      const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
      let failed = result.status !== 0;

      if (fs.existsSync(lcov)) {
        for (const record of parseLcov(fs.readFileSync(lcov, 'utf8'))) {
          const lines = percent(record.LH, record.LF);
          const branches = percent(record.BRH, record.BRF);
          const functions = percent(record.FNH, record.FNF);
          const below =
            belowThreshold(record.LH, record.LF, LINES) ||
            belowThreshold(record.BRH, record.BRF, BRANCHES) ||
            belowThreshold(record.FNH, record.FNF, FUNCTIONS);
          if (below) {
            const file = path.isAbsolute(record.file) ? path.relative(root, record.file) : record.file;
            console.error(
              `Покрытие серверного модуля: файл ниже порога — ${file}: строки ${lines}%, ветви ${branches}%, функции ${functions}%`,
            );
            failed = true;
          }
        }
      }
      if (failed) process.exitCode = 1;
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}
