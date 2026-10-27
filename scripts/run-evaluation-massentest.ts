import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { MastraEvaluationCoder } from '../apps/backend/src/infrastructure/mastra/mastra-evaluation-coder.js';
import {
  MastraStructuredGenerator,
  type StructuredGenerator,
} from '../apps/backend/src/infrastructure/mastra/mastra-agent-executor.js';
import { loadModelRuntimeConfig } from '../apps/backend/src/runtime/model-config.js';
import { PROFILE_EVALUATION_CODING_PROMPT_VERSION } from '../apps/backend/src/application/evaluations/evaluation-coder.js';
import {
  MASSENTEST_RUN_COUNT,
  compareMassentestRuns,
  massentestComparisonMarkdown,
  massentestInputMarkdown,
  massentestRunMarkdown,
  prepareMassentestInputs,
  readDefaultMassentestProfile,
  runEvaluationMassentest,
} from './evaluation-massentest.js';

const { values } = parseArgs({
  options: {
    input: { type: 'string', default: 'massentest/fixtures/lindenhafen-session.de.json' },
    'backend-url': {
      type: 'string',
      default: process.env['MASSENTEST_BACKEND_URL'] ?? 'http://localhost:3100',
    },
    'output-root': { type: 'string', default: 'massentest/results' },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  process.stdout.write(
    'npm run evaluation:massentest -- [--input session.json] [--backend-url http://localhost:3100] [--output-root massentest/results]\nTen real evaluations, plus at most one repair per run. No product database writes.\n',
  );
} else {
  await main();
}

async function main(): Promise<void> {
  if (!process.env['OPENAI_API_KEY']?.trim()) {
    throw new Error('OPENAI_API_KEY is required. Massentest never uses a demo fallback.');
  }
  const config = loadModelRuntimeConfig();
  const inputPath = values.input ?? 'massentest/fixtures/lindenhafen-session.de.json';
  const profile = await readDefaultMassentestProfile(
    values['backend-url'] ?? 'http://localhost:3100',
  );
  const sessionCandidate: unknown = JSON.parse(await readFile(inputPath, 'utf8'));
  const inputs = prepareMassentestInputs(profile, sessionCandidate);
  const batchId = `massentest-${randomUUID()}`;
  const folder = path.resolve(
    values['output-root'] ?? 'massentest/results',
    `${new Date().toISOString().replaceAll(':', '-')}-${batchId}`,
  );
  await mkdir(folder, { recursive: true });
  await saveJson(path.join(folder, 'input-session.json'), inputs.session);
  await saveJson(path.join(folder, 'input-profile.json'), inputs.profile);
  await writeFile(path.join(folder, 'eingangstranskript.md'), massentestInputMarkdown(inputs));
  let providerCalls = 0;
  const delegate = new MastraStructuredGenerator();
  const generator: StructuredGenerator = {
    async generate(request) {
      if (providerCalls >= MASSENTEST_RUN_COUNT * 2) {
        throw new Error('The massentest provider-call budget is exhausted.');
      }
      providerCalls += 1;
      return delegate.generate(request);
    },
  };
  const coder = new MastraEvaluationCoder({
    model: config.evaluationModel,
    timeoutMs: config.evaluationTimeoutMs,
    generator,
  });
  const manifest = {
    batchId,
    startedAt: new Date().toISOString(),
    sourceInput: path.relative(process.cwd(), path.resolve(inputPath)),
    profileName: inputs.profile.name,
    profileId: inputs.profile.profileId,
    profileUpdatedAt: inputs.profile.updatedAt,
    profileFingerprint: inputs.profileFingerprint,
    transcriptFingerprint: inputs.transcriptFingerprint,
    promptVersion: PROFILE_EVALUATION_CODING_PROMPT_VERSION,
    model: coder.model,
    evaluationTimeoutMs: config.evaluationTimeoutMs,
    plannedRuns: MASSENTEST_RUN_COUNT,
    productDatabaseWrites: false,
  };
  let completedRuns = 0;
  let failedRuns = 0;
  await saveJson(path.join(folder, 'manifest.json'), {
    ...manifest,
    status: 'running',
    completedRuns,
    failedRuns,
    actualProviderCalls: providerCalls,
  });
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Massentest cancelled.'));
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  process.stdout.write(
    `Massentest: ${folder}\n10 independent evaluations; unchanged profile ${profile.name}; model ${config.evaluationModel}.\n`,
  );
  try {
    const runs = await runEvaluationMassentest(inputs, {
      batchId,
      coder,
      providerCalls: () => providerCalls,
      signal: controller.signal,
      async onRun(run) {
        const prefix = `${String(run.index).padStart(2, '0')}-auswertung`;
        await writeFile(path.join(folder, `${prefix}.md`), massentestRunMarkdown(run));
        await saveJson(path.join(folder, `${prefix}.json`), run);
        if (run.status === 'completed') completedRuns += 1;
        else failedRuns += 1;
        await saveJson(path.join(folder, 'manifest.json'), {
          ...manifest,
          status: 'running',
          completedRuns,
          failedRuns,
          actualProviderCalls: providerCalls,
        });
        process.stdout.write(
          `${String(run.index)}/10 ${run.status}; ${String(run.providerCalls)} provider calls; ${String(run.durationMs)}ms\n`,
        );
      },
    });
    const comparison = compareMassentestRuns(inputs.profile, runs);
    await writeFile(path.join(folder, 'vergleich.md'), massentestComparisonMarkdown(inputs, runs));
    await saveJson(path.join(folder, 'vergleich.json'), comparison);
    await saveJson(path.join(folder, 'manifest.json'), {
      ...manifest,
      status: comparison.failedRuns === 0 ? 'completed' : 'completed_with_failures',
      completedAt: new Date().toISOString(),
      completedRuns: comparison.completedRuns,
      failedRuns: comparison.failedRuns,
      actualProviderCalls: providerCalls,
    });
    process.stdout.write(`Comparison: ${path.join(folder, 'vergleich.md')}\n`);
    if (comparison.failedRuns > 0) process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}

async function saveJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
