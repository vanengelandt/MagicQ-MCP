import * as fs from "fs";
import * as path from "path";

export type PaletteType = "colour" | "position" | "beam";
// Groups live in the same registry file so names can be resolved in one place.
export type RegistryType = PaletteType | "group";

export interface PaletteEntry {
  name: string;
  updatedAt: string;
}

export interface Registry {
  colour: Record<string, PaletteEntry>;
  position: Record<string, PaletteEntry>;
  beam: Record<string, PaletteEntry>;
  group: Record<string, PaletteEntry>;
}

const ALL_TYPES: RegistryType[] = ["group", "colour", "position", "beam"];

export function registryPath(): string {
  return path.resolve(process.env.MAGICQ_PALETTE_REGISTRY ?? "palettes.json");
}

function emptyRegistry(): Registry {
  return { colour: {}, position: {}, beam: {}, group: {} };
}

export function loadRegistry(): Registry {
  const p = registryPath();
  if (!fs.existsSync(p)) return emptyRegistry();
  try {
    // Older registry files have no "group" section — fill in missing sections.
    return { ...emptyRegistry(), ...(JSON.parse(fs.readFileSync(p, "utf-8")) as Partial<Registry>) };
  } catch {
    return emptyRegistry();
  }
}

function saveRegistry(registry: Registry): void {
  fs.writeFileSync(registryPath(), JSON.stringify(registry, null, 2) + "\n", "utf-8");
}

export function upsertPalette(type: RegistryType, id: number, name: string): void {
  const registry = loadRegistry();
  registry[type][String(id)] = { name, updatedAt: new Date().toISOString() };
  saveRegistry(registry);
}

const TYPE_LABELS: Record<RegistryType, string> = {
  colour: "Colour",
  position: "Position",
  beam: "Beam",
  group: "Group",
};

function normalise(s: string): string {
  return s.toLowerCase().replace(/[\s_\-]+/g, "");
}

/**
 * Resolve a registry reference to its console ID.
 * Accepts a number, a numeric string ("7"), or a name ("Blue", "rivale prof").
 * Names match case- and whitespace-insensitively: exact first, then unique prefix.
 */
export function resolveId(type: RegistryType, ref: number | string): number {
  if (typeof ref === "number") return ref;
  const trimmed = ref.trim();
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);

  const entries = Object.entries(loadRegistry()[type]);
  const wanted = normalise(trimmed);
  const exact = entries.filter(([, e]) => normalise(e.name) === wanted);
  if (exact.length === 1) return parseInt(exact[0][0], 10);

  const prefix = entries.filter(([, e]) => normalise(e.name).startsWith(wanted));
  if (exact.length === 0 && prefix.length === 1) return parseInt(prefix[0][0], 10);

  const known = entries.map(([id, e]) => `${id} ${e.name}`).join(", ") || "none registered";
  const why = exact.length > 1 || prefix.length > 1 ? "is ambiguous" : "not found";
  throw new Error(`${TYPE_LABELS[type]} "${ref}" ${why}. Known: ${known}`);
}

export function formatRegistry(registry: Registry): string {
  const sections: string[] = [];

  for (const type of ALL_TYPES) {
    const entries = registry[type];
    const ids = Object.keys(entries).map(Number).sort((a, b) => a - b);
    if (ids.length === 0) continue;
    const rows = ids
      .map((id) => `  ${String(id).padStart(4)}  ${entries[String(id)].name}`)
      .join("\n");
    sections.push(`${TYPE_LABELS[type]}${type === "group" ? "s" : " palettes"}:\n${rows}`);
  }

  return sections.length > 0 ? sections.join("\n\n") : "No palettes or groups registered.";
}

export function defaultName(type: RegistryType, id: number): string {
  return `${TYPE_LABELS[type]} ${id}`;
}
