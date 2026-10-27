# Validation Plan for the Organizational Resilience Evidence Report

This is the historical calibration record for the initial Organizational Resilience
instrument, not the current application's complete evaluation specification.
The current profile-based service can evaluate confirmed snapshots of unfinished
interviews. The original provider runs below retain their recorded configurations.

## Scope of the Prototype

The report codes statements from a finalized expert interview against nine items
in the Kantur/Iseri-Say structure. The original scale is a 1-to-5 self-report
measure. The prototype instead uses a **derived 1-to-7 evidence rating** with
literature-based reference anchors at 1, 4, and 7. The two forms of measurement
are not interchangeable.

The rating is intended solely for piloting and methodological exploration. It
documents the statements of one interview participant, not the objective
resilience of an entire organization. No psychometric, convergent, or external
validity is claimed.

## Versioned Interpolation Codebook

Values 1, 4, and 7 remain the only literature-based reference anchors. The
separate pilot codebook `or-evidence-interpolation-codebook@1.0.0`, with fingerprint
`caeffe44c7874e49e84063a5f90f42ee810c60918dcddc729bd8a193860800f3`, defines
intermediate values 2, 3, 5, and 6. It contains four explicit decision and
exclusion rules for each of the nine items:

- 2 falls between 1 and 4 and is closer to 1.
- 3 falls between 1 and 4 and is closer to 4.
- 5 falls between 4 and 7 and is closer to 4.
- 6 falls between 4 and 7 and is closer to 7.

A rating first checks for an exact fit to 1, 4, or 7. If the observable evidence
falls between them, the item-specific intermediate-value rule and both adjacent
reference anchors must be used. Values are not rounded or clamped to 1, 4, or 7.
Missing, solely hypothetical, or contradictory evidence remains a non-score
status. The codebook is a derived calibration aid for the prototype, not an
independently validated set of additional literature anchors.

## Automated Calibration Boundaries

The regular test suite uses deterministic fixtures for:

- clear proximity to reference anchors 1, 4, and 7;
- intermediate values that must name both adjacent reference anchors and the
  specific rule ID;
- missing evidence, non-applicability, and contradictory evidence;
- explicit absence of crisis experience, which is never treated as a low score;
- fabricated quotations, wrong turn IDs, and wrong sequence numbers;
- long transcripts with evidence distributed across the interview;
- unchanged legacy reports and idempotent persisted reports.

The versioned fixture `calibration-cases-v1.json` contains nine distinct cases
for the same item: values 1 through 7, `insufficient_evidence`, and `conflicting`.
All cases pass through transcript validation, the coding audit, the report
builder, and export. They therefore test technical calibration boundaries and
provenance. The deterministic demo coder is deliberately simple and assigns the
middle reference value 4 when evidence is present; this does not establish model
validity.

An accepted evidence excerpt must match verbatim a portion of a final participant
turn. AI turns, partial transcripts, turns from other interviews, and statements
rewritten afterward are not admissible evidence.

## Manual Provider Smoke Test

A paid provider smoke test uses an already finalized interview. The record must
include:

- model identifier and provider;
- prompt version;
- instrument, mapping, and transcript fingerprints;
- runtime and run ID;
- status of all nine items;
- successful verification of all quotations and turn IDs;
- results of JSON, CSV, Markdown, and print HTML exports.

One successful provider run checks only technical integration. It is not a
reliability or validity study. Repeated paid model runs were deliberately
deferred for this prototype.

The targeted intermediate-value smoke test can be reproduced with:

```bash
npm run evaluation:calibration:provider
```

The command loads `.env`, requires `OPENAI_API_KEY`, and runs four isolated
provider cases for 2, 3, 5, and 6. It fails if a target score, adjacent anchor,
rule ID, or deterministic evidence guardrail deviates. Raw responses and secrets
are not stored.

### Intermediate-Value Smoke Test on 21 August 2026

- Provider/model: `openai` / `openai/gpt-5.6-terra`.
- Prompt version: `or-evidence-coding-v2`.
- Rubric version: 2.
- Codebook: `or-evidence-interpolation-codebook@1.0.0` with the fingerprint above.
- Isolated case 2: expected 2, received 2, runtime 21.848 seconds.
- Isolated case 3: expected 3, received 3, runtime 43.147 seconds.
- Isolated case 5: expected 5, received 5, runtime 39.087 seconds.
- Isolated case 6: expected 6, received 6, runtime 17.607 seconds.
- Every target value referenced both correct adjacent reference anchors and
  named the matching item-specific rule ID in the structured field. The
  expected supporting and counter-evidence directions were documented by
  verbatim excerpts from the intended synthetic turn. All quotation, turn,
  schema, and report guardrails passed.

Each case was run exactly once. The result shows that the current provider
integration can technically generate all four intermediate values and validate
them through the deterministic report builder. Separate service and persistence
tests check storage and unchanged reloads. The provider smoke test itself does
not use a database. It establishes neither stability across repeated runs nor
human agreement or psychometric validity.

### Smoke Test on 19 August 2026

- Finalized interview: 54 canonical turns, no technical gap.
- Provider/model: `openai` / `openai/gpt-5.6-terra`.
- Prompt version: `or-evidence-coding-v1`.
- Instrument: `kantur-iseri-say-evidence-rating@1.0.0`, fingerprint
  `5664be7211e3818f62b7a6d73e0e333e1176172b2633355593f08a4129d9dc61`.
- Mapping: `resilient-decision-processes-kantur-evidence-v1@1.0.0`, fingerprint
  `4ddf8d2f86e0b838e5750a99302a3ff3cf47b5c5859ef818304d63b86210fc3d`.
- Evaluation run:
  `evaluation:adaeea36ad91b326de837c85e21fe1c8c3863179b4af31f421ccd2088e906c43`.
- Runtime of the single structured provider call: 39 seconds.
- Result: crisis context `no_crisis_experience`; all nine items were coded
  conservatively as `insufficient_evidence` rather than low scores; no overall
  value was produced.
- All 17 evidence references were checked against turn ID, sequence number,
  participant role, and verbatim excerpt. They represent eight unique evidence
  units across item, phase, and crisis context; five occur within the nine items.
- Repeated retrieval returned the same evaluation ID and the same report object.
- JSON, CSV, Markdown, and print HTML exports responded with HTTP 200 and the
  expected media type.
- After stopping and restarting PostgreSQL, the backend, and both frontends,
  the report remained available unchanged.
- The Monitoring view rendered at 1440 x 1000 and 390 x 844 pixels without a
  browser error or horizontal overflow.

## Descriptive Distribution Diagnostics

For each report, Monitoring and the Markdown and print HTML exports show the
unchanged frequency distribution of item values 1 through 7, the number of
reference-anchor values, intermediate values, and non-scored items. JSON remains
the unchanged persisted report object; CSV preserves each original item value.

With only nine items, the diagnostic sets no automatic warning threshold and
changes no rating. Noticeable concentrations at 1, 4, and 7 can only be
compared descriptively across interviews, separately by instrument fingerprint,
codebook version, prompt version, and model.

## Later Blinded Double Coding

For formal validation, at least two trained human coders will independently
rate a sample of finalized transcripts. They will receive the same rubric,
anchors, and codebook, but neither the model scores nor each other's ratings.
Ambiguous cases will be calibrated beforehand in a separate training sample.

For each item, the score or non-score status, cited evidence, and confidence
will be recorded. `insufficient_evidence`, `not_applicable`, and `conflicting`
remain distinct statuses and are not converted into substitute values.

## Planned Reliability Measures

- For ordinal item values: linear and quadratic weighted Cohen's kappa with
  confidence intervals.
- For descriptive dimension values: ICC with a prespecified model, type, and
  consistency/agreement definition.
- For non-score statuses: a separate agreement matrix and unweighted kappa.
- In addition: absolute agreement, the distribution of differences, and
  systematic model-human differences.

Kappa and ICC will be calculated only when genuine independent double coding
exists. The current report shows `coderAgreement.status = "not_measured"`.

## Open Methodological Work

- Review the pilot interpolation codebook and training material with domain
  experts.
- Define sampling and power plans before the reliability study.
- Systematically examine anchor clarity and content validity.
- Check the interview guide for coverage and potentially leading wording.
- Examine sensitivity to role, event type, and lack of crisis experience.
- Justify an aggregation rule empirically only after adequate coverage.
