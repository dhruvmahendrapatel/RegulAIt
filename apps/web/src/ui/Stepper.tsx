import type { ReactNode } from "react";
import st from "./stepper.module.css";

/**
 * I-2 (#453; moved into the kit in the review of #690): a stepper of sections shown one at a time. Every step is a
 * button that states its own status, a finished step stays clickable to go back, and the current one carries
 * `aria-current="step"`. The ✓ mark is decorative, so a finished step also says "done" to a screen reader.
 */
export interface StepperStep<K extends string> {
  id: K;
  label: ReactNode;
  /** finished: shows ✓ (and "done" to a screen reader) unless it is the current step */
  done: boolean;
  /** the step's own status, shown inside its button */
  status?: ReactNode;
}

export function Stepper<K extends string>(props: {
  label: string;
  steps: ReadonlyArray<StepperStep<K>>;
  /** the open step; null marks none (a page whose steps have not loaded yet) */
  current: K | null;
  onSelect: (id: K) => void;
}) {
  return (
    <ol className={st.steps} aria-label={props.label}>
      {props.steps.map((x, i) => {
        const on = x.id === props.current;
        const done = x.done && !on;
        return (
          <li key={x.id} className={on ? st.stepOn : x.done ? st.stepDone : undefined}>
            <button type="button" aria-current={on ? "step" : undefined} onClick={() => props.onSelect(x.id)}>
              <span className={st.stepNum} aria-hidden>
                {done ? "✓" : i + 1}
              </span>
              <span>{x.label}</span>
              {done && <span className={st.srOnly}> (done)</span>}
              {x.status}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
