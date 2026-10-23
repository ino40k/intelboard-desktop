export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
export async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  let body: unknown;
  if (options.body instanceof FormData) {
    const file = options.body.get('file');
    if (!(file instanceof File)) throw new Error('Choose a file');
    body = { filename: file.name, mime: file.type, bytes: new Uint8Array(await file.arrayBuffer()) };
  } else if (typeof options.body === 'string') body = JSON.parse(options.body);
  const result = await window.intelboard.request(url, options.method || 'GET', body);
  if (!result.ok) throw new ApiError(result.error || 'Desktop operation failed', result.status || 400);
  return result.data as T;
}
export async function transfer(operation: string, boardId?: string) {
  return window.intelboard.transfer(operation, boardId);
}
// Attachment URLs are IDs, never paths. The main process owns the native save dialog.
document.addEventListener('click', event => {
  const link = (event.target as Element)?.closest?.('a[href]') as HTMLAnchorElement | null;
  if (!link) return;
  const url = new URL(link.href);
  const asset = url.pathname.match(/^\/api\/assets\/([0-9a-f-]{36})$/);
  if (url.protocol === 'intelboard:' && asset) {
    event.preventDefault();
    void transfer('save-asset', asset[1]).catch(error => window.alert(error.message));
  }
});
