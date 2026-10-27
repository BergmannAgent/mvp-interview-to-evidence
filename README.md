# Live Interview Research Prototype

A guide-based interview system with a canonical transcript and a separate,
explicitly requested evidence-coding evaluation. The application supports English
and German. The interface opens in English unless a language preference is saved.

## Start With Docker

Docker Desktop or Docker Engine with Compose is required. No local Node.js,
database installation or GitHub CLI is needed to run the application.

For a provider-free trial, create a local `.env` file containing:

```dotenv
DEMO_MODE=true
OPENAI_API_KEY=
```

From the project directory, run:

```sh
docker compose up --build -d --wait
```

| Application       | URL                   | Purpose                                       |
| ----------------- | --------------------- | --------------------------------------------- |
| Interview         | http://localhost:5273 | Guide selection and interviews                |
| Monitoring        | http://localhost:5274 | Read-only transcript and workflow monitoring  |
| Evaluation Studio | http://localhost:5275 | Profile configuration, evaluation and exports |

Select **Text** mode for the deterministic demo. Choose the English guide in
Interview settings, start an interview and submit answers. Open Monitoring in a
second tab to follow the same interview. Evaluation Studio can evaluate the
confirmed transcript even when the interview was paused or ended early.

The demo checks the application flow. Its predefined ratings are not research
findings or a validation of model performance.

### Voice And Provider Evaluation

For provider-backed operation, set `DEMO_MODE=false` and configure
`OPENAI_API_KEY` in the local `.env`. This incurs external API usage. Apply the
configuration with:

```sh
docker compose up --build -d --wait
```

Select **Voice**, allow microphone access and start the interview. Voice requires
a valid provider configuration and never silently falls back to Text or demo.
The interview language is selected before starting and remains fixed during it.
See [Voice setup](docs/openai-voice-setup.md) and
[Windows setup](docs/windows-installation.md) for details.

## Interview Guides

The [guides directory](guides/README.md) contains the current German and English
guides. Demo and historical reference guides are kept separately in `guides/fixtures/`.

Open the gear icon in the Interview application to select or upload a Markdown
guide. Save the selection explicitly. Uploading a file does not automatically
replace the selected guide.

The parser accepts this English structure:

```markdown
# Interview guide title

## Section

### Main question

What is your role in the organization?

#### Follow-up questions

- Which decisions are you responsible for?
```

The guide determines the permitted interview topics. The profile used for
evaluation is separate. Generated clarification questions must remain within the
current topic. The transcript retains the original confirmed wording and speaker
order. Technical gaps are marked rather than filled with invented statements.

## Evaluation Studio

Select an interview with confirmed answers, choose a profile using the profile
icon and explicitly start an evaluation. Opening a saved report makes no model
call. Evaluating a partial interview uses the transcript available at that moment
and does not end the interview. Run evaluation again to include later answers.

Profiles contain editable dimensions, items, coding instructions and seven anchor
criteria per item. Profile configuration is independent of the selected guide.
JSON and Excel imports have a preview and explicit confirmation. API keys and
models are server-side settings, not profile-editor fields.

Item scores are integers from 1 to 7 when evidence is sufficient. Missing,
inapplicable or conflicting evidence is not automatically a low score. The
default overall calculation is a weighted mean of scored items. A profile can
instead define a mathematical formula. Reports show the calculation and evidence.

Report exports are JSON, CSV, Markdown and HTML. The transcript can also be
downloaded separately. Native PDF and Word evaluation-report exports are not
implemented. Uploading supplementary context documents is planned, not a current
application feature.

## Research Materials

- [Technical appendix](<docs/technical-documentation/Technical Documentation V1.docx>)
- [Measurement framework](docs/framework/measurement-framework.docx)
- [Framework diagram](docs/framework/measurement-workflow.pdf)
- [Architecture](docs/architecture.md)
- [Examples](examples/README.md)
- [Repeated-evaluation study and recorded results](massentest/README.md)
- [Profile import format](docs/evaluation-profile-xlsx-template.md)
- [Calibration background](docs/evaluation-validation-plan.md)
- [Reproduction instructions](docs/reproducibility.md)
- [Data handling](docs/privacy.md)
- [Submission scope](docs/submission.md)

Documentation is in English. Original German transcripts, quotations, instrument
data and bilingual parser fixtures are intentionally retained in their source
language. Translating those records would change the research evidence or its
fingerprints. English presentation translations are identified as translations.

## Development Checks

For development, use the Node.js and npm versions declared in `package.json`:

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

The normal suite uses deterministic provider substitutes. PostgreSQL integration
tests require a separate disposable database and otherwise remain skipped. To run
them, configure `TEST_DATABASE_URL` and explicitly set
`ALLOW_TEST_DATABASE_RESET=true`, then run `npm run test:postgres`. The command
does not create a test database. Never use the application's research database.
Provider smoke tests and the repeated-evaluation command are separate, paid
operations and are not needed for the provider-free trial.

## Operational Limits

This is a local research prototype, not a public multi-user service. It has no
authentication or tenant isolation. Do not expose its ports to the internet or
use the example database credentials for a public deployment.

Interview data persist in a Docker volume. Do not use `docker compose down -v`
when the data must be retained. Normal startup and rebuilding preserve the volume.

The derived evidence-coding procedure is not the original validated five-point
self-report scale. Stable scores in a synthetic case do not establish construct
validity, generalizability or calibrated model confidence. Human review remains
necessary for research use.
