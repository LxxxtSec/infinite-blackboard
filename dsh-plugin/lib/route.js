// Host route backing the in-UI blackboard view:
//   GET <base>/api/blackboard/snapshot?session=<sessionId>
//
// The path is registered root-absolute on the host, but the client requests it
// document-relative so a sub-path deployment keeps working.

import { boardRoot, buildBoardSnapshot } from './snapshot.js';
import { loadBoardLib } from './board-lib.js';

export const SNAPSHOT_PATH = '/api/infinite-board/snapshot';

/**
 * Pure request projection: no HTTP objects, so it is directly testable.
 *
 * @param {{ searchParams: URLSearchParams, resolveCwd: (sessionId: string) => string | null,
 *           distribution?: string }} input
 */
export async function snapshotPayload({ searchParams, resolveCwd, distribution }) {
  const sessionId = searchParams?.get?.('session') || '';
  let cwd = null;
  try {
    cwd = resolveCwd(sessionId);
  } catch (error) {
    return { status: 200, body: { ok: false, reason: 'session-error', message: String(error?.message || error) } };
  }
  if (!cwd) {
    return {
      status: 200,
      body: { ok: false, reason: 'no-session', message: '会话不存在或没有工作目录；请先打开一个会话。' },
    };
  }
  return { status: 200, body: await buildBoardSnapshot(cwd, distribution) };
}

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * @param {{ resolveCwd: (sessionId: string) => string | null, distribution?: string,
 *           path?: string }} options
 */
export function createSnapshotRoute({ resolveCwd, distribution, path = SNAPSHOT_PATH }) {
  return {
    kind: 'exact',
    path,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const { status, body } = await snapshotPayload({
          searchParams: url.searchParams,
          resolveCwd,
          distribution,
        });
        sendJson(res, status, body);
      } catch (error) {
        sendJson(res, 500, { ok: false, reason: 'internal', message: String(error?.message || error) });
      }
    },
  };
}

export const VIEWER_PATH = '/api/infinite-board/viewer';

/**
 * Ensure the real blackboard viewer (public/) is running for the calling
 * session's board and return its loopback URL. The canvas tab embeds that page.
 *
 * @param {{ resolveCwd: (sessionId: string) => string | null, distribution?: string,
 *           ensureViewer: (boardRoot: string) => Promise<{ url: string, port: number }> }} options
 */
export function createViewerRoute({ resolveCwd, ensureViewer, distribution, path = VIEWER_PATH }) {
  return {
    kind: 'exact',
    path,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const sessionId = url.searchParams.get('session') || '';
        let cwd = null;
        try {
          cwd = resolveCwd(sessionId);
        } catch (error) {
          return sendJson(res, 200, { ok: false, reason: 'session-error', message: String(error?.message || error) });
        }
        if (!cwd) return sendJson(res, 200, { ok: false, reason: 'no-session', message: '会话不存在或没有工作目录。' });
        let lib;
        try {
          lib = await loadBoardLib(distribution);
        } catch (error) {
          return sendJson(res, 200, { ok: false, reason: 'no-distribution', message: String(error?.message || error) });
        }
        const root = boardRoot(cwd, lib);
        if (!lib.store.isInitialized(root)) return sendJson(res, 200, { ok: false, reason: 'no-board', cwd: root });
        const entry = await ensureViewer(root);
        return sendJson(res, 200, { ok: true, url: entry.url, port: entry.port, cwd: root });
      } catch (error) {
        return sendJson(res, 200, { ok: false, reason: 'viewer-error', message: String(error?.message || error) });
      }
    },
  };
}
