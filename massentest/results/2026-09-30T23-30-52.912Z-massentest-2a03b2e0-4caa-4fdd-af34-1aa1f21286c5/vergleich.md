# Evaluation Study: Consistency Comparison

> One synthetic case, ten independent evaluations. This study examines repeatability, not scientific validity.
>
> English presentation translation. Item wording is translated; the corresponding JSON and all German source data remain unchanged.

- Profile: default (`profile-default`, saved 2026-08-21T22:20:13.267Z)
- Profile fingerprint: `8271bee70d141d66084ec12b7bb7327f7136edc4ec1ab02e99e854628a34ce4d`
- Transcript fingerprint: `be02ea2251c81c7093550668bcfce1681305828c36165e3c5c5a78312596d13e`
- Model: openai/gpt-5.6-terra
- Prompt version: profile-evidence-coding-v4
- Evaluation runs: 10; successful 10; failed 0
- Actual model calls: 11 (one repair call per run permitted)
- Distinct item/status vectors: 2

## Result

Item scores or non-score statuses differ between evaluations; identical overall means alone would not rule out these differences.

## Overall Results by Run

| Run | Status | Overall score | Scored items | Non-scores | Model calls | Runtime ms |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | completed | 4.89 | 9 | 0 | 1 | 39547 |
| 2 | completed | 4.78 | 9 | 0 | 2 | 83418 |
| 3 | completed | 4.78 | 9 | 0 | 1 | 39200 |
| 4 | completed | 4.78 | 9 | 0 | 1 | 38316 |
| 5 | completed | 4.89 | 9 | 0 | 1 | 36908 |
| 6 | completed | 4.89 | 9 | 0 | 1 | 47401 |
| 7 | completed | 4.78 | 9 | 0 | 1 | 34604 |
| 8 | completed | 4.78 | 9 | 0 | 1 | 36472 |
| 9 | completed | 4.89 | 9 | 0 | 1 | 40609 |
| 10 | completed | 4.78 | 9 | 0 | 1 | 43696 |

## Item Scores

| Item | R1 | R2 | R3 | R4 | R5 | R6 | R7 | R8 | R9 | R10 | n | Mean | Min | Max | SD | Most frequent value/status | Frequency |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| rob-01 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 10 | 5 | 5 | 5 | 0 | 5 | 10 |
| rob-02 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 10 | 5 | 5 | 5 | 0 | 5 | 10 |
| rob-03 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 10 | 5 | 5 | 5 | 0 | 5 | 10 |
| rob-04 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 10 | 5 | 5 | 5 | 0 | 5 | 10 |
| agi-01 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 10 | 5 | 5 | 5 | 0 | 5 | 10 |
| agi-02 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 10 | 5 | 5 | 5 | 0 | 5 | 10 |
| agi-03 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 10 | 5 | 5 | 5 | 0 | 5 | 10 |
| int-01 | 4 | 4 | 4 | 4 | 4 | 4 | 4 | 4 | 4 | 4 | 10 | 4 | 4 | 4 | 0 | 4 | 10 |
| int-02 | 5 | 4 | 4 | 4 | 5 | 5 | 4 | 4 | 5 | 4 | 10 | 4.4 | 4 | 5 | 0.49 | 4 | 6 |

## Evidence and Rationale

| Item | Wording | Status distribution | Identical sources/direction/evidence types | Identical rationale text |
| --- | --- | --- | --- | --- |
| rob-01 | What does your organization do under difficult conditions to preserve its position and stability? | {"scored":10} | no | no |
| rob-02 | How does your organization develop different solutions when faced with difficult challenges? | {"scored":10} | no | no |
| rob-03 | How does your organization behave when it risks losing something essential? | {"scored":10} | no | no |
| rob-04 | How does your organization deal with setbacks and difficulties when its existing path is threatened? | {"scored":10} | no | no |
| agi-01 | How does your organization act when rapid action is required? | {"scored":10} | no | no |
| agi-02 | How does your organization develop and use alternatives to emerge from adverse circumstances with the ability to act or in a stronger position? | {"scored":10} | no | no |
| agi-03 | How does your organization adapt its actions when the situation changes and concrete measures become necessary? | {"scored":10} | no | no |
| int-01 | How do your organization's employees commit to doing what is required in difficult situations? | {"scored":10} | no | no |
| int-02 | How does your organization act together with its employees when coordinated action is required? | {"scored":10} | no | no |

## Interpretation and Limitations

- The target range 4–5 describes only the construction of the case and was not passed to the coder. Actual scores are never adjusted.
- Overall scores follow the existing pipeline: the arithmetic mean of all scored items, not the mean of dimension means. Non-scores and failed runs are never treated as 0.
- Item means and population standard deviations (SD) use only numeric scores from successful runs. The count n and status distribution are part of the interpretation; n=1 does not support a stability claim.
- The most frequent value/status and its frequency use successful item results, including non-scores. Ties are shown in full; failed runs do not count as item statuses.
- Complete item/status vectors are compared, not only overall means. Evidence comparison covers quotations, sources, direct/indirect classification and direction; text comparison is separate.
- The model-call count includes repairs within the existing pipeline. A repaired output is a result of the same run, not an eleventh independent evaluation.
- The profile and transcript were frozen before the first call. Results were stored neither in Eval Studio nor in the production database.
- Repeatability for one case establishes neither the instrument's validity nor generalizability to other interviews.
