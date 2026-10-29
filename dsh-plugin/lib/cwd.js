// Resolve the working directory a board command must run in.
//
// The board belongs to the Session workspace, not to the harness process. DSH
// tracks the live value on its working-directory service (the value changes
// when the session runs `cd`), while the Session header keeps the creation
// directory. Both are consulted; the process directory is the last resort.

/**
 * @param {{ agent?: { session?: any } }} exec - tool execution context.
 * @param {(session: any) => string | undefined} [liveGet] - reads the live session cwd
 *   (`ctx.workingDirectory.get(session)`); omitted when that service is not mounted.
 */
export function resolveCwd(exec, liveGet) {
  const session = exec?.agent?.session;
  if (!session) return process.cwd();
  if (typeof liveGet === 'function') {
    try {
      const live = liveGet(session);
      if (typeof live === 'string' && live) return live;
    } catch {
      // A missing or unowned session projection must not fail the tool call.
    }
  }
  const headerCwd = session.header?.cwd;
  if (typeof headerCwd === 'string' && headerCwd) return headerCwd;
  const metaCwd = session.meta?.cwd;
  if (typeof metaCwd === 'string' && metaCwd) return metaCwd;
  return process.cwd();
}
