// dsh-plugin-infinite-blackboard — expose Infinite Blackboard as native DSH tools.
//
// The plugin is intentionally thin: it registers model-facing tools that call
// the existing `blackboard` CLI in the session's working directory, plus one
// short system-prompt section. Board semantics (event log, locking, redaction,
// replay) stay in the CLI. Nothing from the blackboard distribution is vendored
// here, so this package can be installed on its own and still never disagree
// with the CLI about the board format; `lib/blackboard-root.js` holds the search
// order for that distribution.

import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolveBlackboardRoot } from './lib/blackboard-root.js';
import { loadVocabulary } from './lib/board-lib.js';
import { resolveCli } from './lib/cli.js';
import { resolveCwd } from './lib/cwd.js';
import { createSnapshotRoute, createViewerRoute } from './lib/route.js';
import { createViewerManager } from './lib/viewer.js';
import { createBlackboardTools } from './lib/tools.js';
import { PROMPT_SECTION_NAME, PROMPT_SECTION_ORDER, PROMPT_TEXT } from './lib/prompt.js';

export const name = 'infinite-blackboard';

/** Services this plugin contributes to; both are part of dsh-base. */
export const inject = ['tools', 'systemPrompt'];

export async function apply(ctx, config = {}) {
  // Only an explicit identity is injected: an inherited BLACKBOARD_AGENT (or the
  // CLI's own agent:primary default) must survive an unconfigured plugin.
  const agentId = typeof config.agentId === 'string' && config.agentId.trim()
    ? config.agentId.trim()
    : undefined;
  const timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : undefined;
  const idleMs = Number.isFinite(config.viewerIdleMs) && config.viewerIdleMs >= 0 ? config.viewerIdleMs : undefined;

  // Resolve once, but never fatally: a missing or bad distribution must fail one
  // tool call with a clear message, not abort the whole profile at boot (and HMR
  // can repair it without a restart).
  let cli = null;
  let cliError = null;
  let distribution = null;
  try {
    cli = resolveCli(config.cliPath);
    distribution = resolveBlackboardRoot(config.cliPath)?.root || null;
  } catch (error) {
    cliError = error;
    ctx.logger?.warn?.(`blackboard: ${error.message}`);
  }
  const getCli = () => {
    if (cliError) throw cliError;
    return cli;
  };

  // Live session cwd when the working-directory service is mounted; otherwise
  // the resolver falls back to the session header and creation metadata.
  let liveCwd = null;
  ctx.inject(['workingDirectory'], (workingCtx) => {
    liveCwd = (session) => workingCtx.workingDirectory.get(session);
  });

  // Web half: the in-UI "黑板" tab reads its data from this route. Registered
  // only where a web server exists, so the headless profile keeps working.
  ctx.inject(['webServer', 'sessions'], (webCtx) => {
    const resolveBoardCwd = (sessionId) => {
      if (!sessionId) return process.cwd();
      const session = webCtx.sessions.get(sessionId);
      if (!session) return null;
      if (liveCwd) {
        try {
          const live = liveCwd(session);
          if (typeof live === 'string' && live) return live;
        } catch {
          // Fall through to the creation directory.
        }
      }
      return session.header?.cwd || null;
    };
    const viewer = createViewerManager({ getCli, idleMs });
    ctx.effect(() => () => viewer.stopAll(), 'blackboard: viewer processes');
    ctx.effect(() => webCtx.webServer.register(createSnapshotRoute({
      resolveCwd: resolveBoardCwd,
      distribution,
    })), 'blackboard: snapshot route');
    ctx.effect(() => webCtx.webServer.register(createViewerRoute({
      resolveCwd: resolveBoardCwd,
      distribution,
      ensureViewer: (root) => viewer.ensure(root),
    })), 'blackboard: viewer route');
  });

  if (config.prompt !== false) {
    ctx.systemPrompt.section({
      name: PROMPT_SECTION_NAME,
      order: PROMPT_SECTION_ORDER,
      text: PROMPT_TEXT,
      interpolate: false,
    });
  }

  // Everything that does not depend on the distribution is registered first, so
  // a slow or absent checkout only delays the tool list — never the Web routes.
  const vocabulary = await loadVocabulary(distribution);

  const tools = createBlackboardTools(defineTool, {
    getCli,
    resolveCwd: (exec) => resolveCwd(exec, liveCwd),
    agentId,
    timeoutMs,
    vocabulary,
  });
  for (const definition of tools) ctx.tools.register(definition);
}
