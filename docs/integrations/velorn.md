# Velorn workflow studio

The complete AionUI product remains available. In regular Codex/ACP conversations,
the optional studio reads the native Velorn MCP catalog and renders published
calibration profiles. Catalogued workflows without profiles are not represented as
calibrated or runnable. The search suggestions are explainable keyword matches,
not model-generated quality rankings.

## Local services

- Governed read/preview MCP: http://127.0.0.1:4452/mcp
- Existing Phase 4 caller facade: http://127.0.0.1:4453
- Native Velorn upstream: http://127.0.0.1:19790/mcp
- The direct native server is disabled in the AionUI MCP configuration; enable it
  explicitly only when a direct fallback is intended. The studio never falls back
  automatically.
- Install the existing macOS launch agents from the El Monstruo repository using
  tools/install_velorn_gateway_macos.sh and tools/install_velorn_grant_service_macos.sh.
  This feature requires the gateway normalization/context-fence contract.
- Main-process credentials come from ~/.config/monstruo/velorn-gateway.env and
  ~/.config/monstruo/velorn-grant-service.env. They are never sent to the renderer.
  An explicitly empty gateway token is supported only for the installed loopback
  setup; the authority caller token must be nonempty.

## Operation

Choose a live workflow/profile, select the target clip for a local framing edit,
adjust values or use an exact instruction such as "rotation 2; opacity 95".
The same resolved values create the same technical patch. Unrecognized intent
is rejected rather than interpreted as the first number in a sentence.

Preview binds the profile/version, exact controls, current project and timeline.
An explicit authorization then requests the existing sovereign grant. Checkpoint,
effect and reversal receipts are persisted progressively as local projections of
the sovereign ledger. They do not authorize anything by themselves. Stale projects
and later timeline edits block execution/undo. The gateway checks the signed
project revision immediately before forwarding; full atomic CAS still depends on
native specialist support.

Native generative profiles are preview-only in this cut: their mappings come from
Velorn, and this integration has no authorization to spend on media generation.
Local framing/opacity and the reversible marker recipe do not use a model or GPU.
Locks on local technical controls omit those fields from the native effect.

## Recovery

The Electron userData/velorn-governance.json file and its .runs directory preserve
receipt projections across app restarts. A process crash during an effect remains
EXECUTING/PARTIAL; it is never auto-replayed or falsely marked successful.
Resolve an unknown effect using the sovereign receipt/checkpoint before continuing.

## Development and packaging

Run just push (lint, format, types, i18n and all tests). Build with bun run package,
then electron-builder using packages/desktop/electron-builder.yml.
On macOS filesystems attaching Finder metadata, copy the bundle into a clean
temporary path with ditto --norsrc --noextattr before ad-hoc signing and verification.
Preserve the installed application as a rollback before replacing it.
Windows/Linux runtime operation is not verified by the macOS acceptance.
