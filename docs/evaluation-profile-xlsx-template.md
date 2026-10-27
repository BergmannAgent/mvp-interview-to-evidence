# Evaluation Profile XLSX Template v2

Download the canonical workbook from:

`GET /api/v1/evaluation-profiles/templates/xlsx`

In the local application, open <http://localhost:5275>, choose `Profil importieren`,
select `Excel (.xlsx)`, and use `Generisches Template`. The same dialog previews the
normalized profile and requires explicit confirmation before anything is stored.

The importer accepts the fixed v2 layout and the exact previous v1 layout. It does
not interpret unrelated `Ankerwerte.xlsx` files or infer arbitrary column mappings.
Both versions produce a current schema-v2 JSON profile document; import source
metadata retains the workbook's actual version.

## Worksheets

### `Instructions`

Human-readable editing rules. Keep the worksheet name unchanged. It may contain at
most 100 rows and one column.

### `Profile`

Exactly one data row follows the header:

| Column | Header             | Value                                     |
| ------ | ------------------ | ----------------------------------------- |
| A      | `template_version` | Integer `2`                               |
| B      | `profile_id`       | Stable, unique profile ID                 |
| C      | `name`             | Profile name                              |
| D      | `description`      | Optional description                      |
| E      | `coder_prompt`     | Editable professional coding instructions |
| F      | `aggregation_mode` | `weighted_mean` (default) or `formula`    |
| G      | `custom_formula`   | Plain-text expression in `formula` mode   |

`custom_formula` must be empty in `weighted_mean` mode. A formula expression is
required in `formula` mode. It is inert text, not an executable Excel formula.

### `Dimensions`

| Column | Header         | Value                                     |
| ------ | -------------- | ----------------------------------------- |
| A      | `dimension_id` | Stable dimension ID                       |
| B      | `name`         | Dimension name                            |
| C      | `order`        | Zero-based contiguous integer across rows |
| D      | `weight`       | Optional finite, non-negative number      |

Every dimension must contain at least one item.

### `Items`

| Column | Header               | Value                                       |
| ------ | -------------------- | ------------------------------------------- |
| A      | `item_id`            | Stable item ID                              |
| B      | `dimension_id`       | Existing ID from `Dimensions`               |
| C      | `name`               | Item name                                   |
| D      | `coding_instruction` | Observable evidence to code for this item   |
| E      | `order`              | Zero-based contiguous integer per dimension |
| F      | `weight`             | Optional finite, non-negative number        |

Blank weights default to 1. Dimension scores use item-weighted means of scored
items. The overall weighted mean uses item weight multiplied by dimension weight;
missing scores and effective zero weights are excluded. A zero dimension weight
therefore excludes its items from the overall weighted mean, not from their own
dimension score. If all effective weights are zero, the overall value is null.

Custom expressions can reference stable IDs with `item("item-id")`,
`dimension("dimension-id")`, `itemWeight("item-id")`, and
`dimensionWeight("dimension-id")`. Arithmetic operators `+`, `-`, `*`, `/`, `%`
and approved functions `min`, `max`, `abs`, `pow`, `sqrt`, `round` are supported.
For example, `item("item-1") * 2 + dimension("dimension-1")`.
Null item or dimension values are substituted with 0 and recorded in the report
trace. Custom overall values are finite but not bounded to the 1-7 anchor scale.
Division by zero or a non-finite intermediate value produces a calculation error
and no overall score; it never falls back to the weighted mean.

The old v1 layout has no `aggregation_mode`, `custom_formula`, or `weight` columns
and uses integer `1` in `Profile!A2`. These headers must match v1 exactly; v2
calculation columns cannot be added to a workbook declared as v1.

### `Anchors`

| Column | Header      | Value                                    |
| ------ | ----------- | ---------------------------------------- |
| A      | `item_id`   | Existing ID from `Items`                 |
| B      | `score`     | Integer from `1` through `7`             |
| C      | `criterion` | Observable criterion for that item/score |

Every item requires exactly one row for each score from 1 through 7. The importer
sorts dimensions, items, and anchors by their explicit order values before it
creates the canonical profile document.

## Import Flow

1. Upload one `.xlsx` file in multipart field `file` to
   `POST /api/v1/evaluation-profiles/imports/xlsx/preview`.
2. Inspect the returned profile, dimensions, items, all anchors, and source counts.
3. Confirm the returned canonical `document` through
   `POST /api/v1/evaluation-profiles/imports/json/confirm` with mode `create` or an
   explicit `replace` target and optimistic update token.

Preview never writes profile data. Confirmation revalidates the complete document
and creates a new profile or atomically replaces only the selected profile.

## Validation And Security

- `.xls`, `.xlsm`, path-like names, extra form fields, and files over 10 MiB are
  rejected.
- Worksheet names, headers, row limits, required cells, IDs, references, ordering,
  scores, and all seven anchors are validated without LLM interpretation.
- Errors identify the exact worksheet, row, and column in machine-readable paths.
- Excel formulas, shared formulas, hyperlinks, merged schema cells, macros, ActiveX, OLE,
  images, drawings, charts, embeddings, external relationships, encrypted ZIP
  entries, unsafe paths, and excessive archive expansion are rejected.
- OOXML is parsed incrementally before workbook loading. Entity-encoded security
  attributes, excessive XML elements, worksheet rows/cells, and shared strings are
  rejected before ExcelJS materializes the workbook.
- The format contains no interview-guide or language field. One selected profile
  can be used with any compatible interview transcript.
- Custom calculation expressions are validated against a restricted mathematical
  grammar and known stable IDs. They cannot execute JavaScript or access objects,
  files, links, or the network.
