type DiffEditor = "code" | "cursor" | "antigravity"

interface DiffConfig {
  editor?: DiffEditor | string
  mode?: "after" | "idle" | "permission"
  openOnPermissionAsked?: boolean
  permissionPreviewMode?: "patch" | "file" | string
  permissionOpenAfterTool?: boolean
  tempDir?: "config" | "workspace" | string
  strategy?: "legacy" | "transaction" | string
  autoStrategy?: boolean
  fallbackToLegacy?: boolean
  transactionEnabled?: boolean
  transactionTimeoutMs?: number
  transactionMaxQueue?: number
}

type TxnState = "queued" | "active_applied" | "done" | "denied" | "timeout" | "failed"

type TxnFile = {
  fsPath: string
  originalExisted: boolean
  originalText: string
  expectedText: string
  originalPreviewPath?: string
}

type Txn = {
  callID: string
  requestID?: string
  askedAt: number
  state: TxnState
  diffText: string
  files: TxnFile[]
  timer?: ReturnType<typeof setTimeout>
}

type FileSystemLike = {
  unlink: (filePath: string) => Promise<void>
}

const uniqueNonEmptyPaths = (filePaths: string[]): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const filePath of filePaths) {
    const normalized = (filePath || "").toString().trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

const cleanupPreviewFilesBestEffort = async (fsLike: FileSystemLike, filePaths: string[]): Promise<void> => {
  for (const filePath of uniqueNonEmptyPaths(filePaths)) {
    try {
      await fsLike.unlink(filePath)
    } catch {
      // ignore
    }
  }
}

const createPreviewArtifactTracker = () => {
  const byRequestID = new Map<string, string[]>()
  return {
    register(requestID: string | undefined, filePaths: string[]) {
      if (!requestID) return
      const prev = byRequestID.get(requestID) || []
      byRequestID.set(requestID, uniqueNonEmptyPaths([...prev, ...filePaths]))
    },
    take(requestID: string | undefined): string[] {
      if (!requestID) return []
      const paths = byRequestID.get(requestID) || []
      byRequestID.delete(requestID)
      return paths
    },
  }
}

const isAllowReply = (reply: string): boolean => {
  const r = (reply || "").toString().trim().toLowerCase()
  return r === "once" || r === "always" || r === "allow"
}

const isDenyReply = (reply: string): boolean => {
  const r = (reply || "").toString().trim().toLowerCase()
  return r === "deny" || r === "never" || r === "no" || r === "cancel" || r === "reject"
}

export const __internal = {
  uniqueNonEmptyPaths,
  cleanupPreviewFilesBestEffort,
  createPreviewArtifactTracker,
  isAllowReply,
  isDenyReply,
}

const DEFAULT_CONFIG: DiffConfig = {
  editor: "code",
  mode: "permission",
  openOnPermissionAsked: true,
  permissionPreviewMode: "file",
  permissionOpenAfterTool: false,
  tempDir: "config",
  autoStrategy: true,
  fallbackToLegacy: true,
  transactionEnabled: true,
  transactionTimeoutMs: 120000,
  transactionMaxQueue: 20,
}

const stripJsonComments = (value: string) =>
  value
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,\s*([}\]])/g, "$1")

const splitPathParts = (filePath: string): string[] => filePath.split(/[\\/]+/).filter(Boolean)

const sanitizeForFileName = (value: string, fallback = "untitled"): string => {
  const s = (value || "").toString()
  const noSeparators = s.replace(/[\\/]+/g, "__")
  const noInvalid = noSeparators.replace(/[<>:"|?*]/g, "_")
  const singleSpace = noInvalid.replace(/\s+/g, " ").trim()
  const noTrailingDots = singleSpace.replace(/[. ]+$/g, "")
  const clipped = noTrailingDots.length > 180 ? noTrailingDots.slice(0, 180).trim() : noTrailingDots
  return clipped || fallback
}

const normalizeToSingleLine = (value: string): string => value.replace(/[\r\n]+/g, " ").trim()

const isWindows = () => (globalThis as any)?.process?.platform === "win32"

export const DiffPreviewPlugin = async ({ directory }: any) => {
  if (!isWindows()) return {}

  const fs = await import("node:fs/promises")
  const path = await import("node:path")
  const os = await import("node:os")
  const childProcess = await import("node:child_process")

  let DIFF_CONFIG: DiffConfig = { ...DEFAULT_CONFIG }
  let RESOLVED_EDITOR: { cmd: string; args: string[] } | null = null
  let txnActive: Txn | null = null
  const txnQueue: Txn[] = []
  const txnManagedCallIDs = new Set<string>()
  const previewArtifactTracker = createPreviewArtifactTracker()

  const homedir = () => {
    try {
      return os.homedir()
    } catch {
      const env = (globalThis as any)?.process?.env || {}
      return (env.USERPROFILE || env.HOME || "").toString()
    }
  }

  const ensureDir = async (dirPath: string): Promise<void> => {
    if (!dirPath) return
    await fs.mkdir(dirPath, { recursive: true })
  }

  const fileExists = async (filePath: string): Promise<boolean> => {
    try {
      await fs.stat(filePath)
      return true
    } catch {
      return false
    }
  }

  const readTextFile = async (filePath: string): Promise<string> => {
    const buf = await fs.readFile(filePath)
    return buf.toString("utf8")
  }

  const writeTextFile = async (filePath: string, content: string): Promise<void> => {
    await ensureDir(path.dirname(filePath))
    await fs.writeFile(filePath, content, "utf8")
  }

  const resolveToFsPath = (filePath: string): string => {
    if (!filePath) return filePath
    if (path.isAbsolute(filePath)) return filePath
    const base = (directory && typeof directory === "string" && directory) || process.cwd()
    return path.resolve(base, filePath)
  }

  const getDiffConfigPath = () => {
    const home = homedir().trim()
    if (!home) return ""
    return path.join(home, ".config", "opencode", "diff.jsonc")
  }

  const getTempDirChoice = (): "config" | "workspace" => {
    const raw = ((DIFF_CONFIG as any)?.tempDir || "config").toString().trim().toLowerCase()
    return raw === "workspace" ? "workspace" : "config"
  }

  const getBackupDir = () => {
    if (getTempDirChoice() === "workspace") {
      const base = (directory && typeof directory === "string" && directory) || process.cwd()
      return path.join(base, ".opencode", ".tmp")
    }
    const home = homedir().trim()
    if (!home) return ""
    return path.join(home, ".config", "opencode", ".tmp")
  }

  const getPreviewDir = async (): Promise<string> => {
    const backupDir = getBackupDir()
    if (!backupDir) return ""
    const previewDir = path.join(backupDir, "preview")
    await ensureDir(previewDir)
    return previewDir
  }

  const getMode = (): "after" | "idle" | "permission" => {
    const raw = (DIFF_CONFIG?.mode || "permission").toString().trim().toLowerCase()
    if (raw === "after" || raw === "idle" || raw === "permission") return raw
    return "permission"
  }

  const getOpenOnPermissionAsked = (): boolean => (DIFF_CONFIG as any)?.openOnPermissionAsked !== false
  const getPermissionPreviewMode = (): "patch" | "file" => (((DIFF_CONFIG as any)?.permissionPreviewMode || "file").toString().trim().toLowerCase() === "patch" ? "patch" : "file")
  const getTransactionEnabled = (): boolean => (DIFF_CONFIG as any)?.transactionEnabled !== false
  const getAutoStrategy = (): boolean => (DIFF_CONFIG as any)?.autoStrategy !== false
  const getStrategy = (): "legacy" | "transaction" | "" => {
    const raw = ((DIFF_CONFIG as any)?.strategy || "").toString().trim().toLowerCase()
    if (raw === "legacy" || raw === "transaction") return raw
    return ""
  }
  const getTransactionTimeoutMs = (): number => {
    const v = (DIFF_CONFIG as any)?.transactionTimeoutMs
    const n = typeof v === "number" && Number.isFinite(v) ? v : 120000
    return Math.max(5000, Math.floor(n))
  }
  const getTransactionMaxQueue = (): number => {
    const v = (DIFF_CONFIG as any)?.transactionMaxQueue
    const n = typeof v === "number" && Number.isFinite(v) ? v : 20
    return Math.max(1, Math.floor(n))
  }

  const shouldUseTransaction = (): boolean => {
    if (getMode() !== "permission") return false
    if (!getOpenOnPermissionAsked()) return false
    if (getPermissionPreviewMode() !== "file") return false
    if (!getTransactionEnabled()) return false
    const explicit = getStrategy()
    if (explicit) return explicit === "transaction"
    return getAutoStrategy()
  }

  const loadDiffConfig = async (): Promise<void> => {
    const configPath = getDiffConfigPath()
    if (!configPath) return
    try {
      if (!(await fileExists(configPath))) return
      const raw = await readTextFile(configPath)
      if (!raw.trim()) return
      DIFF_CONFIG = { ...DEFAULT_CONFIG, ...JSON.parse(stripJsonComments(raw)) }
    } catch {
      DIFF_CONFIG = { ...DEFAULT_CONFIG }
    }
  }

  const parseCommandLine = (value: string): string[] => {
    const out: string[] = []
    let cur = ""
    let quote: '"' | "'" | null = null
    for (let i = 0; i < value.length; i++) {
      const ch = value[i]
      if (quote) {
        if (ch === quote) {
          quote = null
          continue
        }
        cur += ch
        continue
      }
      if (ch === '"' || ch === "'") {
        quote = ch as '"' | "'"
        continue
      }
      if (ch === " " || ch === "\t" || ch === "\n") {
        if (cur) {
          out.push(cur)
          cur = ""
        }
        continue
      }
      cur += ch
    }
    if (cur) out.push(cur)
    return out
  }

  const getDiffCommandTokens = (): string[] => {
    const editorRaw = (DIFF_CONFIG?.editor || "code").toString().trim()
    const tokens = parseCommandLine(editorRaw)
    return tokens.length ? tokens : ["code"]
  }

  const getEnvPathValue = (): string => {
    const env = (globalThis as any)?.process?.env || {}
    return (env.PATH || env.Path || "").toString()
  }

  const findOnPath = async (fileName: string): Promise<string> => {
    try {
      const parts = getEnvPathValue().split(";").map((s: string) => s.trim()).filter(Boolean)
      for (const dir of parts) {
        const candidate = path.join(dir, fileName)
        if (await fileExists(candidate)) return candidate
      }
    } catch {
      // ignore
    }
    return ""
  }

  const resolveVsCodeExe = async (): Promise<string> => {
    try {
      const codeCmd = await findOnPath("code.cmd")
      if (codeCmd) {
        const binDir = path.dirname(codeCmd)
        const oneUp = path.resolve(binDir, "..", "Code.exe")
        if (await fileExists(oneUp)) return oneUp
        const twoUp = path.resolve(binDir, "..", "..", "Code.exe")
        if (await fileExists(twoUp)) return twoUp
      }
    } catch {
      // ignore
    }

    const env = (globalThis as any)?.process?.env || {}
    const candidates: string[] = []
    const localAppData = (env.LOCALAPPDATA || "").toString().trim()
    const programFiles = (env.ProgramFiles || "C:\\Program Files").toString().trim()
    const programFilesX86 = (env["ProgramFiles(x86)"] || "C:\\Program Files (x86)").toString().trim()
    const portable = (env.VSCODE_PORTABLE || "").toString().trim()
    if (portable) candidates.push(path.join(portable, "Code.exe"))
    if (localAppData) candidates.push(path.join(localAppData, "Programs", "Microsoft VS Code", "Code.exe"))
    if (programFiles) candidates.push(path.join(programFiles, "Microsoft VS Code", "Code.exe"))
    if (programFilesX86) candidates.push(path.join(programFilesX86, "Microsoft VS Code", "Code.exe"))
    for (const candidate of candidates) {
      if (await fileExists(candidate)) return candidate
    }
    return ""
  }

  const resolveEditorInvocation = async (): Promise<{ cmd: string; args: string[] }> => {
    if (RESOLVED_EDITOR) return RESOLVED_EDITOR
    const tokens = getDiffCommandTokens()
    const cmd0 = tokens[0] || "code"
    const args0 = tokens.slice(1)
    const hasSep = cmd0.includes("\\") || cmd0.includes("/")
    const looksExe = cmd0.toLowerCase().endsWith(".exe")
    if (hasSep || looksExe || path.isAbsolute(cmd0)) {
      RESOLVED_EDITOR = { cmd: cmd0, args: args0 }
      return RESOLVED_EDITOR
    }
    if (cmd0.toLowerCase() === "code") {
      const exe = await resolveVsCodeExe()
      if (exe) {
        RESOLVED_EDITOR = { cmd: exe, args: args0 }
        return RESOLVED_EDITOR
      }
    }
    RESOLVED_EDITOR = { cmd: cmd0, args: args0 }
    return RESOLVED_EDITOR
  }

  const runEditorDiff = async (oldPath: string, newPath: string): Promise<boolean> => {
    const resolved = await resolveEditorInvocation()
    const finalArgs = [...resolved.args, "--diff", oldPath, newPath]
    try {
      const child = childProcess.spawn(resolved.cmd, finalArgs, {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
        shell: false,
      })
      return await new Promise((resolve) => {
        let settled = false
        const done = (ok: boolean) => {
          if (settled) return
          settled = true
          try {
            child.unref()
          } catch {
            // ignore
          }
          resolve(ok)
        }
        child.once("error", () => done(false))
        setTimeout(() => done(true), 0)
      })
    } catch {
      return false
    }
  }

  const getFileExtension = (filePath: string): string => {
    try {
      return path.extname(filePath || "") || ""
    } catch {
      return ""
    }
  }

  const splitPermissionDiffIntoFiles = (diffText: string): Array<{ fileKey: string; text: string }> => {
    const text = (diffText || "").replace(/\r\n/g, "\n")
    if (!text.trim()) return []
    const indexRe = /^Index:\s*(.+)$/gm
    const indexMatches: Array<{ start: number; fileKey: string }> = []
    for (;;) {
      const m = indexRe.exec(text)
      if (!m) break
      const fileKey = (m[1] || "").trim()
      indexMatches.push({ start: m.index, fileKey: fileKey || "(unknown)" })
    }
    if (indexMatches.length > 0) {
      const out: Array<{ fileKey: string; text: string }> = []
      for (let i = 0; i < indexMatches.length; i++) {
        const cur = indexMatches[i]
        const next = indexMatches[i + 1]
        out.push({ fileKey: cur.fileKey, text: text.slice(cur.start, next ? next.start : text.length).trimEnd() + "\n" })
      }
      return out
    }
    const gitRe = /^diff --git\s+a\/(\S+)\s+b\/(\S+)\s*$/gm
    const gitMatches: Array<{ start: number; fileKey: string }> = []
    for (;;) {
      const m = gitRe.exec(text)
      if (!m) break
      gitMatches.push({ start: m.index, fileKey: (m[2] || m[1] || "").trim() || "(unknown)" })
    }
    if (gitMatches.length > 0) {
      const out: Array<{ fileKey: string; text: string }> = []
      for (let i = 0; i < gitMatches.length; i++) {
        const cur = gitMatches[i]
        const next = gitMatches[i + 1]
        out.push({ fileKey: cur.fileKey, text: text.slice(cur.start, next ? next.start : text.length).trimEnd() + "\n" })
      }
      return out
    }
    return [{ fileKey: "(patch)", text: text.trimEnd() + "\n" }]
  }

  const parseHunkHeader = (line: string): { oldStart: number; oldCount: number; newStart: number; newCount: number } | null => {
    const m = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line)
    if (!m) return null
    return {
      oldStart: Math.max(0, Math.floor(Number(m[1]))),
      oldCount: Math.max(0, Math.floor(m[2] ? Number(m[2]) : 1)),
      newStart: Math.max(0, Math.floor(Number(m[3]))),
      newCount: Math.max(0, Math.floor(m[4] ? Number(m[4]) : 1)),
    }
  }

  const splitTextToLines = (value: string): { lines: string[]; hadTrailingNewline: boolean } => {
    const text = (value || "").replace(/\r\n/g, "\n")
    const hadTrailingNewline = text.endsWith("\n")
    const lines = text.split("\n")
    if (hadTrailingNewline) lines.pop()
    return { lines, hadTrailingNewline }
  }

  const applyUnifiedDiffToText = (oldText: string, diffSegmentText: string): { ok: boolean; newText: string } => {
    const seg = (diffSegmentText || "").replace(/\r\n/g, "\n")
    const segLines = seg.split("\n")
    const hunks: Array<{ header: ReturnType<typeof parseHunkHeader>; startLineIndex: number; endLineIndex: number }> = []
    for (let i = 0; i < segLines.length; i++) {
      const line = segLines[i]
      if (!line.startsWith("@@")) continue
      const header = parseHunkHeader(line)
      if (!header) continue
      hunks.push({ header, startLineIndex: i, endLineIndex: segLines.length })
    }
    if (hunks.length === 0) return { ok: false, newText: oldText }
    for (let i = 0; i < hunks.length; i++) {
      hunks[i].endLineIndex = i + 1 < hunks.length ? hunks[i + 1].startLineIndex : segLines.length
    }

    const { lines: oldLines, hadTrailingNewline: oldHadNl } = splitTextToLines(oldText)
    const out: string[] = []
    let oldIdx = 0
    for (const h of hunks) {
      const header = h.header!
      const targetOldIdx = Math.max(0, header.oldStart - 1)
      while (oldIdx < targetOldIdx && oldIdx < oldLines.length) {
        out.push(oldLines[oldIdx])
        oldIdx++
      }
      for (let i = h.startLineIndex + 1; i < h.endLineIndex; i++) {
        const l = segLines[i]
        if (!l) continue
        if (l.startsWith("\\")) continue
        const prefix = l[0]
        const payload = l.slice(1)
        if (prefix === " ") {
          out.push(payload)
          oldIdx++
          continue
        }
        if (prefix === "-") {
          oldIdx++
          continue
        }
        if (prefix === "+") {
          out.push(payload)
          continue
        }
      }
    }
    while (oldIdx < oldLines.length) {
      out.push(oldLines[oldIdx])
      oldIdx++
    }
    return { ok: true, newText: out.join("\n") + (oldHadNl ? "\n" : "") }
  }

  const getStablePreviewPaths = async (realFsPath: string, displayKey: string): Promise<{ originalPath: string }> => {
    const previewDir = await getPreviewDir()
    if (!previewDir) return { originalPath: "" }
    const ext = getFileExtension(realFsPath)
    let base = sanitizeForFileName(displayKey)
    if (ext && base.toLowerCase().endsWith(ext.toLowerCase())) base = base.slice(0, Math.max(0, base.length - ext.length))
    base = base || "untitled"
    const originalName = sanitizeForFileName(`${base}(Original)`)
    return {
      originalPath: path.join(previewDir, `${originalName}${ext || ".txt"}`),
    }
  }

  const writeRealFile = async (fsPath: string, content: string): Promise<void> => {
    await ensureDir(path.dirname(fsPath))
    await fs.writeFile(fsPath, content, "utf8")
  }

  const rollbackRealFile = async (fsPath: string, originalExisted: boolean, originalText: string): Promise<void> => {
    if (!originalExisted) {
      try {
        await fs.unlink(fsPath)
      } catch {
        // ignore
      }
      return
    }
    await writeRealFile(fsPath, originalText)
  }

  const getCallIDFromPermissionAskedEvent = (ev: any): string | undefined => {
    const props = ev?.properties
    const tool = props?.tool
    const callID = tool?.callID
    return typeof callID === "string" && callID ? callID : undefined
  }

  const txnBestEffortRollback = async (txn: Txn): Promise<void> => {
    for (const f of txn.files) {
      await rollbackRealFile(f.fsPath, f.originalExisted, f.originalText)
    }
  }

  const cleanupPreviewArtifactsForRequest = async (requestID: string | undefined): Promise<void> => {
    await cleanupPreviewFilesBestEffort(fs, previewArtifactTracker.take(requestID))
  }

  const cleanupPreviewArtifactsForReplyEvent = async (replyEvent: any): Promise<void> => {
    const requestID = typeof (replyEvent as any)?.properties?.requestID === "string" ? (replyEvent as any).properties.requestID : undefined
    await cleanupPreviewArtifactsForRequest(requestID)
  }

  const txnEnqueueFromPermissionAsked = async (permissionEvent: any): Promise<{ ok: boolean; callID?: string }> => {
    const callID = getCallIDFromPermissionAskedEvent(permissionEvent)
    const props = permissionEvent?.properties
    const meta = props?.metadata || {}
    const permission = typeof props?.permission === "string" ? props.permission : ""
    if (permission !== "edit") return { ok: false, callID }
    const diffText = typeof meta?.diff === "string" ? meta.diff : ""
    if (!diffText.trim() || !callID) return { ok: false, callID }
    const queuedCount = txnQueue.length + (txnActive ? 1 : 0)
    if (queuedCount >= getTransactionMaxQueue()) return { ok: false, callID }
    const requestID = (permissionEvent as any)?.properties?.id
    const txn: Txn = {
      callID,
      requestID: typeof requestID === "string" ? requestID : undefined,
      askedAt: Date.now(),
      state: "queued",
      diffText,
      files: [],
    }
    if (txnActive) {
      txnQueue.push(txn)
      return { ok: true, callID }
    }
    txnActive = txn
    return { ok: true, callID }
  }

  const txnActivateIfNeeded = async (): Promise<void> => {
    if (!txnActive) txnActive = txnQueue.shift() || null
    if (!txnActive || txnActive.state !== "queued") return
    const txn = txnActive
    const segments = splitPermissionDiffIntoFiles(txn.diffText)
    if (segments.length === 0) {
      txn.state = "failed"
      txnActive = null
      txnManagedCallIDs.delete(txn.callID)
      await txnActivateIfNeeded()
      return
    }

    const files: TxnFile[] = []
    for (const seg of segments) {
      const rawKey = typeof seg.fileKey === "string" ? seg.fileKey : "(unknown)"
      const fsPath = resolveToFsPath(rawKey)
      let originalExisted = false
      let oldText = ""
      try {
        const st = await fs.stat(fsPath)
        originalExisted = st.isFile()
      } catch {
        originalExisted = false
      }
      try {
        oldText = await readTextFile(fsPath)
      } catch {
        oldText = ""
      }
      const applied = applyUnifiedDiffToText(oldText, seg.text)
      if (!applied.ok) {
        await txnBestEffortRollback(txn)
        txn.state = "failed"
        txnActive = null
        txnManagedCallIDs.delete(txn.callID)
        await txnActivateIfNeeded()
        return
      }
      const displayKey = (() => {
        try {
          return normalizeToSingleLine(path.basename(rawKey) || rawKey || "(unknown)")
        } catch {
          return normalizeToSingleLine(rawKey || "(unknown)")
        }
      })()
      const stable = await getStablePreviewPaths(fsPath, displayKey)
      files.push({
        fsPath,
        originalExisted,
        originalText: oldText,
        expectedText: applied.newText,
        originalPreviewPath: stable.originalPath,
      })
    }

    txn.files = files
    for (const f of txn.files) {
      if (f.originalPreviewPath) await writeTextFile(f.originalPreviewPath, f.originalText)
    }
    previewArtifactTracker.register(
      txn.requestID,
      txn.files.map((f) => f.originalPreviewPath || "")
    )
    for (const f of txn.files) {
      await writeRealFile(f.fsPath, f.expectedText)
    }
    for (const f of txn.files) {
      if (f.originalPreviewPath) await runEditorDiff(f.originalPreviewPath, f.fsPath)
    }

    txn.state = "active_applied"
    txnManagedCallIDs.add(txn.callID)
    txn.timer = setTimeout(async () => {
      if (!txnActive || txnActive.callID !== txn.callID) return
      if (txnActive.state !== "active_applied") return
      try {
        await txnBestEffortRollback(txn)
        txn.state = "timeout"
        await cleanupPreviewArtifactsForRequest(txn.requestID)
      } finally {
        txnActive = null
        txnManagedCallIDs.delete(txn.callID)
        await txnActivateIfNeeded()
      }
    }, getTransactionTimeoutMs())
  }

  const txnHandlePermissionReplied = async (replyEvent: any): Promise<void> => {
    if (!txnActive) return
    const reply = typeof (replyEvent as any)?.properties?.reply === "string" ? (replyEvent as any).properties.reply : ""
    const requestID = (replyEvent as any)?.properties?.requestID
    if (typeof requestID === "string" && txnActive.requestID && requestID !== txnActive.requestID) return
    const txn = txnActive
    if (txn.timer) {
      clearTimeout(txn.timer)
      txn.timer = undefined
    }
    if (isDenyReply(reply)) {
      await txnBestEffortRollback(txn)
      await cleanupPreviewArtifactsForRequest(txn.requestID)
      txn.state = "denied"
      txnActive = null
      txnManagedCallIDs.delete(txn.callID)
      await txnActivateIfNeeded()
      return
    }
    if (isAllowReply(reply)) {
      await cleanupPreviewArtifactsForRequest(txn.requestID)
      txn.state = "done"
      txnActive = null
      txnManagedCallIDs.delete(txn.callID)
      await txnActivateIfNeeded()
      return
    }

    await txnBestEffortRollback(txn)
    await cleanupPreviewArtifactsForRequest(txn.requestID)
    txn.state = "denied"
    txnActive = null
    txnManagedCallIDs.delete(txn.callID)
    await txnActivateIfNeeded()
  }

  const openPermissionPreview = async (permissionEvent: any): Promise<void> => {
    if (!getOpenOnPermissionAsked()) return
    if (getPermissionPreviewMode() !== "patch") return
    const props = permissionEvent?.properties
    const meta = props?.metadata || {}
    const permission = typeof props?.permission === "string" ? props.permission : ""
    if (permission !== "edit") return
    const diffText = typeof meta?.diff === "string" ? meta.diff : ""
    const segments = splitPermissionDiffIntoFiles(diffText)
    if (segments.length === 0) return
    const previewDir = await getPreviewDir()
    if (!previewDir) return
    const requestID = typeof (permissionEvent as any)?.properties?.id === "string" ? (permissionEvent as any).properties.id : undefined
    const previewPaths: string[] = []
    for (const seg of segments) {
      const key = sanitizeForFileName(seg.fileKey || "patch")
      const left = path.join(previewDir, `${key}(Original).txt`)
      const right = path.join(previewDir, `${key}(CodeChanges).txt`)
      await writeTextFile(left, "")
      await writeTextFile(right, seg.text)
       previewPaths.push(left, right)
      await runEditorDiff(left, right)
    }
    previewArtifactTracker.register(requestID, previewPaths)
  }

  const handlePermissionAskedWithStrategy = async (permissionEvent: any): Promise<void> => {
    if (shouldUseTransaction()) {
      const enq = await txnEnqueueFromPermissionAsked(permissionEvent)
      if (enq.ok) {
        await txnActivateIfNeeded()
        return
      }
    }
    await openPermissionPreview(permissionEvent)
  }

  await loadDiffConfig()

  return {
    event: async ({ event }: any) => {
      const ev: any = event as any
      if (ev?.type === "permission.asked") {
        await handlePermissionAskedWithStrategy(ev)
        return
      }
      if (ev?.type === "permission.replied") {
        await txnHandlePermissionReplied(ev)
        await cleanupPreviewArtifactsForReplyEvent(ev)
      }
    },
    "tool.execute.after": async (input: any) => {
      const afterCallID = typeof input?.callID === "string" && input.callID ? input.callID : ""
      if (afterCallID && txnManagedCallIDs.has(afterCallID)) {
        txnManagedCallIDs.delete(afterCallID)
        return
      }
    },
  }
}

export default DiffPreviewPlugin
