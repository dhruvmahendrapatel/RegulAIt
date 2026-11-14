// P30 spike: n sequential no-op durable steps, to measure the per-step cost of the engine.
async function noop(i: number) {
  "use step";
  return i;
}

export async function benchWorkflow(n: number) {
  "use workflow";
  let sum = 0;
  for (let i = 0; i < n; i++) sum += await noop(i);
  return sum;
}
