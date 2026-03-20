import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { __internal } from "../index.js"

test("cleanupPreviewFilesBestEffort 删除已存在的 preview 临时文件", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-preview-cleanup-"))
  const previewA = path.join(tempRoot, "a(Original).txt")
  const previewB = path.join(tempRoot, "b(CodeChanges).txt")

  await fs.writeFile(previewA, "left", "utf8")
  await fs.writeFile(previewB, "right", "utf8")

  await __internal.cleanupPreviewFilesBestEffort(fs, [previewA, previewB])

  await assert.rejects(fs.stat(previewA))
  await assert.rejects(fs.stat(previewB))
})

test("createPreviewArtifactTracker 按 requestID 收集并去重 preview 文件", () => {
  const tracker = __internal.createPreviewArtifactTracker()

  tracker.register("req-1", ["a.txt", "", "a.txt", "b.txt"])
  tracker.register("req-1", ["b.txt", "c.txt"])

  assert.deepEqual(tracker.take("req-1"), ["a.txt", "b.txt", "c.txt"])
  assert.deepEqual(tracker.take("req-1"), [])
})

test("拒绝类 reply 关键字可以被识别", () => {
  assert.equal(__internal.isDenyReply("reject"), true)
  assert.equal(__internal.isDenyReply("deny"), true)
  assert.equal(__internal.isDenyReply("cancel"), true)
  assert.equal(__internal.isDenyReply("once"), false)
  assert.equal(__internal.isDenyReply("always"), false)
})
