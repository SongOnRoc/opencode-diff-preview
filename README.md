# opencode-diff-preview

OpenCode plugin for Windows permission-time diff preview.

## What it does

- On `permission.asked` for `edit`, it applies the expected result to the real file.
- It opens a VS Code diff showing `Original` on the left and the real file on the right.
- On `deny` or timeout, it rolls the real file back.
- On `allow`, it ends the transaction and does not try to preserve right-pane manual edits.

## What it does not do

- Preserve edits made in the diff right pane
- Close diff tabs after reply
- Control IDE-internal editor lifecycle

## Requirements

- Windows
- VS Code installed
- `code` CLI available, or `Code.exe` installed in a standard location

## Configure in OpenCode

After publishing this package, add it to your OpenCode config with the official `plugin` field:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-diff-preview"]
}
```

## Local development

Build:

```bash
pnpm install
pnpm build
```

Pack locally:

```bash
pnpm pack
```

The generated tarball can be used for local installation workflows.
