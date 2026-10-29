// Browser half: one tab in the conversation view ring (next to Chat / 轨迹)
// that renders the blackboard of the current session's workspace.
//
// Hand-written module-loader bundle: the host serves this file verbatim and the
// page executes the factory. Only the baseline `react` external is required;
// all board data arrives over the host route (see lib/route.js).

window.__ModuleLoader__.load({
  id: 'dsh-plugin-infinite-blackboard',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;
    const { useEffect, useMemo, useState } = React;

    const TYPE_LABEL = {
      start: '起点', goal: '目标', intent: '意图', observation: '观察', fact: '事实',
      hypothesis: '猜测', question: '问题', action: '行动', result: '结果',
      finding: '发现', vuln: '漏洞', hint: '提示', summary: '摘要', note: '记录', compact: '压缩',
    };
    const EDGE_LABEL = {
      'related-to': '相关', 'derived-from': '派生自', supports: '支持', contradicts: '反驳',
      'depends-on': '依赖', proves: '证明', 'caused-by': '由…导致', refines: '细化',
      duplicates: '重复', supersedes: '取代', resolves: '解决',
    };
    const OPEN_STATES = ['open', 'active', 'blocked'];
    const REFRESH_MS = 2000;

    const TYPE_TONE = {
      goal: '#8aa39b', start: '#8aa39b', summary: '#8aa39b',
      hypothesis: '#d9b26f', question: '#d9b26f', intent: '#7f9ec4',
      observation: '#7f9ec4', fact: '#7f9ec4', action: '#7f9ec4', result: '#7f9ec4',
      finding: '#c98a76', vuln: '#d9705f', hint: '#a79bd0', note: '#8f8f8f',
    };

    const S = {
      root: {
        display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0,
        padding: '12px 14px', fontSize: 13, lineHeight: 1.5, color: 'var(--dsh-text, inherit)',
        boxSizing: 'border-box',
      },
      header: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' },
      title: { fontWeight: 600, fontSize: 14 },
      meta: { opacity: 0.65, fontSize: 12 },
      spacer: { flex: 1 },
      control: {
        font: 'inherit', fontSize: 12, padding: '4px 10px', borderRadius: 6,
        border: '1px solid rgba(127,127,127,0.35)', background: 'transparent', color: 'inherit', cursor: 'pointer',
      },
      search: {
        font: 'inherit', fontSize: 12, padding: '5px 9px', borderRadius: 6, width: '100%',
        border: '1px solid rgba(127,127,127,0.35)', background: 'transparent', color: 'inherit',
        boxSizing: 'border-box',
      },
      list: { flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6, paddingRight: 4 },
      item: {
        border: '1px solid rgba(127,127,127,0.25)', borderRadius: 8, padding: '7px 9px',
        cursor: 'pointer', background: 'rgba(127,127,127,0.04)',
      },
      itemSelected: { borderColor: 'rgba(127,127,127,0.55)', background: 'rgba(127,127,127,0.10)' },
      itemCurrent: { boxShadow: 'inset 3px 0 0 var(--dsh-accent, #6f9f8f)' },
      row: { display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' },
      id: { opacity: 0.55, fontSize: 11, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
      chip: { fontSize: 11, padding: '1px 6px', borderRadius: 999, border: '1px solid rgba(127,127,127,0.35)' },
      nodeTitle: { fontWeight: 500 },
      snippet: { opacity: 0.7, fontSize: 12, marginTop: 3, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      detail: { marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, opacity: 0.9 },
      rel: { marginTop: 6, display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, opacity: 0.85 },
      empty: { flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', gap: 8, opacity: 0.7, textAlign: 'center', padding: 24 },
      error: { color: '#d9705f', fontSize: 12 },
      toggleGroup: { display: 'inline-flex', gap: 4 },
      controlActive: { background: 'rgba(127,127,127,0.18)', borderColor: 'rgba(127,127,127,0.6)' },
      frame: { flex: 1, minHeight: 0, width: '100%', border: '1px solid rgba(127,127,127,0.35)', borderRadius: 8, background: 'transparent' },
      frameFull: { border: 'none', borderRadius: 0 },
      rootFull: { padding: '12px 14px' },
      footer: { fontSize: 11, opacity: 0.55, display: 'flex', gap: 10, flexWrap: 'wrap' },
    };

    // Resolve a host route URL. Web shells answer an absolute http(s) URL; the
    // Desktop shell loads the page from file://, where resolving against the
    // document base yields a file: URL that fetch rejects — there the request
    // must stay document-relative so the host bridge carries it.
    /**
     * The shell's actual painted surface. Walks up from the tab (many shells
     * theme a nested container), then falls back to body/html — so fullscreen
     * never paints a white page into a dark shell.
     */
    function readSurface(start) {
      if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return null;
      const opaque = (value) => Boolean(value) && value !== 'transparent'
        && !/^rgba?\(0,\s*0,\s*0,\s*0\)$/.test(value);
      const result = { background: null, color: null };
      const visit = (node) => {
        if (!node) return;
        const style = getComputedStyle(node);
        if (!result.background && opaque(style.backgroundColor)) result.background = style.backgroundColor;
        if (!result.color && opaque(style.color)) result.color = style.color;
      };
      for (let node = start || document.body; node; node = node.parentElement) {
        visit(node);
        if (result.background && result.color) break;
      }
      visit(document.body);
      visit(document.documentElement);
      return result;
    }

    function hostUrl(path, sessionId) {
      const search = sessionId ? `?session=${encodeURIComponent(sessionId)}` : '';
      let resolved = null;
      try {
        const url = new URL(path, document.baseURI);
        if (url.protocol === 'http:' || url.protocol === 'https:') resolved = url.toString();
      } catch {
        // Not a resolvable web base: keep the path relative.
      }
      return `${resolved || path}${search}`;
    }

    const viewerApiUrl = (sessionId) => hostUrl('api/infinite-board/viewer', sessionId);
    const apiUrl = (sessionId) => hostUrl('api/infinite-board/snapshot', sessionId);

    function hostError(response) {
      if (response.status === 401 || response.status === 404) {
        return `宿主路由未加载（HTTP ${response.status}）—— 更新过插件后需要重启 dsh web，再刷新页面`;
      }
      return `宿主路由返回 HTTP ${response.status}`;
    }

    /** Read one JSON host response, turning any non-JSON answer into a clear error. */
    async function readJson(response) {
      const text = await response.text();
      let body = null;
      try { body = JSON.parse(text); } catch { body = null; }
      if (!response.ok || body === null) throw new Error(hostError(response));
      return body;
    }

    function chip(text, tone) {
      return h('span', { style: { ...S.chip, color: tone || 'inherit', borderColor: tone ? `${tone}88` : undefined } }, text);
    }

    function formatTime(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function useSnapshot(sessionId, nonce) {
      const [state, setState] = useState({ loading: true, data: null, error: null });
      useEffect(() => {
        let alive = true;
        const load = async () => {
          try {
            const body = await readJson(await fetch(apiUrl(sessionId), { cache: 'no-store' }));
            if (alive) setState({ loading: false, data: body, error: null });
          } catch (error) {
            if (alive) setState((previous) => ({ loading: false, data: previous.data, error: String(error?.message || error) }));
          }
        };
        load();
        const timer = setInterval(load, REFRESH_MS);
        return () => { alive = false; clearInterval(timer); };
      }, [sessionId, nonce]);
      return state;
    }

    function BlackboardView(props) {
      const sessionId = props?.sessionId;
      const rootRef = React.useRef ? React.useRef(null) : { current: null };
      const [fullscreen, setFullscreen] = useState(false);
      const [fullscreenError, setFullscreenError] = useState(null);
      const [surface, setSurface] = useState(null);
      const [mode, setMode] = useState('canvas');
      const [nonce, setNonce] = useState(0);
      const [viewerNonce, setViewerNonce] = useState(0);
      const [frameKey, setFrameKey] = useState(0);
      const [viewer, setViewer] = useState({ loading: true, url: null, error: null });
      const [query, setQuery] = useState('');
      const [selected, setSelected] = useState(null);
      const { data, error, loading } = useSnapshot(sessionId, nonce);

      // Fullscreen the whole tab (our own header stays reachable; DSH chrome goes away).
      useEffect(() => {
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
        const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
        document.addEventListener('fullscreenchange', onChange);
        onChange();
        return () => document.removeEventListener('fullscreenchange', onChange);
      }, []);

      const toggleFullscreen = () => {
        if (typeof document === 'undefined') return;
        setFullscreenError(null);
        try {
          if (document.fullscreenElement) {
            const left = document.exitFullscreen?.();
            left?.catch?.((cause) => setFullscreenError(String(cause?.message || cause)));
            return;
          }
          const element = rootRef.current;
          if (!element || typeof element.requestFullscreen !== 'function') {
            setFullscreenError('当前外壳不支持全屏（可用画布内的缩放代替）');
            return;
          }
          setSurface(readSurface(rootRef.current));
          const entered = element.requestFullscreen();
          entered?.catch?.((cause) => setFullscreenError(String(cause?.message || cause)));
        } catch (cause) {
          setFullscreenError(String(cause?.message || cause));
        }
      };

      // The canvas is the real viewer served by `blackboard serve`; ask the host
      // to ensure one process for this board root, then embed its page.
      useEffect(() => {
        if (mode !== 'canvas') return;
        let alive = true;
        let beat = null;
        const load = () => fetch(viewerApiUrl(sessionId), { cache: 'no-store' })
          .then(readJson)
          .then((body) => {
            if (!alive) return;
            setViewer((previous) => (body && body.ok
              ? { loading: false, url: body.url, error: null }
              : { loading: false, url: previous.url, error: (body && (body.message || body.reason)) || '画布不可用' }));
          })
          .catch((cause) => {
            if (!alive) return;
            setViewer((previous) => ({ loading: false, url: previous.url, error: String(cause?.message || cause) }));
          });
        setViewer((previous) => ({ ...previous, loading: true, error: null }));
        // Heartbeat: each request also marks the viewer as in use, so the host's
        // idle reaper only collects it after the canvas has been left alone.
        load().then(() => {
          if (alive) beat = setInterval(load, 60000);
        });
        return () => { alive = false; if (beat) clearInterval(beat); };
      }, [mode, sessionId, viewerNonce]);

      const nodes = data?.nodes || [];
      const edges = data?.edges || [];
      const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
      const relations = useMemo(() => {
        const map = new Map();
        for (const edge of edges) {
          if (!map.has(edge.from)) map.set(edge.from, []);
          if (!map.has(edge.to)) map.set(edge.to, []);
          map.get(edge.from).push({ dir: 'out', edge });
          map.get(edge.to).push({ dir: 'in', edge });
        }
        return map;
      }, [edges]);

      const needle = query.trim().toLowerCase();
      const visible = needle
        ? nodes.filter((node) => [node.id, node.type, node.title, node.detail, (node.tags || []).join(' ')]
            .join(' ').toLowerCase().includes(needle))
        : nodes;

      const header = h('div', { style: S.header },
        h('span', { style: S.title }, data?.ok ? (data.title || '黑板') : '黑板'),
        data?.ok ? h('span', { style: S.meta },
          `${data.stats.nodes} 节点 · ${data.stats.edges} 关系 · ${data.stats.frontier} 开放`
          + (data.cursorId ? ` · 当前 ${data.cursorId}` : '')) : null,
        h('span', { style: S.spacer }),
        data?.ok && data.cwd ? h('span', { style: S.meta, title: data.cwd }, data.cwd.split('/').slice(-2).join('/')) : null,
        h('span', { style: S.toggleGroup },
          h('button', {
            style: { ...S.control, ...(mode === 'canvas' ? S.controlActive : {}) },
            onClick: () => setMode('canvas'),
          }, '画布'),
          h('button', {
            style: { ...S.control, ...(mode === 'list' ? S.controlActive : {}) },
            onClick: () => setMode('list'),
          }, '列表'),
        ),
        h('button', {
          style: S.control,
          title: fullscreen ? '退出全屏（Esc 也可以）' : '放大到全屏',
          onClick: toggleFullscreen,
        }, fullscreen ? '退出全屏' : '全屏'),
        h('button', {
          style: S.control,
          title: '立即刷新',
          onClick: () => {
            if (mode === 'canvas') {
              setFrameKey((key) => key + 1);
              setViewerNonce((value) => value + 1);
            } else {
              setNonce((value) => value + 1);
            }
          },
        }, loading && mode === 'list' ? '加载中…' : '刷新'),
      );

      const rootStyle = fullscreen
        ? {
            ...S.root,
            ...S.rootFull,
            background: (surface && surface.background) || 'var(--dsw-alias-bg-base, Canvas)',
            color: (surface && surface.color) || 'var(--dsw-alias-label-primary, CanvasText)',
          }
        : S.root;
      const frameStyle = fullscreen ? { ...S.frame, ...S.frameFull } : S.frame;

      if (mode === 'canvas') {
        return h('div', { ref: rootRef, style: rootStyle }, header,
          fullscreenError ? h('div', { style: S.error }, fullscreenError) : null,
          viewer.url
            ? h('iframe', {
                key: `${viewer.url}#${frameKey}`,
                src: viewer.url,
                title: '黑板画布',
                allow: 'fullscreen',
                allowFullScreen: true,
                style: frameStyle,
              })
            : h('div', { style: S.empty },
                h('div', null, viewer.loading ? '正在启动画布…' : '画布不可用'),
                viewer.error ? h('div', { style: S.error }, viewer.error) : null,
                h('div', { style: S.meta }, '画布来自 Infinite Blackboard 自带的查看器：仅监听 127.0.0.1 的随机端口；关闭画布 30 分钟后自动回收，宿主退出或重启即释放'),
                h('div', { style: S.meta }, '若刚刚更新过插件：重启 dsh web 后刷新页面即可。'),
              ));
      }

      if (error) {
        return h('div', { ref: rootRef, style: rootStyle }, header, h('div', { style: S.empty },
          h('div', null, '无法读取黑板数据'), h('div', { style: S.error }, error)));
      }

      if (!data) {
        return h('div', { ref: rootRef, style: rootStyle }, header, h('div', { style: S.empty }, h('div', null, '加载中…')));
      }

      if (!data.ok) {
        const message = data.reason === 'no-board'
          ? '这个工作区（及其上级目录）还没有黑板。运行 blackboard init --title "标题"，或让 AI 记录第一条结论，这里就会出现内容。'
          : (data.message || '暂不可用');
        return h('div', { style: S.root }, header,
          h('div', { style: S.empty },
            h('div', null, '还没有黑板'),
            h('div', { style: { maxWidth: 460 } }, message),
            data.cwd ? h('div', { style: S.meta }, data.cwd) : null));
      }

      const items = visible.map((node) => {
        const isSelected = node.id === selected;
        const isCurrent = node.id === data.cursorId;
        const rels = relations.get(node.id) || [];
        return h('div', {
          key: node.id,
          style: { ...S.item, ...(isSelected ? S.itemSelected : {}), ...(isCurrent ? S.itemCurrent : {}) },
          onClick: () => setSelected(isSelected ? null : node.id),
        },
          h('div', { style: S.row },
            h('span', { style: S.id }, node.id),
            chip(TYPE_LABEL[node.type] || node.type, TYPE_TONE[node.type]),
            h('span', { style: S.nodeTitle }, node.title),
            isCurrent ? chip('当前', '#6f9f8f') : null,
            node.status ? chip(node.status, OPEN_STATES.includes(node.status) ? '#d9b26f' : undefined) : null,
            node.severity ? chip(node.severity, node.severity === 'critical' || node.severity === 'high' ? '#d9705f' : undefined) : null,
            node.confidence ? chip(node.confidence) : null,
            h('span', { style: S.spacer }),
            h('span', { style: S.id }, formatTime(node.ts)),
          ),
          !isSelected && node.detail ? h('div', { style: S.snippet }, node.detail.length > 160 ? `${node.detail.slice(0, 159)}…` : node.detail) : null,
          isSelected ? h('div', null,
            node.detail ? h('div', { style: S.detail }, node.detail) : null,
            (node.tags && node.tags.length) ? h('div', { style: S.detail }, `标签：${node.tags.join(', ')}`) : null,
            node.loc?.path ? h('div', { style: S.detail }, `位置：${node.loc.path}${node.loc.line ? `:${node.loc.line}` : ''}`) : null,
            rels.length ? h('div', { style: S.rel },
              rels.map(({ dir, edge }, index) => {
                const other = byId.get(dir === 'out' ? edge.to : edge.from);
                const label = EDGE_LABEL[edge.kind] || edge.kind;
                return h('div', { key: `${edge.id}-${index}` },
                  dir === 'out'
                    ? `→ ${label} ${other ? `${other.id} ${other.title}` : edge.to}`
                    : `← ${label} ${other ? `${other.id} ${other.title}` : edge.from}`);
              })) : h('div', { style: S.rel }, '还没有显式关系'),
          ) : null,
        );
      });

      return h('div', { ref: rootRef, style: rootStyle },
        header,
        h('input', {
          style: S.search, value: query, placeholder: '搜索标题、详情、标签…',
          onChange: (event) => setQuery(event.target.value),
        }),
        items.length
          ? h('div', { style: S.list }, items)
          : h('div', { style: S.empty }, h('div', null, nodes.length ? '没有匹配的节点' : '黑板还是空的')),
        h('div', { style: S.footer },
          h('span', null, `自动刷新 ${REFRESH_MS / 1000}s`),
          h('span', null, `${visible.length}/${nodes.length} 节点`),
          h('span', null, formatTime(data.updatedAt)),
          data.truncated ? h('span', null, '（内容已截断）') : null,
        ),
      );
    }

    const inject = ['slots'];

    function apply(ctx) {
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'infinite-blackboard',
        order: 20,
        label: () => '黑板',
        inject: (sessionId) => ({ sessionId }),
      }, BlackboardView));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
