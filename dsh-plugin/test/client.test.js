// Browser-half contract: the hand-written bundle must load through the module
// loader, export apply/inject, and register one `conversation.view` tab.
//
// The bundle executes in a `node:vm` sandbox with a fake `window` and a fake
// `react`, so this needs no browser and no DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

function loadBundle() {
  let definition = null;
  const sandbox = {
    window: { __ModuleLoader__: { load: (value) => { definition = value; } } },
    document: { baseURI: 'http://127.0.0.1:3080/' },
    console,
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: false, reason: 'no-board' }) }),
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });
  assert.ok(definition, 'the bundle must call window.__ModuleLoader__.load');
  return definition;
}

function fakeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useRef: (value) => ({ current: value }),
  };
}

test('the bundle registers one conversation view tab', () => {
  const definition = loadBundle();
  assert.equal(definition.id, 'dsh-plugin-infinite-blackboard');

  const module = definition.factory((name) => {
    if (name === 'react') return fakeReact();
    throw new Error(`unexpected external: ${name}`);
  });
  assert.ok(module.inject.includes('slots'));

  let injectedSlot = null;
  let registration = null;
  const ctx = {
    slots: {
      inject: (name, callback) => { injectedSlot = name; callback(); },
      register: (options, Component) => { registration = { options, Component }; return () => {}; },
    },
  };
  module.apply(ctx);

  assert.equal(injectedSlot, 'conversation.view');
  assert.equal(registration.options.name, 'conversation.view');
  assert.equal(registration.options.id, 'infinite-blackboard');
  assert.ok(registration.options.order > 10, 'the tab must sit after Chat (0) and Trajectory (10)');
  assert.equal(registration.options.label(), '黑板');
  // The bundle runs in a separate VM realm, so compare fields, not prototypes.
  assert.equal(registration.options.inject('s1').sessionId, 's1');
  assert.equal(typeof registration.Component, 'function');
});

test('the bundle wires a fullscreen toggle', () => {
  assert.match(source, /requestFullscreen/);
  assert.match(source, /fullscreenchange/);
  assert.match(source, /退出全屏/);
  // The fullscreen shell must follow the host theme instead of painting white.
  assert.match(source, /getComputedStyle/);
  assert.match(source, /--dsw-alias-bg-base/);
  assert.match(source, /frameFull/);
});

test('the component renders a loading frame without throwing', () => {
  const definition = loadBundle();
  const module = definition.factory(() => fakeReact());
  let registration = null;
  module.apply({
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, Component) => { registration = { options, Component }; },
    },
  });
  const element = registration.Component({ sessionId: 's1' });
  assert.ok(element, 'the view must return a React element');
  assert.equal(element.type, 'div');
});
