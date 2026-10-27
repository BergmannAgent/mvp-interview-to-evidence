import { describe, expect, it } from 'vitest';
import { EVALUATION_PROFILE_DOCUMENT_SCHEMA_VERSION } from '@orgscience/contracts';

import {
  addDimension,
  addItem,
  contentFromPortable,
  documentFromPortable,
  firstError,
  itemEntriesByDimensionPosition,
  moveDimension,
  moveItem,
  removeItem,
  removeDimension,
  starterProfileContent,
  updateAnchor,
  updateDimension,
  updateDimensionWeight,
  updateItem,
  updateItemWeight,
  updateCalculation,
  updateMetadata,
  validateDraft,
} from './profile-draft.js';

describe('evaluation profile draft', () => {
  it('creates a valid generic 1-to-7 profile without mutating prior drafts', () => {
    const initial = starterProfileContent();
    const expanded = addDimension(initial);
    const withItem = addItem(expanded, 0);
    const reordered = moveItem(withItem, 0, 1, -1);
    const movedDimension = moveDimension(reordered, 1, -1);

    expect(validateDraft(initial).valid).toBe(true);
    expect(validateDraft(movedDimension).valid).toBe(true);
    expect(initial.dimensions).toHaveLength(1);
    expect(initial.items).toHaveLength(1);
    expect(movedDimension.items.every((item) => item.anchors.length === 7)).toBe(true);
    expect(movedDimension.dimensions.map(({ order }) => order)).toEqual([0, 1]);
    expect(itemEntriesByDimensionPosition(movedDimension).map((group) => group.length)).toEqual([
      1, 2,
    ]);
  });

  it('preserves item groups while a dimension id is temporarily duplicated', () => {
    const initial = addDimension(starterProfileContent());
    const originalItemIds = initial.items.map(({ itemId }) => itemId);
    const duplicateId = initial.dimensions[0]?.dimensionId ?? '';

    const invalid = updateDimension(initial, 1, 'dimensionId', duplicateId);

    expect(validateDraft(invalid).valid).toBe(false);
    expect(invalid.items.map(({ itemId }) => itemId)).toEqual(originalItemIds);
    expect(itemEntriesByDimensionPosition(invalid).map((group) => group.length)).toEqual([1, 1]);

    const repaired = updateDimension(invalid, 1, 'dimensionId', 'dimension-repaired');
    expect(validateDraft(repaired).valid).toBe(true);
    expect(repaired.items.map(({ dimensionId }) => dimensionId)).toEqual([
      duplicateId,
      'dimension-repaired',
    ]);
  });

  it('removes exactly one item when item ids are temporarily duplicated', () => {
    const initial = addItem(starterProfileContent(), 0);
    const firstId = initial.items[0]?.itemId ?? '';
    const invalid = updateItem(initial, 1, 'itemId', firstId);

    expect(validateDraft(invalid).valid).toBe(false);
    const reduced = removeItem(invalid, 1);

    expect(reduced.items).toHaveLength(1);
    expect(reduced.items[0]?.itemId).toBe(firstId);
    expect(validateDraft(reduced).valid).toBe(true);
  });

  it('maps anchor validation errors to the corresponding editor field', () => {
    const invalid = updateAnchor(starterProfileContent(), 0, 4, '   ');
    const validation = validateDraft(invalid);

    expect(validation.valid).toBe(false);
    expect(firstError(validation, 'items.0.anchors.4.criterion')).toBe(
      'Dieses Feld darf nicht leer sein.',
    );
  });

  it('preserves calculation and weights through every immutable draft operation', () => {
    const content = updateCalculation(
      updateItemWeight(
        updateDimensionWeight(addItem(addDimension(starterProfileContent()), 0), 0, 2),
        0,
        3,
      ),
      { mode: 'formula', expression: 'item("item-1") * dimensionWeight("dimension-1")' },
    );
    const snapshot = structuredClone(content);
    const operations = [
      addDimension(content),
      addItem(content, 0),
      moveDimension(content, 0, 1),
      moveItem(content, 0, 0, 1),
      removeDimension(content, 1),
      removeItem(content, 1),
      updateDimension(content, 0, 'name', 'Renamed dimension'),
      updateItem(content, 0, 'name', 'Renamed item'),
      updateAnchor(content, 0, 0, 'New criterion'),
      updateMetadata(content, 'description', 'New description'),
    ];
    for (const next of operations) {
      expect(next.calculation).toEqual(content.calculation);
      expect(next.dimensions.find(({ dimensionId }) => dimensionId === 'dimension-1')?.weight).toBe(
        2,
      );
      expect(next.items.find(({ itemId }) => itemId === 'item-1')?.weight).toBe(3);
      expect(validateDraft(next).valid).toBe(true);
    }
    expect(content).toEqual(snapshot);
    expect(operations[0]?.calculation).not.toBe(content.calculation);
  });

  it('preserves portable calculation data and uses the current document version', () => {
    const content = updateCalculation(updateItemWeight(starterProfileContent(), 0, 0), {
      mode: 'formula',
      expression: 'itemWeight("item-1") + 8',
    });
    const portable = { ...content, profileId: 'profile-calculated' };
    const cloned = contentFromPortable(portable);
    expect(cloned).toEqual(content);
    expect(cloned.calculation).not.toBe(content.calculation);
    expect(documentFromPortable(portable).schemaVersion).toBe(
      EVALUATION_PROFILE_DOCUMENT_SCHEMA_VERSION,
    );
    expect(starterProfileContent()).not.toHaveProperty('calculation');
    expect(starterProfileContent().items[0]).not.toHaveProperty('weight');
  });

  it('keeps formula references intact and exposes broken references after renaming or deletion', () => {
    const content = updateCalculation(addDimension(addItem(starterProfileContent(), 0)), {
      mode: 'formula',
      expression: 'item("item-2") + dimension("dimension-2")',
    });
    const renamedItem = updateItem(content, 1, 'itemId', 'item-renamed');
    const renamedDimension = updateDimension(content, 1, 'dimensionId', 'dimension-renamed');
    const removedItem = removeItem(content, 1);
    const removedDimension = removeDimension(content, 1);
    for (const next of [renamedItem, renamedDimension, removedItem, removedDimension]) {
      expect(next.calculation).toEqual(content.calculation);
      expect(validateDraft(next).valid).toBe(false);
      expect(firstError(validateDraft(next), 'calculation.expression')).toContain('unknown');
    }
    expect(validateDraft(content).valid).toBe(true);
  });

  it('accepts zero weights and flags negative or non-finite weights without mutating the source', () => {
    const content = starterProfileContent();
    expect(validateDraft(updateDimensionWeight(updateItemWeight(content, 0, 0), 0, 0)).valid).toBe(
      true,
    );
    for (const weight of [-1, NaN, Infinity]) {
      expect(
        firstError(validateDraft(updateItemWeight(content, 0, weight)), 'items.0.weight'),
      ).not.toBeNull();
      expect(
        firstError(validateDraft(updateDimensionWeight(content, 0, weight)), 'dimensions.0.weight'),
      ).not.toBeNull();
    }
    expect(content.items[0]).not.toHaveProperty('weight');
    expect(content.dimensions[0]).not.toHaveProperty('weight');
  });
});
