import type { ClientCommand } from '@agent-hq/shared';

// Bridge to the Tauri shell when running inside it (no-op in a browser).
// The shell emits 'kill-connection' from the tray menu and the global
// Ctrl+Shift+K hotkey; the webview owns the hub socket, so it sends the
// actual command.
// A task console in its own window: a new Tauri window inside the shell, a
// browser window otherwise. Resolves false if the window couldn't open (the
// console then stays in the drawer).
export async function openConsoleWindow(taskId: string, title: string): Promise<boolean> {
  const url = `${window.location.pathname}?console=${encodeURIComponent(taskId)}`;
  if ('__TAURI_INTERNALS__' in window) {
    try {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      const label = `console-${taskId.replace(/[^A-Za-z0-9_-]/g, '-')}`;
      const existing = await WebviewWindow.getByLabel(label);
      if (existing) {
        await existing.setFocus();
        return true;
      }
      const win = new WebviewWindow(label, { url, title: `Agent HQ · ${title}`, width: 780, height: 920, minWidth: 420, minHeight: 500 });
      return await new Promise<boolean>((resolve) => {
        void win.once('tauri://created', () => resolve(true));
        void win.once('tauri://error', () => resolve(false));
        setTimeout(() => resolve(false), 4000);
      });
    } catch {
      return false;
    }
  }
  return window.open(url, `console-${taskId}`, 'width=780,height=920') !== null;
}

export function initShellBridge(send: (command: ClientCommand) => void): void {
  if (!('__TAURI_INTERNALS__' in window)) return;
  void import('@tauri-apps/api/event')
    .then(({ listen }) => listen('kill-connection', () => send({ type: 'connection.kill' })))
    .catch(() => {
      /* shell bridge unavailable — browser behavior remains intact */
    });
}
