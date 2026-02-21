import { describe, expect, it, vi } from 'vitest';
import type { Node as ProseMirrorNode } from 'prosemirror-model';
import type { Editor } from '../core/Editor.js';
import { createParagraphAdapter, createHeadingAdapter } from './create-adapter.js';
import * as trackedChangeResolver from './helpers/tracked-change-resolver.js';

type MockNode = ProseMirrorNode & {
  _children?: MockNode[];
  marks?: Array<{ type: { name: string }; attrs?: Record<string, unknown> }>;
};

function createTextNode(text: string, marks: MockNode['marks'] = []): MockNode {
  return {
    type: { name: 'text' },
    text,
    marks,
    nodeSize: text.length,
    isText: true,
    isInline: true,
    isBlock: false,
    isLeaf: false,
    inlineContent: false,
    isTextblock: false,
    childCount: 0,
    child() {
      throw new Error('text node has no children');
    },
    descendants() {
      return undefined;
    },
  } as unknown as MockNode;
}

function createParagraphNode(
  id: string,
  text = '',
  tracked = false,
  extraAttrs: Record<string, unknown> = {},
): MockNode {
  const marks =
    tracked && text.length > 0
      ? [
          {
            type: { name: 'trackInsert' },
            attrs: { id: `tc-${id}` },
          },
        ]
      : [];
  const children = text.length > 0 ? [createTextNode(text, marks)] : [];
  const contentSize = children.reduce((sum, child) => sum + child.nodeSize, 0);

  return {
    type: { name: 'paragraph' },
    attrs: { sdBlockId: id, ...extraAttrs },
    _children: children,
    nodeSize: contentSize + 2,
    isText: false,
    isInline: false,
    isBlock: true,
    isLeaf: false,
    inlineContent: true,
    isTextblock: true,
    childCount: children.length,
    child(index: number) {
      return children[index] as unknown as ProseMirrorNode;
    },
    descendants(callback: (node: ProseMirrorNode, pos: number) => void) {
      let offset = 1;
      for (const child of children) {
        callback(child as unknown as ProseMirrorNode, offset);
        offset += child.nodeSize;
      }
      return undefined;
    },
  } as unknown as MockNode;
}

function createDocNode(children: MockNode[]): MockNode {
  const node = {
    type: { name: 'doc' },
    _children: children,
    isText: false,
    isInline: false,
    isBlock: false,
    isLeaf: false,
    inlineContent: false,
    isTextblock: false,
    childCount: children.length,
    child(index: number) {
      return children[index] as unknown as ProseMirrorNode;
    },
    get nodeSize() {
      return this.content.size + 2;
    },
    get content() {
      return {
        size: children.reduce((sum, child) => sum + child.nodeSize, 0),
      };
    },
    descendants(callback: (node: ProseMirrorNode, pos: number) => void) {
      let pos = 0;
      for (const child of children) {
        callback(child as unknown as ProseMirrorNode, pos);
        let offset = 1;
        for (const grandChild of child._children ?? []) {
          callback(grandChild as unknown as ProseMirrorNode, pos + offset);
          offset += grandChild.nodeSize;
        }
        pos += child.nodeSize;
      }
      return undefined;
    },
    nodesBetween(this: MockNode, from: number, to: number, callback: (node: ProseMirrorNode) => void) {
      const size = this.content.size;
      if (!Number.isFinite(size)) {
        throw new Error('nodesBetween called without document context');
      }
      let pos = 0;
      for (const child of children) {
        const childStart = pos;
        const childEnd = pos + child.nodeSize;
        if (childEnd < from || childStart > to) {
          pos += child.nodeSize;
          continue;
        }

        callback(child as unknown as ProseMirrorNode);
        for (const grandChild of child._children ?? []) {
          callback(grandChild as unknown as ProseMirrorNode);
        }
        pos += child.nodeSize;
      }
    },
  } as unknown as MockNode;

  return node;
}

function insertChildAtPos(doc: MockNode, child: MockNode, pos: number): boolean {
  const children = doc._children ?? [];
  let cursor = 0;

  for (let index = 0; index <= children.length; index += 1) {
    if (cursor === pos) {
      children.splice(index, 0, child);
      doc.childCount = children.length;
      return true;
    }

    if (index < children.length) {
      cursor += children[index]!.nodeSize;
    }
  }

  return false;
}

function makeEditor({
  withTrackedCommand = true,
  insertReturns = true,
  insertedParagraphAttrs,
  user,
}: {
  withTrackedCommand?: boolean;
  insertReturns?: boolean;
  insertedParagraphAttrs?: Record<string, unknown>;
  user?: { name: string };
} = {}): {
  editor: Editor;
  insertParagraphAt: ReturnType<typeof vi.fn>;
} {
  const doc = createDocNode([createParagraphNode('p1', 'Hello')]);

  const insertParagraphAt = vi.fn((options: { pos: number; text?: string; sdBlockId?: string; tracked?: boolean }) => {
    if (!insertReturns) return false;
    const nodeId = options.sdBlockId ?? 'new-paragraph';
    const paragraph = createParagraphNode(nodeId, options.text ?? '', options.tracked === true, insertedParagraphAttrs);
    return insertChildAtPos(doc, paragraph, options.pos);
  });

  const editor = {
    state: {
      doc,
    },
    commands: {
      insertParagraphAt,
      insertTrackedChange: withTrackedCommand ? vi.fn(() => true) : undefined,
    },
    can: () => ({
      insertParagraphAt: () => insertReturns,
    }),
    options: { user },
  } as unknown as Editor;

  return { editor, insertParagraphAt };
}

describe('createParagraphAdapter', () => {
  it('creates a paragraph at the document end by default', () => {
    const { editor, insertParagraphAt } = makeEditor();

    const result = createParagraphAdapter(editor, { text: 'New paragraph' }, { changeMode: 'direct' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.paragraph.kind).toBe('block');
      expect(result.paragraph.nodeType).toBe('paragraph');
      expect(result.insertionPoint.kind).toBe('text');
      expect(result.insertionPoint.range).toEqual({ start: 0, end: 0 });
    }

    expect(insertParagraphAt).toHaveBeenCalledTimes(1);
    expect(insertParagraphAt.mock.calls[0]?.[0]).toMatchObject({
      text: 'New paragraph',
      tracked: false,
    });
  });

  it('creates a paragraph before a target block', () => {
    const { editor, insertParagraphAt } = makeEditor();

    const result = createParagraphAdapter(
      editor,
      {
        at: {
          kind: 'before',
          target: { kind: 'block', nodeType: 'paragraph', nodeId: 'p1' },
        },
      },
      { changeMode: 'direct' },
    );

    expect(result.success).toBe(true);
    expect(insertParagraphAt.mock.calls[0]?.[0]?.pos).toBe(0);
  });

  it('throws TARGET_NOT_FOUND when a before/after target cannot be resolved', () => {
    const { editor } = makeEditor();

    expect(() =>
      createParagraphAdapter(
        editor,
        {
          at: {
            kind: 'after',
            target: { kind: 'block', nodeType: 'paragraph', nodeId: 'missing' },
          },
        },
        { changeMode: 'direct' },
      ),
    ).toThrow('target block was not found');
  });

  it('throws CAPABILITY_UNAVAILABLE when tracked create is requested without tracked capability', () => {
    const { editor } = makeEditor({ withTrackedCommand: false });

    expect(() => createParagraphAdapter(editor, { text: 'Tracked' }, { changeMode: 'tracked' })).toThrow(
      'requires the insertTrackedChange command',
    );
  });

  it('creates tracked paragraphs without losing nodesBetween context', () => {
    const resolverSpy = vi.spyOn(trackedChangeResolver, 'buildTrackedChangeCanonicalIdMap').mockReturnValue(new Map());

    const { editor } = makeEditor({ user: { name: 'Test' } });

    const result = createParagraphAdapter(editor, { text: 'Tracked paragraph' }, { changeMode: 'tracked' });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.trackedChangeRefs?.length).toBeGreaterThan(0);
    expect(result.trackedChangeRefs?.[0]).toMatchObject({
      kind: 'entity',
      entityType: 'trackedChange',
    });
    expect(resolverSpy).toHaveBeenCalledTimes(1);
    resolverSpy.mockRestore();
  });

  it('returns INVALID_TARGET failure when command cannot apply the insertion', () => {
    const { editor } = makeEditor({ insertReturns: false });

    const result = createParagraphAdapter(editor, { text: 'No-op' }, { changeMode: 'direct' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.failure.code).toBe('INVALID_TARGET');
    }
  });

  it('dry-run returns placeholder success without mutating the document', () => {
    const { editor, insertParagraphAt } = makeEditor();

    const result = createParagraphAdapter(editor, { text: 'Dry run text' }, { changeMode: 'direct', dryRun: true });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.paragraph).toEqual({ kind: 'block', nodeType: 'paragraph', nodeId: '(dry-run)' });
    expect(result.insertionPoint).toEqual({ kind: 'text', blockId: '(dry-run)', range: { start: 0, end: 0 } });
    expect(insertParagraphAt).not.toHaveBeenCalled();
  });

  it('dry-run returns INVALID_TARGET when insertion cannot be applied', () => {
    const { editor } = makeEditor({ insertReturns: false });

    const result = createParagraphAdapter(editor, { text: 'Dry run text' }, { changeMode: 'direct', dryRun: true });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.failure.code).toBe('INVALID_TARGET');
  });

  it('dry-run still throws TARGET_NOT_FOUND when target block does not exist', () => {
    const { editor } = makeEditor();

    expect(() =>
      createParagraphAdapter(
        editor,
        {
          at: {
            kind: 'before',
            target: { kind: 'block', nodeType: 'paragraph', nodeId: 'missing' },
          },
        },
        { changeMode: 'direct', dryRun: true },
      ),
    ).toThrow('target block was not found');
  });

  it('dry-run still throws CAPABILITY_UNAVAILABLE when tracked capability is missing', () => {
    const { editor } = makeEditor({ withTrackedCommand: false });

    expect(() =>
      createParagraphAdapter(editor, { text: 'Tracked dry run' }, { changeMode: 'tracked', dryRun: true }),
    ).toThrow('requires the insertTrackedChange command');
  });

  it('resolves created paragraph by sdBlockId even when paraId is also present', () => {
    const { editor } = makeEditor({
      insertedParagraphAttrs: {
        paraId: 'pm-para-id',
      },
    });

    const result = createParagraphAdapter(editor, { text: 'Inserted paragraph' }, { changeMode: 'direct' });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.paragraph.nodeType).toBe('paragraph');
    // sdBlockId takes priority — the returned ID is always the one the create command assigned.
    expect(result.paragraph.nodeId).not.toBe('pm-para-id');
    expect(typeof result.paragraph.nodeId).toBe('string');
    expect(result.insertionPoint.blockId).toBe(result.paragraph.nodeId);
  });

  it('returns success with generated ID when post-apply paragraph resolution fails', () => {
    const { editor } = makeEditor({
      insertedParagraphAttrs: {
        sdBlockId: undefined,
      },
    });

    const result = createParagraphAdapter(editor, { text: 'Inserted paragraph' }, { changeMode: 'direct' });

    // Contract: success:false means no mutation was applied.
    // The mutation DID apply, so we must return success with the generated ID.
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.paragraph.nodeType).toBe('paragraph');
    expect(typeof result.paragraph.nodeId).toBe('string');
    expect(result.paragraph.nodeId).not.toBe('(dry-run)');
  });

  it('throws CAPABILITY_UNAVAILABLE for tracked dry-run without a configured user', () => {
    const { editor } = makeEditor();

    expect(() => createParagraphAdapter(editor, { text: 'Tracked' }, { changeMode: 'tracked', dryRun: true })).toThrow(
      'requires a user to be configured',
    );
  });

  it('throws same error for tracked non-dry-run without a configured user', () => {
    const { editor } = makeEditor();

    expect(() => createParagraphAdapter(editor, { text: 'Tracked' }, { changeMode: 'tracked' })).toThrow(
      'requires a user to be configured',
    );
  });

  it('creates a paragraph before a target resolved by nodeId shorthand', () => {
    const { editor, insertParagraphAt } = makeEditor();

    const result = createParagraphAdapter(
      editor,
      {
        at: { kind: 'before', nodeId: 'p1' },
      },
      { changeMode: 'direct' },
    );

    expect(result.success).toBe(true);
    expect(insertParagraphAt.mock.calls[0]?.[0]?.pos).toBe(0);
  });

  it('creates a paragraph after a target resolved by nodeId shorthand', () => {
    const { editor, insertParagraphAt } = makeEditor();

    const result = createParagraphAdapter(
      editor,
      {
        at: { kind: 'after', nodeId: 'p1' },
      },
      { changeMode: 'direct' },
    );

    expect(result.success).toBe(true);
    // 'Hello' paragraph nodeSize = 7, so after position = 7
    expect(insertParagraphAt.mock.calls[0]?.[0]?.pos).toBe(7);
  });

  it('throws TARGET_NOT_FOUND when nodeId shorthand cannot be resolved', () => {
    const { editor } = makeEditor();

    expect(() =>
      createParagraphAdapter(
        editor,
        {
          at: { kind: 'before', nodeId: 'missing' },
        },
        { changeMode: 'direct' },
      ),
    ).toThrow('was not found');
  });

  it('throws AMBIGUOUS_TARGET when nodeId shorthand matches multiple blocks', () => {
    const doc = createDocNode([createParagraphNode('dup', 'First'), createParagraphNode('dup', 'Second')]);
    const editor = {
      state: { doc },
      commands: { insertParagraphAt: vi.fn(() => true) },
      can: () => ({ insertParagraphAt: () => true }),
      options: {},
    } as unknown as Editor;

    expect(() =>
      createParagraphAdapter(editor, { at: { kind: 'before', nodeId: 'dup' } }, { changeMode: 'direct' }),
    ).toThrow('Multiple blocks share nodeId');
  });

  it('resolves by nodeId when location object has an undefined target key (object spread edge case)', () => {
    const { editor, insertParagraphAt } = makeEditor();

    // Simulates { ...defaults, kind: 'before', nodeId: 'p1' } where defaults = { target: undefined }
    const location = {
      kind: 'before' as const,
      nodeId: 'p1',
      target: undefined,
    } as unknown as import('@superdoc/document-api').ParagraphCreateLocation;

    const result = createParagraphAdapter(editor, { at: location }, { changeMode: 'direct' });

    expect(result.success).toBe(true);
    expect(insertParagraphAt.mock.calls[0]?.[0]?.pos).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// createHeadingAdapter
// ---------------------------------------------------------------------------

function createHeadingNode(
  id: string,
  level: number,
  text = '',
  tracked = false,
  extraAttrs: Record<string, unknown> = {},
): MockNode {
  const marks =
    tracked && text.length > 0
      ? [
          {
            type: { name: 'trackInsert' },
            attrs: { id: `tc-${id}` },
          },
        ]
      : [];
  const children = text.length > 0 ? [createTextNode(text, marks)] : [];
  const contentSize = children.reduce((sum, child) => sum + child.nodeSize, 0);

  return {
    type: { name: 'paragraph' },
    attrs: {
      sdBlockId: id,
      paragraphProperties: { styleId: `Heading${level}` },
      ...extraAttrs,
    },
    _children: children,
    nodeSize: contentSize + 2,
    isText: false,
    isInline: false,
    isBlock: true,
    isLeaf: false,
    inlineContent: true,
    isTextblock: true,
    childCount: children.length,
    child(index: number) {
      return children[index] as unknown as ProseMirrorNode;
    },
    descendants(callback: (node: ProseMirrorNode, pos: number) => void) {
      let offset = 1;
      for (const child of children) {
        callback(child as unknown as ProseMirrorNode, offset);
        offset += child.nodeSize;
      }
      return undefined;
    },
  } as unknown as MockNode;
}

function makeHeadingEditor({
  withTrackedCommand = true,
  insertReturns = true,
  insertedHeadingAttrs,
  user,
}: {
  withTrackedCommand?: boolean;
  insertReturns?: boolean;
  insertedHeadingAttrs?: Record<string, unknown>;
  user?: { name: string };
} = {}): {
  editor: Editor;
  insertHeadingAt: ReturnType<typeof vi.fn>;
} {
  const doc = createDocNode([createParagraphNode('p1', 'Hello')]);

  const insertHeadingAt = vi.fn(
    (options: { pos: number; level: number; text?: string; sdBlockId?: string; tracked?: boolean }) => {
      if (!insertReturns) return false;
      const nodeId = options.sdBlockId ?? 'new-heading';
      const heading = createHeadingNode(
        nodeId,
        options.level,
        options.text ?? '',
        options.tracked === true,
        insertedHeadingAttrs,
      );
      return insertChildAtPos(doc, heading, options.pos);
    },
  );

  const editor = {
    state: {
      doc,
    },
    commands: {
      insertHeadingAt,
      insertTrackedChange: withTrackedCommand ? vi.fn(() => true) : undefined,
    },
    can: () => ({
      insertHeadingAt: (opts: { pos: number; level: number }) => {
        if (!insertReturns) return false;
        return opts.level >= 1 && opts.level <= 6;
      },
    }),
    options: { user },
  } as unknown as Editor;

  return { editor, insertHeadingAt };
}

describe('createHeadingAdapter', () => {
  it('creates a heading at the document end by default', () => {
    const { editor, insertHeadingAt } = makeHeadingEditor();

    const result = createHeadingAdapter(editor, { level: 2, text: 'New heading' }, { changeMode: 'direct' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.heading.kind).toBe('block');
      expect(result.heading.nodeType).toBe('heading');
      expect(result.insertionPoint.kind).toBe('text');
      expect(result.insertionPoint.range).toEqual({ start: 0, end: 0 });
    }

    expect(insertHeadingAt).toHaveBeenCalledTimes(1);
    expect(insertHeadingAt.mock.calls[0]?.[0]).toMatchObject({
      level: 2,
      text: 'New heading',
      tracked: false,
    });
  });

  it('creates a heading before a target block', () => {
    const { editor, insertHeadingAt } = makeHeadingEditor();

    const result = createHeadingAdapter(
      editor,
      {
        level: 1,
        at: {
          kind: 'before',
          target: { kind: 'block', nodeType: 'paragraph', nodeId: 'p1' },
        },
      },
      { changeMode: 'direct' },
    );

    expect(result.success).toBe(true);
    expect(insertHeadingAt.mock.calls[0]?.[0]?.pos).toBe(0);
  });

  it('throws TARGET_NOT_FOUND when a before/after target cannot be resolved', () => {
    const { editor } = makeHeadingEditor();

    expect(() =>
      createHeadingAdapter(
        editor,
        {
          level: 1,
          at: {
            kind: 'after',
            target: { kind: 'block', nodeType: 'paragraph', nodeId: 'missing' },
          },
        },
        { changeMode: 'direct' },
      ),
    ).toThrow('target block was not found');
  });

  it('throws CAPABILITY_UNAVAILABLE when tracked create is requested without tracked capability', () => {
    const { editor } = makeHeadingEditor({ withTrackedCommand: false });

    expect(() => createHeadingAdapter(editor, { level: 1, text: 'Tracked' }, { changeMode: 'tracked' })).toThrow(
      'requires the insertTrackedChange command',
    );
  });

  it('creates tracked headings and returns trackedChangeRefs', () => {
    const resolverSpy = vi.spyOn(trackedChangeResolver, 'buildTrackedChangeCanonicalIdMap').mockReturnValue(new Map());

    const { editor } = makeHeadingEditor({ user: { name: 'Test' } });

    const result = createHeadingAdapter(editor, { level: 1, text: 'Tracked heading' }, { changeMode: 'tracked' });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.trackedChangeRefs?.length).toBeGreaterThan(0);
    expect(result.trackedChangeRefs?.[0]).toMatchObject({
      kind: 'entity',
      entityType: 'trackedChange',
    });
    expect(resolverSpy).toHaveBeenCalledTimes(1);
    resolverSpy.mockRestore();
  });

  it('returns INVALID_TARGET failure when command cannot apply the insertion', () => {
    const { editor } = makeHeadingEditor({ insertReturns: false });

    const result = createHeadingAdapter(editor, { level: 1, text: 'No-op' }, { changeMode: 'direct' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.failure.code).toBe('INVALID_TARGET');
    }
  });

  it('dry-run returns placeholder success without mutating the document', () => {
    const { editor, insertHeadingAt } = makeHeadingEditor();

    const result = createHeadingAdapter(
      editor,
      { level: 1, text: 'Dry run text' },
      { changeMode: 'direct', dryRun: true },
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.heading).toEqual({ kind: 'block', nodeType: 'heading', nodeId: '(dry-run)' });
    expect(result.insertionPoint).toEqual({ kind: 'text', blockId: '(dry-run)', range: { start: 0, end: 0 } });
    expect(insertHeadingAt).not.toHaveBeenCalled();
  });

  it('dry-run returns INVALID_TARGET when insertion cannot be applied', () => {
    const { editor } = makeHeadingEditor({ insertReturns: false });

    const result = createHeadingAdapter(
      editor,
      { level: 1, text: 'Dry run text' },
      { changeMode: 'direct', dryRun: true },
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.failure.code).toBe('INVALID_TARGET');
  });

  it('dry-run still throws TARGET_NOT_FOUND when target block does not exist', () => {
    const { editor } = makeHeadingEditor();

    expect(() =>
      createHeadingAdapter(
        editor,
        {
          level: 1,
          at: {
            kind: 'before',
            target: { kind: 'block', nodeType: 'paragraph', nodeId: 'missing' },
          },
        },
        { changeMode: 'direct', dryRun: true },
      ),
    ).toThrow('target block was not found');
  });

  it('dry-run still throws CAPABILITY_UNAVAILABLE when tracked capability is missing', () => {
    const { editor } = makeHeadingEditor({ withTrackedCommand: false });

    expect(() =>
      createHeadingAdapter(editor, { level: 1, text: 'Tracked dry run' }, { changeMode: 'tracked', dryRun: true }),
    ).toThrow('requires the insertTrackedChange command');
  });

  it('returns success with generated ID when post-apply heading resolution fails', () => {
    const { editor } = makeHeadingEditor({
      insertedHeadingAttrs: {
        sdBlockId: undefined,
        paragraphProperties: {},
      },
    });

    const result = createHeadingAdapter(editor, { level: 1, text: 'Inserted heading' }, { changeMode: 'direct' });

    // Contract: success:false means no mutation was applied.
    // The mutation DID apply, so we must return success with the generated ID.
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.heading.nodeType).toBe('heading');
    expect(typeof result.heading.nodeId).toBe('string');
    expect(result.heading.nodeId).not.toBe('(dry-run)');
  });

  it('throws CAPABILITY_UNAVAILABLE for tracked dry-run without a configured user', () => {
    const { editor } = makeHeadingEditor();

    expect(() =>
      createHeadingAdapter(editor, { level: 1, text: 'Tracked' }, { changeMode: 'tracked', dryRun: true }),
    ).toThrow('requires a user to be configured');
  });

  it('throws same error for tracked non-dry-run without a configured user', () => {
    const { editor } = makeHeadingEditor();

    expect(() => createHeadingAdapter(editor, { level: 1, text: 'Tracked' }, { changeMode: 'tracked' })).toThrow(
      'requires a user to be configured',
    );
  });

  it('creates a heading before a target resolved by nodeId shorthand', () => {
    const { editor, insertHeadingAt } = makeHeadingEditor();

    const result = createHeadingAdapter(
      editor,
      {
        level: 2,
        at: { kind: 'before', nodeId: 'p1' },
      },
      { changeMode: 'direct' },
    );

    expect(result.success).toBe(true);
    expect(insertHeadingAt.mock.calls[0]?.[0]?.pos).toBe(0);
  });

  it('creates a heading after a target resolved by nodeId shorthand', () => {
    const { editor, insertHeadingAt } = makeHeadingEditor();

    const result = createHeadingAdapter(
      editor,
      {
        level: 1,
        at: { kind: 'after', nodeId: 'p1' },
      },
      { changeMode: 'direct' },
    );

    expect(result.success).toBe(true);
    expect(insertHeadingAt.mock.calls[0]?.[0]?.pos).toBe(7);
  });

  it('throws TARGET_NOT_FOUND when heading nodeId shorthand cannot be resolved', () => {
    const { editor } = makeHeadingEditor();

    expect(() =>
      createHeadingAdapter(
        editor,
        {
          level: 1,
          at: { kind: 'before', nodeId: 'missing' },
        },
        { changeMode: 'direct' },
      ),
    ).toThrow('was not found');
  });

  it('passes level through to the insertHeadingAt command', () => {
    const { editor, insertHeadingAt } = makeHeadingEditor();

    createHeadingAdapter(editor, { level: 3 }, { changeMode: 'direct' });

    expect(insertHeadingAt.mock.calls[0]?.[0]).toMatchObject({ level: 3 });
  });
});

// ---------------------------------------------------------------------------
// BUG: Returned nodeId from create is not composable with getNodeById
// ---------------------------------------------------------------------------
// These tests expose a real bug: when a created paragraph later gains a paraId
// (e.g. through DOCX import merge or round-trip), the ID returned by
// create.paragraph can no longer be used with getNodeById — because the block
// index resolves the node by paraId (higher priority) instead of sdBlockId.

import { getNodeByIdAdapter } from './get-node-adapter.js';
import { buildBlockIndex } from './helpers/node-address-resolver.js';
import { clearIndexCache } from './helpers/index-cache.js';

describe('BUG: create → getNodeById composability', () => {
  it('returned nodeId from create.paragraph should be resolvable by getNodeById after paraId injection', () => {
    // Step 1: Create a paragraph — sdBlockId is the only ID, so create returns it.
    const { editor } = makeEditor();
    const createResult = createParagraphAdapter(editor, { text: 'New content' }, { changeMode: 'direct' });

    expect(createResult.success).toBe(true);
    if (!createResult.success) return;

    const returnedId = createResult.paragraph.nodeId;

    // Step 2: Simulate the node gaining a paraId (as happens during DOCX round-trip
    // or when a collaboration merge assigns OOXML identity).
    // The node now has BOTH sdBlockId (the returned ID) and paraId (the import ID).
    const doc = editor.state.doc as unknown as MockNode;
    const createdNode = doc._children?.find(
      (child) => (child.attrs as Record<string, unknown>)?.sdBlockId === returnedId,
    );
    expect(createdNode).toBeDefined();

    // Inject a paraId onto the node attrs (simulating DOCX import merge)
    (createdNode!.attrs as Record<string, unknown>).paraId = 'imported-para-id';

    // Clear the index cache so it rebuilds from the mutated document.
    // In a real scenario, a DOCX round-trip or collaboration merge produces
    // a new document snapshot, which naturally invalidates the cache.
    clearIndexCache(editor);

    // Step 3: Try to resolve the node using the ID that create.paragraph returned.
    // This SHOULD work — the ID we gave the consumer should always resolve.
    // BUG: This FAILS because buildBlockIndex prefers paraId over sdBlockId,
    // so the node's resolved ID is now 'imported-para-id', not the returned ID.
    const result = getNodeByIdAdapter(editor, { nodeId: returnedId, nodeType: 'paragraph' });
    expect(result.nodeType).toBe('paragraph');
  });

  it('returned insertionPoint.blockId from create.paragraph should be usable as a target', () => {
    const { editor } = makeEditor();
    const createResult = createParagraphAdapter(editor, { text: 'First' }, { changeMode: 'direct' });

    expect(createResult.success).toBe(true);
    if (!createResult.success) return;

    const blockId = createResult.insertionPoint.blockId;

    // Simulate paraId injection (same as above)
    const doc = editor.state.doc as unknown as MockNode;
    const createdNode = doc._children?.find((child) => (child.attrs as Record<string, unknown>)?.sdBlockId === blockId);
    (createdNode!.attrs as Record<string, unknown>).paraId = 'ooxml-para-id';

    // BUG: The block index now resolves this node as 'ooxml-para-id',
    // so using blockId (the sdBlockId) as a target fails.
    const index = buildBlockIndex(editor);
    const match = index.byId.get(`paragraph:${blockId}`);
    expect(match).toBeDefined();
  });
});
