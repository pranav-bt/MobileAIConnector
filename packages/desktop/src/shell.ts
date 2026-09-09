import type { ClientCommand } from '@agent-hq/shared';

// Bridge to the Tauri shell when running inside it (no-op in a browser).
// The shell emits 'kill-connection' from the tray menu and the global
// Ctrl+Shift+K hotkey; the webview owns the hub socket, so it sends the
// actual command.
export function initShellBridge(send: (command: ClientCommand) => void): void {
  if (!('__TAURI_INTERNALS__' in window)) return;
  void import('@tauri-apps/api/event')
    .then(({ listen }) => listen('kill-connection', () => send({ type: 'connection.kill' })))
    .catch(() => {
      /* shell bridge unavailable — browser behavior remains intact */
    });
}
