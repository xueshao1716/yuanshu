import fs from 'node:fs';
import vm from 'node:vm';
import ts from '../../frontend/node_modules/typescript/lib/typescript.js';

// Execute the actual TypeScript hook. Only React scheduling and browser primitives
// are controlled; event handlers, effect dependencies and scrolling stay real code.
export function hookRuntime(file, exportName) {
  const slots = [], effects = [], frames = new Map(), observers = [];
  let cursor = 0, nextFrame = 0, dirty = false, result, args, element;
  const same = (a, b) => a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const react = {
    useRef(value) { const i = cursor++; return slots[i] ||= { current: value }; },
    useState(value) {
      const i = cursor++; if (!(i in slots)) slots[i] = typeof value === 'function' ? value() : value;
      return [slots[i], value => { const next = typeof value === 'function' ? value(slots[i]) : value; if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; } }];
    },
    useCallback(fn, deps) { const i = cursor++; if (!same(slots[i]?.deps, deps)) slots[i] = { fn, deps }; return slots[i].fn; },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!same(slots[i]?.deps, deps)) effects.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; });
    },
  };
  react.useLayoutEffect = react.useEffect;
  const target = () => {
    const listeners = new Map();
    return { addEventListener(n, fn) { if (!listeners.has(n)) listeners.set(n, new Set()); listeners.get(n).add(fn); },
      removeEventListener(n, fn) { listeners.get(n)?.delete(fn); },
      fire(n, event = {}) { for (const fn of [...(listeners.get(n) || [])]) fn(event); },
      count(n) { return listeners.get(n)?.size || 0; } };
  };
  const exports = {}, win = target();
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(source, { exports, require: n => { if (n === 'react') return react; throw new Error(n); },
    Date, console, window: win, document: win,
    requestAnimationFrame(fn) { const id = ++nextFrame; frames.set(id, fn); return id; }, cancelAnimationFrame(id) { frames.delete(id); },
    ResizeObserver: class { constructor(fn) { this.fn = fn; observers.push(this); } observe() { this.dead = false; } disconnect() { this.dead = true; } },
    MutationObserver: class { observe() {} disconnect() {} },
  });
  function render(nextArgs = args, nextElement = element) {
    args = nextArgs; element = nextElement;
    for (let n = 0; n < 20; n++) {
      dirty = false; cursor = 0; result = exports[exportName](args);
      if (result.bindScroll) result.bindScroll(element);
      else if (result.bindContainer) result.bindContainer(element);
      else if (result.scrollRef) result.scrollRef.current = element;
      else if (result.containerRef) result.containerRef.current = element;
      for (const effect of effects.splice(0)) effect();
      if (!dirty) return result;
    }
    throw new Error('render loop');
  }
  return { render, get result() { return result; }, window: win,
    flush() { const batch = [...frames.values()]; frames.clear(); for (const fn of batch) fn(); },
    resize() { for (const o of observers) if (!o.dead) o.fn(); },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
    element() { return Object.assign(target(), { scrollHeight: 2000, clientHeight: 500, scrollTop: 1500, firstElementChild: {}, children: [] }); },
  };
}
