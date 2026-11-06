import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  isDirectoryEmpty, cleanOrphans, shortSessionId, removeSessionDir,
} from '../lib/gc.js'

async function stage() {
  return await mkdtemp(join(tmpdir(), 'dsh-gc-test-'))
}

test('shortSessionId normalizes UUIDs and session- prefixes', () => {
  assert.equal(shortSessionId('session-de59473b-0408-4cc6-a5cb-16d3451692f0'), 'de59473b')
  assert.equal(shortSessionId('de59473b'), 'de59473b')
  assert.equal(shortSessionId('session-1a2b3c4d'), '1a2b3c4d')
})

test('isDirectoryEmpty ignores .DS_Store', async () => {
  const dir = await stage()
  try {
    assert.equal(await isDirectoryEmpty(dir), true)
    await writeFile(join(dir, '.DS_Store'), 'stub')
    assert.equal(await isDirectoryEmpty(dir), true)
    await writeFile(join(dir, 'file.txt'), 'content')
    assert.equal(await isDirectoryEmpty(dir), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('cleanOrphans removes empty abandoned session directories older than grace period', async () => {
  const root = await stage()
  try {
    const emptyDir = join(root, 'session-11112222')
    await mkdir(emptyDir)

    // Set mtime to 10 minutes ago
    const tenMinAgo = (Date.now() - 10 * 60 * 1000) / 1000
    await utimes(emptyDir, tenMinAgo, tenMinAgo)

    const cleaned = await cleanOrphans({
      roots: [root],
      knownSessionIds: new Set(),
      now: Date.now(),
    })

    assert.equal(cleaned.length, 1)
    assert.equal(cleaned[0].reason, 'empty-abandoned')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cleanOrphans removes orphan session directories older than TTL', async () => {
  const root = await stage()
  try {
    const orphanDir = join(root, 'session-33334444')
    await mkdir(orphanDir)
    await writeFile(join(orphanDir, 'test.txt'), 'data')

    // Set mtime to 30 hours ago
    const thirtyHoursAgo = (Date.now() - 30 * 60 * 60 * 1000) / 1000
    await utimes(orphanDir, thirtyHoursAgo, thirtyHoursAgo)

    const cleaned = await cleanOrphans({
      roots: [root],
      knownSessionIds: new Set(['session-other']),
      now: Date.now(),
    })

    assert.equal(cleaned.length, 1)
    assert.equal(cleaned[0].reason, 'orphan-ttl')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cleanOrphans retains active session directories', async () => {
  const root = await stage()
  try {
    const activeDir = join(root, 'session-aabbccdd')
    await mkdir(activeDir)
    await writeFile(join(activeDir, 'work.py'), 'code')

    const thirtyHoursAgo = (Date.now() - 30 * 60 * 60 * 1000) / 1000
    await utimes(activeDir, thirtyHoursAgo, thirtyHoursAgo)

    const cleaned = await cleanOrphans({
      roots: [root],
      // Known session matching 'aabbccdd'
      knownSessionIds: new Set(['session-aabbccdd-1234']),
      now: Date.now(),
    })

    assert.equal(cleaned.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
