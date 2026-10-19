/** Fills `{{plumb:<key>}}`; `{{fill: ...}}` tokens are left for the agent. A key without a value is a template bug. */
export function render(text: string, values: Readonly<Record<string, string>>): string {
  return text.replaceAll(/\{\{plumb:([a-z-]+)\}\}/g, (_whole, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`template token {{plumb:${key}}} has no value`);
    return value;
  });
}
