# opencode-diff-preview

OpenCode plugin for Windows permission-time diff preview.

When OpenCode asks for permission to run an `edit`, this plugin can open a VS Code diff so you can inspect the change before replying.

## What it does

- Opens a diff preview for `permission.asked` on `edit`
- In the default `file` preview mode, writes the expected result into the real file first
- Rolls the file back on `reject` or timeout
- Keeps the file as-is on `once` or `always`
- Supports a simpler `patch` preview mode that shows raw diff content instead of touching the target file
- Removes preview temp files after the permission reply is received

## Requirements

- Windows
- OpenCode with plugin support
- VS Code installed
- `code` CLI available, or `Code.exe` installed in a standard location

## Use in OpenCode

Once the package is published to npm, OpenCode can install and load it automatically through the `plugin` field in your config.

Edit either:

- `~/.config/opencode/opencode.json`
- `opencode.json`

Then add:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-diff-preview"]
}
```

Restart OpenCode after updating the config.

## Recommended config

This plugin reads runtime settings from:

- `~/.config/opencode/diff.jsonc`

If the file does not exist, built-in defaults are used.

Recommended minimal config:

```jsonc
{
  "editor": "code",
  "mode": "permission",
  "openOnPermissionAsked": true,
  "permissionPreviewMode": "file",
  "permissionOpenAfterTool": false
}
```

## Preview modes

### `file`

This is the default mode.

When OpenCode asks permission for an `edit`, the plugin:

1. Applies the expected content to the real file
2. Opens a diff with `Original` on the left and the real file on the right
3. Rolls the file back on `reject` or timeout
4. Leaves the file in place on `once` or `always`
5. Removes preview temp files after the permission reply is received

OpenCode permission prompts currently reply with `once`, `always`, or `reject`. This plugin treats `reject` as the deny path.

The diff is for preview only. Manual edits made in the diff view are not part of the supported workflow and may be overwritten or rolled back.

### `patch`

In `patch` mode, the plugin does not apply the patch to the real file. It opens a diff against generated preview files that contain the patch text, and removes those temp files after the permission reply is received.

## Common config fields

- `editor`: diff editor command, default `code`
- `mode`: current default is `permission`
- `openOnPermissionAsked`: whether to open preview on permission request
- `permissionPreviewMode`: `file` or `patch`
- `tempDir`: where preview temp files are stored, `config` or `workspace`
- `transactionTimeoutMs`: rollback timeout in milliseconds, default `120000`

## Limitations

The current version does not:

- preserve manual edits made in the diff right pane
- support editing inside the preview diff as part of the workflow
- close diff tabs after reply
- provide deep IDE integration beyond launching a diff command

Also note:

- only Windows is supported
- preview handling only applies to `edit` permissions

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
