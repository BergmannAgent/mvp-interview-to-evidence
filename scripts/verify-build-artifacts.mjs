import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const roots = ['apps', 'packages'];
const unexpected = [];

for (const root of roots) {
  await collectTestArtifacts(resolve(root), unexpected);
}

if (unexpected.length > 0) {
  throw new Error(`Production build contains test artifacts:\n${unexpected.join('\n')}`);
}

const domainModule = await import(pathToFileURL(resolve('packages/domain/dist/index.js')).href);
const expectedDomainExports = [
  'TranscriptDomainError',
  'appendAiTranscriptTurn',
  'createTranscriptAggregate',
  'ingestFinalParticipantSegment',
  'ingestPartialParticipantSegment',
  'isValidSpeakerTurnType',
  'recordTranscriptTechnicalGap',
  'toCanonicalTranscriptSnapshot',
  'validateFinalTranscript',
];
const missingDomainExports = expectedDomainExports.filter((name) => !(name in domainModule));

if (missingDomainExports.length > 0) {
  throw new Error(
    `Production domain package is missing exports: ${missingDomainExports.join(', ')}`,
  );
}

const backendModule = await import('@orgscience/backend');
const forbiddenBackendRuntimeExports = [
  'DatabaseConfigurationError',
  'DatabaseMigrationError',
  'ManagedDatabasePool',
  'PostgresPersistenceContextFactory',
  'PostgresUnitOfWork',
  'createDatabasePool',
  'createPgMigrationPool',
  'createPgUnitOfWorkPool',
  'loadDatabaseConfig',
  'loadSqlMigrations',
  'runSqlMigrations',
];
const exposedBackendRuntimeExports = forbiddenBackendRuntimeExports.filter(
  (name) => name in backendModule,
);

if (exposedBackendRuntimeExports.length > 0) {
  throw new Error(
    `Production backend package exposes database infrastructure: ${exposedBackendRuntimeExports.join(', ')}`,
  );
}

const backendPackage = JSON.parse(
  await readFile(resolve('apps/backend/package.json'), { encoding: 'utf8' }),
);
const backendExportKeys = Object.keys(backendPackage.exports ?? {});
if (backendExportKeys.length !== 1 || backendExportKeys[0] !== '.') {
  throw new Error(`Backend package must expose only '.': ${backendExportKeys.join(', ')}`);
}

await expectBlockedBackendDeepImport();

const publicDeclarations = await collectPublicDeclarations(
  resolve('apps/backend/dist/index.d.ts'),
  new Set(),
);
const forbiddenDeclarationNames = [
  'ManagedDatabasePool',
  'PersistenceContextFactory',
  'PoolClient',
  'PostgresPersistenceContextFactory',
  'PostgresUnitOfWork',
  'SqlExecutor',
  'UnitOfWorkClient',
  'UnitOfWorkPool',
];
const exposedDeclarationNames = forbiddenDeclarationNames.filter((name) =>
  new RegExp(`\\b${name}\\b`, 'u').test(publicDeclarations),
);

if (exposedDeclarationNames.length > 0) {
  throw new Error(
    `Production backend declarations expose database infrastructure: ${exposedDeclarationNames.join(', ')}`,
  );
}

async function collectTestArtifacts(directory, matches) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') {
        continue;
      }
      await collectTestArtifacts(path, matches);
    } else if (/\.test\.(?:js|jsx|d\.ts|js\.map|d\.ts\.map)$/u.test(entry.name)) {
      matches.push(path);
    }
  }
}

async function expectBlockedBackendDeepImport() {
  try {
    await import('@orgscience/backend/infrastructure/database/index.js');
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
    ) {
      return;
    }
    throw error;
  }
  throw new Error('Backend infrastructure is importable through a package subpath');
}

async function collectPublicDeclarations(file, visited) {
  if (visited.has(file)) {
    return '';
  }
  visited.add(file);
  const source = await readFile(file, { encoding: 'utf8' });
  const sources = [source];
  const reexportPattern =
    /\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+['"](?<path>\.[^'"]+)['"]/gu;
  for (const match of source.matchAll(reexportPattern)) {
    const specifier = match.groups?.path;
    if (specifier === undefined) {
      continue;
    }
    const declarationPath = resolve(
      dirname(file),
      specifier.endsWith('.js') ? `${specifier.slice(0, -3)}.d.ts` : `${specifier}.d.ts`,
    );
    sources.push(await collectPublicDeclarations(declarationPath, visited));
  }
  return sources.join('\n');
}
