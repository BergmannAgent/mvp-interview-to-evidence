import {
  EVALUATION_PROFILE_DOCUMENT_SCHEMA_VERSION,
  evaluationProfileContentSchema,
  type EvaluationProfile,
  type EvaluationProfileAnchor,
  type EvaluationProfileContent,
  type EvaluationProfileDocument,
  type EvaluationProfilePortable,
} from '@orgscience/contracts';

export interface DraftValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface DraftValidation {
  readonly valid: boolean;
  readonly content: EvaluationProfileContent | null;
  readonly issues: readonly DraftValidationIssue[];
  readonly byPath: ReadonlyMap<string, readonly string[]>;
}

export interface DraftItemEntry {
  readonly item: EvaluationProfileContent['items'][number];
  readonly itemIndex: number;
}

export function starterProfileContent(): EvaluationProfileContent {
  return {
    name: 'Neues Bewertungsprofil',
    description: '',
    coderPrompt: 'Bewerte jedes Item ausschließlich anhand der beobachtbaren Interviewevidenz.',
    scale: { minimum: 1, maximum: 7 },
    dimensions: [{ dimensionId: 'dimension-1', name: 'Dimension 1', order: 0 }],
    items: [starterItem('item-1', 'dimension-1', 0)],
  };
}

export function contentFromProfile(profile: EvaluationProfile): EvaluationProfileContent {
  return cloneContent(profile);
}

export function contentFromPortable(profile: EvaluationProfilePortable): EvaluationProfileContent {
  return cloneContent(profile);
}

export function documentFromPortable(
  profile: EvaluationProfilePortable,
): EvaluationProfileDocument {
  return {
    schemaVersion: EVALUATION_PROFILE_DOCUMENT_SCHEMA_VERSION,
    profile: structuredClone(profile),
  };
}

export function validateDraft(content: EvaluationProfileContent): DraftValidation {
  const parsed = evaluationProfileContentSchema.safeParse(content);
  if (parsed.success) {
    return { valid: true, content: parsed.data, issues: [], byPath: new Map() };
  }

  const issues = parsed.error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: germanValidationMessage(issue.message),
  }));
  const grouped = new Map<string, string[]>();
  for (const issue of issues) {
    const values = grouped.get(issue.path) ?? [];
    if (!values.includes(issue.message)) values.push(issue.message);
    grouped.set(issue.path, values);
  }
  return { valid: false, content: null, issues, byPath: grouped };
}

export function firstError(validation: DraftValidation, ...paths: string[]): string | null {
  for (const path of paths) {
    const exact = validation.byPath.get(path)?.[0];
    if (exact !== undefined) return exact;
    for (const [candidate, messages] of validation.byPath) {
      if (candidate.startsWith(`${path}.`) && messages[0] !== undefined) return messages[0];
    }
  }
  return null;
}

export function isSameContent(
  left: EvaluationProfileContent,
  right: EvaluationProfileContent,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function addDimension(content: EvaluationProfileContent): EvaluationProfileContent {
  const next = cloneContent(content);
  const dimensionId = nextId(
    'dimension',
    next.dimensions.map(({ dimensionId: id }) => id),
  );
  const itemId = nextId(
    'item',
    next.items.map(({ itemId: id }) => id),
  );
  next.dimensions.push({
    dimensionId,
    name: `Dimension ${String(next.dimensions.length + 1)}`,
    order: next.dimensions.length,
  });
  next.items.push(starterItem(itemId, dimensionId, 0));
  return normalize(next);
}

export function removeDimension(
  content: EvaluationProfileContent,
  dimensionIndex: number,
): EvaluationProfileContent {
  if (content.dimensions.length <= 1) return content;
  const next = cloneContent(content);
  const groups = positionalItemGroups(next);
  next.dimensions.splice(dimensionIndex, 1);
  groups.splice(dimensionIndex, 1);
  next.items = groups.flat();
  return normalize(next);
}

export function moveDimension(
  content: EvaluationProfileContent,
  dimensionIndex: number,
  offset: -1 | 1,
): EvaluationProfileContent {
  const target = dimensionIndex + offset;
  if (target < 0 || target >= content.dimensions.length) return content;
  const next = cloneContent(content);
  const groups = positionalItemGroups(next);
  next.dimensions = move(next.dimensions, dimensionIndex, target);
  next.items = move(groups, dimensionIndex, target).flat();
  return normalize(next);
}

export function updateDimension(
  content: EvaluationProfileContent,
  dimensionIndex: number,
  field: 'dimensionId' | 'name',
  value: string,
): EvaluationProfileContent {
  const current = content.dimensions[dimensionIndex];
  if (current === undefined) return content;
  const next = cloneContent(content);
  const previousId = current.dimensionId;
  const changed = next.dimensions[dimensionIndex];
  if (changed === undefined) return content;
  changed[field] = value;
  if (field === 'dimensionId') {
    const groups = positionalItemGroups(next);
    const targetItems = new Set(groups[dimensionIndex] ?? []);
    next.items = next.items.map((item) =>
      targetItems.has(item) && item.dimensionId === previousId
        ? { ...item, dimensionId: value }
        : item,
    );
  }
  return normalize(next);
}

export function addItem(
  content: EvaluationProfileContent,
  dimensionIndex: number,
): EvaluationProfileContent {
  const next = cloneContent(content);
  const dimension = next.dimensions[dimensionIndex];
  if (dimension === undefined) return content;
  const groups = positionalItemGroups(next);
  const siblings = groups[dimensionIndex] ?? [];
  const itemId = nextId(
    'item',
    next.items.map(({ itemId: id }) => id),
  );
  groups[dimensionIndex] = [
    ...siblings,
    starterItem(itemId, dimension.dimensionId, siblings.length),
  ];
  next.items = groups.flat();
  return normalize(next);
}

export function removeItem(
  content: EvaluationProfileContent,
  itemIndex: number,
): EvaluationProfileContent {
  const source = content.items[itemIndex];
  if (source === undefined) return content;
  const groups = positionalItemGroups(content);
  if (!groups.some((group) => group.includes(source) && group.length > 1)) return content;
  const next = cloneContent(content);
  next.items.splice(itemIndex, 1);
  return normalize(next);
}

export function moveItem(
  content: EvaluationProfileContent,
  dimensionIndex: number,
  itemOrder: number,
  offset: -1 | 1,
): EvaluationProfileContent {
  const groups = positionalItemGroups(content);
  const siblings = groups[dimensionIndex] ?? [];
  const target = itemOrder + offset;
  if (target < 0 || target >= siblings.length) return content;
  const next = cloneContent(content);
  const nextGroups = positionalItemGroups(next);
  nextGroups[dimensionIndex] = move(nextGroups[dimensionIndex] ?? [], itemOrder, target);
  next.items = nextGroups.flat();
  return normalize(next);
}

export function updateItem(
  content: EvaluationProfileContent,
  itemIndex: number,
  field: 'itemId' | 'name' | 'codingInstruction',
  value: string,
): EvaluationProfileContent {
  const next = cloneContent(content);
  const item = next.items[itemIndex];
  if (item === undefined) return content;
  item[field] = value;
  return next;
}

export function updateDimensionWeight(
  content: EvaluationProfileContent,
  dimensionIndex: number,
  weight: number,
): EvaluationProfileContent {
  if (content.dimensions[dimensionIndex] === undefined) return content;
  const next = cloneContent(content);
  const dimension = next.dimensions[dimensionIndex];
  if (dimension !== undefined) dimension.weight = weight;
  return next;
}

export function updateItemWeight(
  content: EvaluationProfileContent,
  itemIndex: number,
  weight: number,
): EvaluationProfileContent {
  if (content.items[itemIndex] === undefined) return content;
  const next = cloneContent(content);
  const item = next.items[itemIndex];
  if (item !== undefined) item.weight = weight;
  return next;
}

export function updateCalculation(
  content: EvaluationProfileContent,
  calculation: NonNullable<EvaluationProfileContent['calculation']>,
): EvaluationProfileContent {
  return { ...cloneContent(content), calculation: structuredClone(calculation) };
}

export function updateAnchor(
  content: EvaluationProfileContent,
  itemIndex: number,
  anchorIndex: number,
  criterion: string,
): EvaluationProfileContent {
  const next = cloneContent(content);
  const anchor = next.items[itemIndex]?.anchors[anchorIndex];
  if (anchor === undefined) return content;
  anchor.criterion = criterion;
  return next;
}

export function updateMetadata(
  content: EvaluationProfileContent,
  field: 'name' | 'description' | 'coderPrompt',
  value: string,
): EvaluationProfileContent {
  return { ...cloneContent(content), [field]: value };
}

export function itemEntriesByDimensionPosition(
  content: EvaluationProfileContent,
): DraftItemEntry[][] {
  const groups: DraftItemEntry[][] = [];
  for (const [itemIndex, item] of content.items.entries()) {
    if (groups.length === 0 || item.order === 0) groups.push([]);
    groups.at(-1)?.push({ item, itemIndex });
  }
  while (groups.length < content.dimensions.length) groups.push([]);
  return groups;
}

function normalize(content: EvaluationProfileContent): EvaluationProfileContent {
  content.dimensions = content.dimensions.map((dimension, order) => ({ ...dimension, order }));
  const dimensionIds = content.dimensions.map(({ dimensionId }) => dimensionId);
  if (new Set(dimensionIds).size === dimensionIds.length) {
    content.items = content.dimensions.flatMap((dimension) =>
      content.items
        .filter((item) => item.dimensionId === dimension.dimensionId)
        .map((item, order) => ({ ...item, order })),
    );
  } else {
    content.items = positionalItemGroups(content).flatMap((group) =>
      group.map((item, order) => ({ ...item, order })),
    );
  }
  return content;
}

function positionalItemGroups(
  content: EvaluationProfileContent,
): EvaluationProfileContent['items'][] {
  return itemEntriesByDimensionPosition(content).map((group) => group.map(({ item }) => item));
}

function cloneContent(source: {
  readonly name: string;
  readonly description: string;
  readonly coderPrompt: string;
  readonly scale: { readonly minimum: 1; readonly maximum: 7 };
  readonly dimensions: EvaluationProfileContent['dimensions'];
  readonly items: EvaluationProfileContent['items'];
  readonly calculation?: EvaluationProfileContent['calculation'];
}): EvaluationProfileContent {
  return structuredClone({
    name: source.name,
    description: source.description,
    coderPrompt: source.coderPrompt,
    scale: source.scale,
    dimensions: source.dimensions,
    items: source.items,
    ...(source.calculation === undefined ? {} : { calculation: source.calculation }),
  });
}

function starterItem(
  itemId: string,
  dimensionId: string,
  order: number,
): EvaluationProfileContent['items'][number] {
  return {
    itemId,
    dimensionId,
    name: `Item ${String(order + 1)}`,
    codingInstruction: 'Beschreibe die beobachtbare Evidenz, die für dieses Item bewertet wird.',
    order,
    anchors: ([1, 2, 3, 4, 5, 6, 7] as const).map((score): EvaluationProfileAnchor => ({
      score,
      criterion: `Beobachtbares Kriterium für Score ${String(score)}.`,
    })) as EvaluationProfileContent['items'][number]['anchors'],
  };
}

function nextId(prefix: string, existing: readonly string[]): string {
  const used = new Set(existing);
  for (let index = 1; index <= used.size + 1; index += 1) {
    const candidate = `${prefix}-${String(index)}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${prefix}-${String(used.size + 1)}`;
}

function move<Value>(values: readonly Value[], from: number, to: number): Value[] {
  const result = [...values];
  const [value] = result.splice(from, 1);
  if (value === undefined) return [...values];
  result.splice(to, 0, value);
  return result;
}

function germanValidationMessage(message: string): string {
  const translations: Record<string, string> = {
    'Dimension IDs must be unique': 'Dimensions-IDs müssen eindeutig sein.',
    'Dimension order must match its zero-based array position':
      'Die Dimensionsreihenfolge ist ungültig.',
    'Item IDs must be unique': 'Item-IDs müssen eindeutig sein.',
    'Items must reference an existing dimension': 'Das Item verweist auf keine gültige Dimension.',
    'Item order must be contiguous within its dimension': 'Die Itemreihenfolge ist ungültig.',
    'Every dimension must contain at least one item':
      'Jede Dimension benötigt mindestens ein Item.',
    'Items must be grouped by dimension order and then by item order':
      'Items müssen nach Dimension und Reihenfolge gruppiert sein.',
    'Text must not be blank': 'Dieses Feld darf nicht leer sein.',
  };
  return translations[message] ?? message;
}
