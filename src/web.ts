import * as http from "http";

// Reads MagicQ's built-in web server (Setup → Network → Web server, default port 8080).
// Every MagicQ window is served as an HTML table with unclosed <TR>/<TD> tags,
// plus a "modes" form whose submit buttons switch the window's view.

export const WINDOWS = {
  index: "index.html",
  network: "network.html",
  head_editor: "head_editor.html",
  fx_editor: "fx_editor.html",
  palette_view: "palette_view.html",
  record_options: "record_options.html",
  media: "media.html",
  prog: "prog.html",
  outputs: "outputs.html",
  setup: "setup.html",
  patch: "patch.html",
  macros: "macros.html",
  page: "page.html",
  cue_stack: "cue_stack.html",
  cue: "cue.html",
  playbacks: "playbacks.html",
  cue_stack_store: "cue_stack_store.html",
  cue_store: "cue_store.html",
  group: "group.html",
  intensity: "intensity.html",
  fx: "fx.html",
  position: "position.html",
  colour: "colour.html",
  beam: "beam.html",
  timeline: "timeline.html",
  exec: "exec.html",
} as const;

export type WindowName = keyof typeof WINDOWS;

export interface WebConfig {
  host: string;
  port: number;
}

export function getWebConfig(): WebConfig {
  return {
    host: process.env.MAGICQ_WEB_HOST ?? process.env.MAGICQ_IP ?? "127.0.0.1",
    port: parseInt(process.env.MAGICQ_WEB_PORT ?? "8080", 10),
  };
}

export function fetchPage(path: string, cfg: WebConfig, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: cfg.host, port: cfg.port, path: "/" + path, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("latin1")));
    });
    req.on("timeout", () => req.destroy(new Error(`MagicQ web server timeout (${cfg.host}:${cfg.port})`)));
    req.on("error", reject);
  });
}

function cellText(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export interface ViewMode {
  name: string; // form field name ("1", "2", …)
  label: string;
  active: boolean;
}

export interface WindowData {
  title: string;
  modes: ViewMode[];
  header: string[];
  rows: string[][];
}

// Parse the main window table (the one with a CAPTION) of a MagicQ web page.
export function parseWindow(html: string): WindowData {
  const modes: ViewMode[] = [];
  for (const m of html.matchAll(/<INPUT[^>]*type="submit"[^>]*>/gi)) {
    const tag = m[0];
    const name = /name="([^"]*)"/i.exec(tag)?.[1];
    const label = /value="([^"]*)"/i.exec(tag)?.[1];
    if (name && label && /^\d+$/.test(name)) {
      modes.push({ name, label: label.trim(), active: /background-color:\s*blue/i.test(tag) });
    }
  }

  const tables = html.split(/<TABLE/i).slice(1);
  const main = tables.find((t) => /<CAPTION/i.test(t)) ?? tables[tables.length - 1] ?? "";
  const body = main.split(/<\/TABLE>/i)[0];
  const title = cellText(/<CAPTION>([\s\S]*?)<\/CAPTION>/i.exec(body)?.[1] ?? "");

  let header: string[] = [];
  const rows: string[][] = [];
  for (const tr of body.split(/<TR[^>]*>/i).slice(1)) {
    if (/<TH/i.test(tr)) {
      header = tr.split(/<TH[^>]*>/i).slice(1).map(cellText);
    } else {
      const cells = tr.split(/<TD[^>]*>/i).slice(1).map(cellText);
      if (cells.length) rows.push(cells);
    }
  }
  return { title, modes, header, rows };
}

export interface FormatOptions {
  filter?: string;
  columns?: string[];
  maxRows: number;
}

// Tables with a header: keep rows matching the filter, drop columns that are
// empty in every kept row. Grid windows (no header): list non-empty cells that
// carry more than their slot id (e.g. "G6 RivaleProf 32", not "G9").
export function formatWindow(w: WindowData, opts: FormatOptions): string {
  const f = opts.filter?.toLowerCase();
  const out: string[] = [];
  if (w.title) out.push(w.title);
  if (w.modes.length) {
    out.push("Views: " + w.modes.map((m) => `${m.name}=${m.label}${m.active ? "*" : ""}`).join(", "));
  }

  if (!w.header.some((h) => h)) {
    const cells = w.rows.flat().filter((c) => c && /\s/.test(c) && (!f || c.toLowerCase().includes(f)));
    out.push(cells.length ? cells.join("\n") : "(no filled entries)");
    return out.join("\n");
  }

  let rows = w.rows.filter((r) => r.some((c) => c) && (!f || r.join(" ").toLowerCase().includes(f)));
  const total = rows.length;
  let cols = w.header.map((_, i) => i).filter((i) => rows.some((r) => (r[i] ?? "") !== ""));
  if (opts.columns?.length) {
    const want = opts.columns.map((c) => c.toLowerCase());
    cols = cols.filter((i) => i < 3 || want.some((c) => w.header[i].toLowerCase().includes(c)));
  }
  rows = rows.slice(0, opts.maxRows);
  out.push(cols.map((i) => w.header[i] || `#${i}`).join("\t"));
  for (const r of rows) out.push(cols.map((i) => r[i] ?? "").join("\t"));
  out.push(total ? `(${rows.length} of ${total} row(s))` : "(no rows)");
  return out.join("\n");
}

// Read one window, optionally switching its view first (view = mode number or label).
export async function readWindow(name: WindowName, cfg: WebConfig, view?: string): Promise<WindowData> {
  const page = WINDOWS[name];
  if (view !== undefined) {
    const current = parseWindow(await fetchPage(page, cfg));
    const mode = current.modes.find((m) => m.name === view || m.label.toLowerCase() === view.toLowerCase());
    if (!mode) {
      throw new Error(`No view "${view}" in ${name}; views: ${current.modes.map((m) => `${m.name}=${m.label}`).join(", ")}`);
    }
    return parseWindow(await fetchPage(`${page}?${mode.name}=${encodeURIComponent(mode.label)}`, cfg));
  }
  return parseWindow(await fetchPage(page, cfg));
}

// Remote keypad: type MagicQ command-line text and press a key.
export const KEYPAD_KEYS = ["ENTER", "CL", "RC", "IN", "UN", "NH", "HL", "<", ">"] as const;
export type KeypadKey = (typeof KEYPAD_KEYS)[number];

export async function keypad(text: string, key: KeypadKey, cfg: WebConfig): Promise<string> {
  const q = new URLSearchParams({ ans: text });
  // ENTER is an unnamed submit (sends only ans); "<"/">" buttons carry padded values.
  if (key !== "ENTER") q.set("cmd", key === "<" || key === ">" ? `  ${key}  ` : key);
  const html = await fetchPage(`remote.html?${q.toString()}`, cfg);
  // The page echoes the selection line, e.g. "Selected head (0%)".
  const status = /Selected[^<]*/i.exec(html)?.[0]?.trim();
  return status ?? "";
}
