/** Tiny DOM helper. Text is always set via textContent (never innerHTML) — no HTML injection. */
type Child = Node | string | null | undefined | false;
interface Props {
  class?: string;
  text?: string;
  attrs?: Record<string, string | boolean>;
  on?: Partial<Record<keyof HTMLElementEventMap, (e: Event) => void>>;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs ?? {})) {
    if (v === false) continue;
    el.setAttribute(k, v === true ? '' : v);
  }
  for (const [evt, fn] of Object.entries(props.on ?? {})) if (fn) el.addEventListener(evt, fn);
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function clear(el: Element): void {
  el.replaceChildren();
}
