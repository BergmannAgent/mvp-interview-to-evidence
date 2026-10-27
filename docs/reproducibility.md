# Reproducing The Prototype

## Start From A Fresh Environment

Use the source package with its checked-in `package-lock.json`, Dockerfile and
Compose configuration. Do not restore a development database for the demo.

Set the following in a local `.env`:

```dotenv
DEMO_MODE=true
OPENAI_API_KEY=
```

Run `docker compose up --build -d --wait`. The database, migration runner, backend
and three browser applications start together. The default local URLs are
documented in the root README. Use Text mode for the provider-free trial. Voice
remains provider-dependent and requires credentials even in demo configuration.

## Inspect A Complete Workflow

1. Open the Interview application, select English and Text, then start an interview.
2. Open Monitoring in a second tab and select the same interview ID.
3. Submit answers and compare the confirmed transcript in both applications.
4. Pause or end the interview. Open Evaluation Studio and explicitly start an
   evaluation using the selected profile.
5. Inspect item evidence, missing-evidence statuses and the calculation trace.
6. Download the report and transcript. Reload the application to verify that
   stored results remain available without a new evaluation request.

Demo evaluations use deterministic substitutes. Their purpose is to reproduce
the application flow, not the published provider scores.

## Automated Checks

With the Node.js and npm versions declared in `package.json`:

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

The standard tests mock model and Voice providers. Database tests in the normal
suite are skipped unless configured with an isolated database. For the separate
`npm run test:postgres` command, first provide a disposable PostgreSQL database,
set `TEST_DATABASE_URL` to its connection URL and set
`ALLOW_TEST_DATABASE_RESET=true`. The command does not create or remove that
database. It resets database tables and must never be pointed at a database
containing research interviews.

## Recorded Provider Results

The [repeated-evaluation study](../massentest/README.md) contains ten recorded
evaluations of one synthetic transcript. Its JSON inputs and outputs are the
canonical record. English Markdown files are presentation translations, with
original participant quotations unchanged. The original prompt version and model
are recorded with the study and are not claims about every subsequent run.

The [synthetic Realtime test](../examples/realtime-default-guide-test/README.md)
records simulated participant text and generated interviewer speech. Local audio
paths are represented as relative locations, and audio files are not distributed.
The test does not validate microphone input, browser playback or automatic turn
detection.

Re-running provider tests requires an API key, incurs usage and can yield different
results. The normal demo and test suite do not rerun the paid study automatically.

## Preserved Source Data

The JSON research instruments and their SHA-256 sidecars remain unchanged.
Original German transcripts and stored evaluation JSON remain in their source
language to preserve quotations and fingerprints. Both language-specific default
guides and parser fixtures are retained because the application is bilingual.
