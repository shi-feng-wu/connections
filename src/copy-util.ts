// Fills {placeholders} in a copy string from src/discord-copy.md (via the generated COPY map in
// src/discord-copy.ts). A {name} with no matching var is left as-is, so a typo shows up in the
// message rather than throwing. Pure — safe in both the server functions and the browser preview.
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name) =>
    name in vars ? String(vars[name]) : whole,
  );
}
