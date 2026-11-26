/** Process-wide flag set once from CLI args; core write helpers consult it before touching the filesystem. */
let dryRun = false;

export function setDryRun(value: boolean): void {
  dryRun = value;
}

export function isDryRun(): boolean {
  return dryRun;
}
