# Curation Log: Kantur and Iseri-Say Evidence Rating v1

## Scope

This record covers GitHub Issue #2 only. The checked-in JSON is a pilot coding
instrument derived from the nine final Kantur and Iseri-Say (2015) items. It does
not activate the instrument in the application; runtime contracts and persistence
belong to Issue #3.

The original publication validated a five-point self-report scale. This project
instead uses behaviorally described reference points at 1, 4, and 7 for coding
interview evidence. That is a new measurement procedure, not a validated extension
of the published scale.

## Approved Selection

Each item has two approved pilot examples at each reference score. Rows refer to
`Ankerwerte.xlsx`, sheet `Full_Data`; the JSON also records the separately mapped
`Only_Anchor_V` row and every D-I source cell.

| Item   | Score 1 | Score 4 | Score 7 |
| ------ | ------- | ------- | ------- |
| ROB-01 | 7, 8    | 5, 6    | 3, 4    |
| ROB-02 | 14, 15  | 12, 13  | 9, 10   |
| ROB-03 | 20, 21  | 18, 19  | 16, 17  |
| ROB-04 | 28, 29  | 26, 27  | 22, 24  |
| AGI-01 | 38, 39  | 34, 36  | 30, 33  |
| AGI-02 | 46, 47  | 44, 45  | 41, 43  |
| AGI-03 | 52, 53  | 50, 51  | 48, 49  |
| INT-01 | 59, 60  | 57, 58  | 54, 55  |
| INT-02 | 68, 69  | 65, 67  | 62, 63  |

Total: 9 items x 3 reference scores x 2 examples = 54 examples.

## Repaired Empty Slots

- `E7` and `E8`: Lego's existential losses and Starbucks' near-bankruptcy were
  checked against Chen et al. (2021), Tables 3 and 4. Both are time-bounded crisis
  states; their later recovery is not treated as evidence that the prior position
  remained intact.
- `E19`: continuity of an HIV service despite salary delays and security concerns,
  checked in Barasa et al. (2018), page 499. This is a secondary synthesis and is
  deliberately a mid-level, subsystem-specific example.
- `E21`: Gan and Korsgaard's Case D records an explicit decision to give up the
  startup after its turnaround failed, while the case table records the organization
  as no longer existing. This direct abandonment evidence replaces the empty
  low-resistance slot without inferring behavior from a crisis state alone.
- `E28`: Sydnor et al. (2017) provide a primary empirical sample containing 126
  closed businesses after Hurricane Katrina.
- `E29`: de Vries and Hamilton (2021) longitudinally observed four of ten small
  businesses not surviving through 2018 after the Christchurch earthquakes.

These repairs populate the versioned JSON only. The user-owned workbook is not
modified.

## Excluded Candidates

The following filled `Full_Data` rows were not approved:

- `11`: score 7 conflicts with its own rationale, which says to retain score 4.
- `23`, `25`: weaker or less discriminating alternatives for ROB-04.
- `31`, `32`: action is described without a sufficiently strong speed observation.
- `35`, `37`, `40`: weaker, truncated, or citation-defective speed candidates.
- `42`: simple error correction does not demonstrate benefiting from an alternative;
  row 43 was remapped into the second score-7 slot instead.
- `56`: employee importance does not directly establish that all employees perform
  what is required.
- `61`, `64`, `66`, `70`: surplus candidates with weaker item fit than the retained
  Integrity examples.

The unrelated DOI `10.1016/j.ssci.2024.106626` attached to Witmer (2016) in workbook
cells H6 and H58 was removed. It belongs to Krsmanovic et al. (2024). Workbook row
40, which repeats that incorrect DOI, is excluded. Truncated workbook quotations
are represented as source-checked German paraphrases, not silently completed
verbatim quotations.

## Replaced Invalid Candidates

The row references remain stable lineage slots, but the following workbook content
was not approved as empirical evidence. Each replacement is explicitly marked
`replaced_invalid_candidate` in the JSON:

- `4`: a conceptual outcome statement was replaced by Southwest's observed
  maintenance of service standards in Chen et al. (2021), Table 4.
- `10`: a conceptual flexibility description was replaced by the more than 100
  implemented teaching measures in Krsmanovic et al. (2024).
- `34`: a generic speed claim was replaced by the documented reactive
  reorganization of teaching after the pandemic began in Krsmanovic et al. (2024).
- `45`: the workbook's exact Portugal/Tunisia and one-third-cost details could not
  be independently located. They were replaced by Pal's source-checked cross-case
  finding that resilient production firms delocalized production to reduce fixed
  costs.
- `49`: a conceptual autonomy claim was replaced by the documented immediate move
  from seminars to Microsoft Teams in Krsmanovic et al. (2024).
- `50`: a conceptual responsiveness claim was replaced by the documented
  email-and-PDF-signature workaround in Krsmanovic et al. (2024).
- `55`: an unsupported all-employees inference was replaced by Walker et al.'s
  observed employee initiative and adaptation under earthquake disruption.
- `63`: the Isensee interview quotation was available only through the workbook
  and could not be checked in accessible full text. It was replaced by Khurshid et
  al.'s source-checked cross-professional and cross-organizational COVID-response
  evidence.

## Provenance Levels

Every example resolves to a source-catalog entry, an explicit source locator, one
`Full_Data` row, and one `Only_Anchor_V` slot. `verificationStatus` distinguishes:

- `local_primary_checked`: checked against a local source PDF;
- `publisher_source_checked`: checked against publisher metadata or full text;
- `repository_source_checked`: checked against an institutional copy or record.

Every approved example is additionally marked `observed_empirical_evidence` and
`source_content_checked`; workbook-only or merely conceptual material cannot pass
the schema. No source is labeled more strongly than the material actually checked.
The artifact stores source-checked paraphrases, not long verbatim quotations.

## Methodological Limits

- The evidence rating has not yet undergone content-validity testing, cognitive
  interviewing, interrater-reliability testing, or criterion validation.
- Reference anchors define 1, 4, and 7. Scores 2, 3, 5, and 6 require evidence that
  lies between adjacent references. The separate, derived
  `or-evidence-interpolation-codebook@1.0.0` now provides item-specific pilot
  criteria; these criteria are not literature anchors and still require empirical
  calibration.
- Missing evidence is not a low score. A single participant statement is not by
  itself an organization-level fact.
- No dimension or total-score aggregation rule is defined. Reporting one would be
  a separate methodological decision requiring validation.
- Several retained examples concern the same underlying organizations or cases.
  They illustrate different items but are not statistically independent validation
  observations.
- Aggregate closure findings demonstrate non-continuation, not the causal mechanism
  of failure for every organization in those samples.
- Before substantive scientific claims, at least two independent coders should use
  a frozen instrument version on a calibration set, resolve ambiguous cases under a
  documented protocol, and report item-level agreement and uncertainty.

## Reproducibility

The source workbook SHA-256 is embedded in the JSON. The instrument fingerprint is
computed after strict schema parsing and recursive lexical object-key ordering;
array order remains significant. Run:

```sh
npm run research:validate
```

The expected digests are stored beside the instrument and interpolation JSON files
in their `.sha256` sidecars and do not participate in their own hashes. The
synthetic `calibration-cases-v1.json` is a versioned test fixture, not an empirical
source artifact.
