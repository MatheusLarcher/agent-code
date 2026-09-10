// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { normalizeMemoryEntryWrite, normalizeMemoryProposal, normalizeMemoryRelPath, parseMemoryIndexBullets, renderMemoryIndexFile } from './memoryModel'

const root = process.platform === 'win32' ? 'C:/fixture/memories' : '/fixture/memories'

describe('memory path and proposal rules', () => {
  it.each(['../escape.md', 'folder/../../escape.md', '/absolute.md', '\\absolute.md', 'C:/outside.md', 'C:relative.md', '//server/share.md', 'a//b.md', 'a/./b.md', '.retired/file.md', 'folder/.hidden.md', 'MEMORY.md', 'memory.MD', 'folder/file:stream.md', 'nul.md', 'a/con.md', 'com1.md', 'folder./a.md', 'folder /a.md', 'a/evil\u0000.md'])('rejects unsafe path %j', (relPath) => {
    expect(() => normalizeMemoryRelPath(root, relPath, { kebab: false })).toThrow()
  })

  it('requires kebab new paths while retaining safe legacy paths for updates', () => {
    expect(normalizeMemoryRelPath(root, './topic\\my-note.md', { kebab: true })).toBe('topic/my-note.md')
    expect(normalizeMemoryRelPath(root, 'Legacy Notes/Old_File.MD', { kebab: false })).toBe('Legacy Notes/Old_File.MD')
    expect(() => normalizeMemoryRelPath(root, 'Legacy Notes/Old_File.MD', { kebab: true })).toThrow()
  })

  it('enforces required create metadata and update CAS', () => {
    const input = { op: 'create' as const, relPath: 'note.md', title: 'Note', hook: 'When useful', body: 'Body', proposedBy: 'fixture' }
    expect(normalizeMemoryProposal(root, input)).toMatchObject({ scope: 'user', expectedRevision: null })
    expect(() => normalizeMemoryProposal(root, { ...input, hook: '' })).toThrow()
    expect(() => normalizeMemoryProposal(root, { ...input, body: ' ' })).toThrow()
    expect(() => normalizeMemoryProposal(root, { ...input, proposedBy: '' })).toThrow()
    expect(() => normalizeMemoryProposal(root, { ...input, op: 'update' })).toThrow()
    expect(() => normalizeMemoryProposal(root, { ...input, op: 'update', expectedRevision: 0 })).toThrow()
    expect(normalizeMemoryProposal(root, { ...input, op: 'update', expectedRevision: 2 })).toMatchObject({ expectedRevision: 2 })
  })

  it('also protects repository entry writes against persisted traversal', () => {
    expect(() => normalizeMemoryEntryWrite({ relPath: '../outside.md', title: 'Title', hook: '', body: '', scope: 'user', status: 'active', expectedRevision: 0 })).toThrow()
  })

  it('retains untruncated legacy hooks and deterministically renders grouped bullets', () => {
    const hook = 'Long curated text '.repeat(50)
    const entries = [{ relPath: 'folder/Legacy Notes.md', title: 'Legacy', hook }, { relPath: 'root.md', title: 'Root', hook: 'Root hook' }]
    const markdown = renderMemoryIndexFile(entries)
    expect(markdown).toBe(renderMemoryIndexFile([...entries].reverse()))
    expect(markdown.indexOf('Root hook')).toBeLessThan(markdown.indexOf('## folder'))
    expect(parseMemoryIndexBullets(markdown).get('folder/Legacy Notes.md')).toEqual({ title: 'Legacy', hook: hook.trim() })
  })
})
