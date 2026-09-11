# Native task continuity (El Monstruo fork)

AionUI/AionCore Teams, Tasks, Mailbox and provider engines remain the executor.
This optional Desktop boundary recovers institutional context before a human send.
It does not create agents, dispatch remote jobs, replace native storage, or claim
that a new native agent is a historical Council member.

## Configuration

Configure the existing authenticated Kernel service in the main process using
`~/.config/monstruo/orchestration-continuity.env` (owner-only mode `0600`):

```dotenv
AIONUI_MONSTRUO_CONTINUITY_URL=https://your-existing-kernel.example
AIONUI_MONSTRUO_API_KEY=your-existing-authorized-key
```

Environment overrides use the same names. Never paste the key into a conversation.
The URL must be HTTPS (HTTP allowed only on loopback). Redirects are rejected.
Restart AionUI after configuration. No new local service is installed. This does
not change the separately governed Velorn MCP gateway at `127.0.0.1:4452/mcp`.

The Kernel must implement `monstruo-aionui-continuity/v1`, including durable
`tasks:bind`, `:recover`, immutable `:prepare`, `:ack`, and task `events` routes.
Missing configuration leaves ordinary **unbound** native chats usable. A **bound**
chat fails before dispatch if recovery, identity, or digest verification fails.

## Use

1. Open an existing native conversation or Team lead.
2. Expand **Task continuity**, enter its real objective and enable continuity.
3. Send normally. The existing native send receives the recovered causal pack.
4. To replace a directive, use **Replace current direction**. The prior directive
   remains explicitly superseded, not silently deleted.
5. In a fresh native conversation, select a bound conversation/Team by name in
   the continuity source picker. Resume it without copying task IDs or context.
6. Reopen after restart: persisted native responses are collected without sending
   work again. **Recover results** also performs this read/deposit operation.

A real assistant `CONTINUITY_ACK_JSON` is submitted only if it identifies the
immutable preparation, slot and envelope, with the refs actually acknowledged.
Missing or rejected ACKs do not become verified. Hash/ACK verification is not
proof of understanding; use a behavioral superseded/current-direction exercise.
Results are stored as native-response evidence, conservatively `partial`, not
promoted to task success merely because prose says “done”. Artifacts link to the
native message containing file references; the files remain in native workspaces.
AionCore backend turn IDs are metadata, not fabricated provider session/turn IDs.

## Explicit limits and rollback

- The boundary covers Desktop human conversation, Team, targeted-member and
  interrupt sends. Autonomous intra-Team delegations and WebUI/programmatic sends
  inside AionCore are **not yet covered** by pre-turn institutional recovery.
- Post-acceptance reporting failures never retry native work. Recover deposited
  native responses on next open; do not blindly resend the user task.
- Contexts above the injection bound or histories above 2,000 messages fail
  explicitly. The ordinary source index above 200 conversations also fails
  explicitly instead of silently truncating.
- Native provider authentication/billing is independent of Kernel availability.
  A blocked teammate stays blocked; no substitute engine or fabricated result.
- Roll back the app bundle without deleting native AionUI storage. Bound tasks
  retain their pointer and Kernel history. Removing config is **not** a fallback
  around governance: bound sends then fail closed.

## Checks

```sh
bunx vitest run tests/unit/process/services/continuity
bunx tsc --noEmit
bun run i18n:types && node scripts/check-i18n.js
bun run test
```

Unit fixtures are not live evidence. Native app execution, authority receipts,
cold-restart recovery, and behavioral evidence must be reported separately.
