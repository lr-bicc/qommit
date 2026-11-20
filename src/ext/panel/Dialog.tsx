import type { ComponentChildren, JSX } from "preact";

let counter = 0;

/** A modal box over the panel. The title is its accessible name. */
export function Dialog(props: { title: string; children: ComponentChildren }): JSX.Element {
  const id = `dialog-title-${++counter}`;
  return (
    <div class="overlay">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby={id}>
        <h2 id={id}>{props.title}</h2>
        {props.children}
      </div>
    </div>
  );
}
