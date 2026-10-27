# Evaluation Consistency Study

This folder contains a fully synthetic organizational case and an independent
repeatability check of the existing scoring coder. The intended content range of
approximately 4-5 is a case-construction target, not an expected or enforced model
score. The model receives only the saved profile and interview.

## Language and Record Preservation

The committed comparison and ten report Markdown files are English presentation
translations of the original exports. Their labels, item wording, profile anchors,
rationales and inferences are translated; participant quotations remain in the
original German. These translations do not rescore, correct or reinterpret the
stored model outputs.

The two original German transcript Markdown files, every JSON file, evidence
quotation, score, status, source reference, run identifier, timestamp and stored
fingerprint are preserved. The German canonical JSON files remain authoritative
for reproducing the inputs and inspecting original model output. The case and
its interviewee metadata are synthetic, not data from an identified participant.

Historical German filenames and the `massentest` directory, command and identifiers
are retained to preserve existing links and provenance. In these names,
`auswertung` means evaluation, `vergleich` means comparison, and
`eingangstranskript` means input transcript. New runner outputs use the existing
export format; the committed English Markdown is an editorial presentation layer.

## Run the Study

Start the backend and set `OPENAI_API_KEY` in `.env`, then run from the repository
root:

```sh
npm run evaluation:massentest
```

The command reads the currently saved default profile through the existing GET
API, copies it without modification, and performs ten independent evaluations of
the identical transcript. **Real API charges apply.** The pipeline may repair an
invalid output once per evaluation, so ten evaluations can require up to twenty
model calls. There is no demo mode or automatic score adjustment.

To supply explicit paths and a backend URL:

```sh
npm run evaluation:massentest -- --input massentest/fixtures/lindenhafen-session.de.json --backend-url http://localhost:3100 --output-root massentest/results
```

Do not run this paid study as a routine documentation or submission check. The
committed result files can be inspected without a provider connection.

## Files

The readable original case is
[`fixtures/lindenhafen-transkript.de.md`](fixtures/lindenhafen-transkript.de.md).
Its validated canonical turn structure is
[`fixtures/lindenhafen-session.de.json`](fixtures/lindenhafen-session.de.json).
Each invocation creates a new batch folder under `results/`:

- `input-session.json` and `input-profile.json`: unchanged inputs.
- `eingangstranskript.md`: readable copy of every unchanged turn text.
- `01-auswertung.md` through `10-auswertung.md`: individual reports or error reports.
- Corresponding JSON files: canonical results and run metadata.
- `vergleich.md`: overall scores, complete item/status vectors, dispersion, and
  evidence and text differences.
- `vergleich.json` and `manifest.json`: machine-readable metrics, model, prompt
  version, fingerprints and actual API-call count.

Existing batch folders are not overwritten or automatically resumed. Formatters
and the Docker build context exclude `results/`; the files remain in the Git
backup. A failed run is disclosed rather than replaced with another evaluation.
The command does not write interviews, profiles or evaluations to the production
database or display these tests in Eval Studio.

## Interpretation

The committed batch used the arithmetic mean of all scored items. Non-scores
and failures were not treated as zero.
Identical overall means do not necessarily imply identical item scores. The item
table reports valid count, minimum, maximum and population standard deviation.

This study examines consistency for one synthetic case under the recorded
configuration. It does not establish psychometric validity, construct validity,
human-rater agreement, accuracy, generalizability to other interviews, or
organizational truth. Evidence selection and explanatory wording must be
considered separately from numeric score stability.

## Committed Batch

The [ten evaluations and comparison](results/2026-09-30T23-30-52.912Z-massentest-2a03b2e0-4caa-4fdd-af34-1aa1f21286c5/vergleich.md)
used the saved default profile and `openai/gpt-5.6-terra`. All ten evaluations
succeeded. Including one output repair, the batch made eleven real model calls.
Overall scores ranged from 4.78 to 4.89. Eight of nine items were identical across
all runs; `int-02` received a score of 4 six times and 5 four times.

The case was therefore largely, but not completely, score-stable. Evidence
selection and rationale text also varied. The comparison reports these
differences without treating consistency as validity.
