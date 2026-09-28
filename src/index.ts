#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getConfig, sendCommand, sendCommands, sendOscMessage, delay, type OscValue } from "./transport.js";
import { ATTR } from "./attributes.js";
import {
  loadRegistry,
  upsertPalette,
  formatRegistry,
  defaultName,
  resolveId,
  type RegistryType,
} from "./palette-registry.js";
import { importCsv } from "./csv-import.js";
import { StepSchema, executeSequence, selectAllCommand } from "./sequence.js";
import { startFeedbackListener, feedbackStatus, getLatest, getRecent, isListening } from "./feedback.js";
import {
  WINDOWS,
  type WindowName,
  KEYPAD_KEYS,
  getWebConfig,
  fetchPage,
  parseWindow,
  readWindow,
  formatWindow,
  keypad,
} from "./web.js";

const config = getConfig();

const feedbackPort = process.env.MAGICQ_FEEDBACK_PORT;
if (feedbackPort) startFeedbackListener(parseInt(feedbackPort, 10));

// A palette/group reference: console number or registry name ("Red", "RivaleProf").
const Ref = z.union([z.number().int().min(1), z.string().min(1)]);
const server = new McpServer({ name: "magicq", version: "0.1.0" });

// ── Helpers ──────────────────────────────────────────────────────────────────

function ok(msg: string) {
  return { content: [{ type: "text" as const, text: msg }] };
}

// ── Playback control tools ────────────────────────────────────────────────────

server.tool(
  "activate_playback",
  "Activate a playback (fader goes live). Optionally set the level (0–100) at the same time.",
  {
    playback: z.number().int().min(1).max(202).describe("Playback number (1–202; 1–10 on PC/Mac without hardware)"),
    level: z.number().int().min(0).max(100).optional().describe("Fader level 0–100 (optional)"),
  },
  async ({ playback, level }) => {
    if (level !== undefined) {
      await sendCommands([`${playback}A`, `${playback},${level}L`], config);
    } else {
      await sendCommand(`${playback}A`, config);
    }
    return ok(`Activated PB${playback}${level !== undefined ? ` at ${level}%` : ""}`);
  }
);

server.tool(
  "release_playback",
  "Release (deactivate) a playback.",
  {
    playback: z.number().int().min(1).max(202).describe("Playback number"),
  },
  async ({ playback }) => {
    await sendCommand(`${playback}R`, config);
    return ok(`Released PB${playback}`);
  }
);

server.tool(
  "go_playback",
  "Send a Go (step forward) to a playback, advancing to the next cue in the stack.",
  {
    playback: z.number().int().min(1).max(202).describe("Playback number"),
  },
  async ({ playback }) => {
    await sendCommand(`${playback}G`, config);
    return ok(`Go on PB${playback}`);
  }
);

server.tool(
  "stop_playback",
  "Stop/go-back on a playback.",
  {
    playback: z.number().int().min(1).max(202).describe("Playback number"),
  },
  async ({ playback }) => {
    await sendCommand(`${playback}S`, config);
    return ok(`Stop on PB${playback}`);
  }
);

server.tool(
  "set_playback_level",
  "Set the fader level of a playback (0–100).",
  {
    playback: z.number().int().min(1).max(202).describe("Playback number"),
    level: z.number().int().min(0).max(100).describe("Fader level 0–100"),
  },
  async ({ playback, level }) => {
    await sendCommand(`${playback},${level}L`, config);
    return ok(`PB${playback} level → ${level}%`);
  }
);

server.tool(
  "jump_to_cue",
  "Jump to a specific cue on a playback. cue_id is the integer part, cue_id_dec is the decimal part (e.g. cue 2.5 → cue_id=2, cue_id_dec=50).",
  {
    playback: z.number().int().min(1).max(202).describe("Playback number"),
    cue_id: z.number().int().min(1).max(65536).describe("Cue ID integer part"),
    cue_id_dec: z.number().int().min(0).max(99).default(0).describe("Cue ID decimal part (0 for whole cues)"),
  },
  async ({ playback, cue_id, cue_id_dec }) => {
    await sendCommand(`${playback},${cue_id},${cue_id_dec}J`, config);
    return ok(`PB${playback} jumped to cue ${cue_id}.${cue_id_dec.toString().padStart(2, "0")}`);
  }
);

server.tool(
  "change_page",
  "Change the active playback page on the console.",
  {
    page: z.number().int().min(1).describe("Page number"),
  },
  async ({ page }) => {
    await sendCommand(`${page}P`, config);
    return ok(`Changed to page ${page}`);
  }
);

server.tool(
  "test_playback",
  "Activate a playback at 100% (test mode).",
  {
    playback: z.number().int().min(1).max(202).describe("Playback number"),
  },
  async ({ playback }) => {
    await sendCommand(`${playback}T`, config);
    return ok(`Testing PB${playback} at 100%`);
  }
);

server.tool(
  "untest_playback",
  "Release a playback from test mode (back to 0%).",
  {
    playback: z.number().int().min(1).max(202).describe("Playback number"),
  },
  async ({ playback }) => {
    await sendCommand(`${playback}U`, config);
    return ok(`Un-tested PB${playback}`);
  }
);

// ── Direct DMX ───────────────────────────────────────────────────────────────

server.tool(
  "set_channel",
  "Set a DMX channel intensity directly (bypasses programmer).",
  {
    channel: z.number().int().min(1).max(32768).describe("DMX channel number"),
    level: z.number().int().min(0).max(100).describe("Level 0–100"),
  },
  async ({ channel, level }) => {
    await sendCommand(`${channel},${level}I`, config);
    return ok(`DMX channel ${channel} → ${level}%`);
  }
);

// ── Programmer tools ──────────────────────────────────────────────────────────

server.tool(
  "select_heads",
  "Select one or a range of fixture heads in the programmer.",
  {
    start: z.number().int().min(1).max(6145).describe("First head number"),
    end: z.number().int().min(1).max(6145).optional().describe("Last head number (omit for single head)"),
  },
  async ({ start, end }) => {
    const cmd = end !== undefined ? `1,${start},${end}H` : `1,${start}H`;
    await sendCommand(cmd, config);
    return ok(`Selected head${end !== undefined ? `s ${start}–${end}` : ` ${start}`}`);
  }
);

server.tool(
  "deselect_heads",
  "Deselect one or a range of fixture heads.",
  {
    start: z.number().int().min(1).max(6145).describe("First head number"),
    end: z.number().int().min(1).max(6145).optional().describe("Last head number (omit for single head)"),
  },
  async ({ start, end }) => {
    const cmd = end !== undefined ? `2,${start},${end}H` : `2,${start}H`;
    await sendCommand(cmd, config);
    return ok(`Deselected head${end !== undefined ? `s ${start}–${end}` : ` ${start}`}`);
  }
);

server.tool(
  "deselect_all_heads",
  "Deselect all fixture heads.",
  {},
  async () => {
    await sendCommand("3H", config);
    return ok("Deselected all heads");
  }
);

server.tool(
  "select_group",
  "Select a fixture group by number.",
  {
    group: z.number().int().min(1).max(200).describe("Group number (1–200)"),
  },
  async ({ group }) => {
    await sendCommand(`4,${group}H`, config);
    return ok(`Selected group ${group}`);
  }
);

server.tool(
  "set_intensity",
  "Set the intensity of currently selected heads.",
  {
    level: z.number().int().min(0).max(100).describe("Intensity level 0–100"),
    fade_time: z.number().int().min(0).optional().describe("Fade time in seconds (optional)"),
  },
  async ({ level, fade_time }) => {
    const cmd = fade_time !== undefined ? `5,${level},${fade_time}H` : `5,${level}H`;
    await sendCommand(cmd, config);
    return ok(`Intensity → ${level}%${fade_time !== undefined ? ` over ${fade_time}s` : ""}`);
  }
);

server.tool(
  "set_attribute",
  "Set a raw attribute value on currently selected heads (see attribute_list). Values are 0–255. Colour mix 16/17/18 is Cyan/Magenta/Yellow (inverse of R/G/B), e.g. red = 16:0, 17:255, 18:255.",
  {
    attr: z.number().int().min(0).max(51).describe("Attribute number"),
    value: z.number().int().min(0).max(65535).describe("Attribute value"),
    fade_time: z.number().int().min(0).optional().describe("Fade time in seconds (optional)"),
  },
  async ({ attr, value, fade_time }) => {
    const cmd = fade_time !== undefined ? `6,${attr},${value},${fade_time}H` : `6,${attr},${value}H`;
    await sendCommand(cmd, config);
    return ok(`Attribute ${attr} → ${value}${fade_time !== undefined ? ` over ${fade_time}s` : ""}`);
  }
);

server.tool(
  "increment_attribute",
  "Increment an attribute on currently selected heads.",
  {
    attr: z.number().int().min(0).max(51).describe("Attribute number"),
    value: z.number().int().min(0).max(65535).describe("Amount to increment"),
    sixteen_bit: z.boolean().default(false).describe("Use 16-bit resolution (default false = 8-bit)"),
  },
  async ({ attr, value, sixteen_bit }) => {
    await sendCommand(`7,${attr},${value},${sixteen_bit ? 1 : 0}H`, config);
    return ok(`Attribute ${attr} incremented by ${value}`);
  }
);

server.tool(
  "decrement_attribute",
  "Decrement an attribute on currently selected heads.",
  {
    attr: z.number().int().min(0).max(51).describe("Attribute number"),
    value: z.number().int().min(0).max(65535).describe("Amount to decrement"),
    sixteen_bit: z.boolean().default(false).describe("Use 16-bit resolution (default false = 8-bit)"),
  },
  async ({ attr, value, sixteen_bit }) => {
    await sendCommand(`8,${attr},${value},${sixteen_bit ? 1 : 0}H`, config);
    return ok(`Attribute ${attr} decremented by ${value}`);
  }
);

server.tool(
  "clear_programmer",
  "Clear the programmer (remove all unsaved changes from the edit buffer). Always call this before and after building a look.",
  {},
  async () => {
    await sendCommand("9H", config);
    return ok("Programmer cleared");
  }
);

server.tool(
  "include_position_palette",
  "Include a position palette into the programmer.",
  {
    palette_id: z.number().int().min(1).max(1024).describe("Position palette ID"),
  },
  async ({ palette_id }) => {
    await sendCommand(`10,${palette_id}H`, config);
    return ok(`Included position palette ${palette_id}`);
  }
);

server.tool(
  "include_colour_palette",
  "Include a colour palette into the programmer. Applies the palette to EVERY head stored in it, regardless of the current selection.",
  {
    palette_id: z.number().int().min(1).max(1024).describe("Colour palette ID"),
  },
  async ({ palette_id }) => {
    await sendCommand(`11,${palette_id}H`, config);
    return ok(`Included colour palette ${palette_id}`);
  }
);

server.tool(
  "include_beam_palette",
  "Include a beam palette into the programmer.",
  {
    palette_id: z.number().int().min(1).max(1024).describe("Beam palette ID"),
  },
  async ({ palette_id }) => {
    await sendCommand(`12,${palette_id}H`, config);
    return ok(`Included beam palette ${palette_id}`);
  }
);

server.tool(
  "include_cue",
  "Include a cue into the programmer (load its values into the edit buffer).",
  {
    cue_id: z.number().int().min(1).max(5000).describe("Cue ID"),
  },
  async ({ cue_id }) => {
    await sendCommand(`13,${cue_id}H`, config);
    return ok(`Included cue ${cue_id} into programmer`);
  }
);

server.tool(
  "update",
  "Save programmer values back to their source cues/palettes (update in place).",
  {},
  async () => {
    await sendCommand("19H", config);
    return ok("Updated — programmer values saved back to source");
  }
);

server.tool(
  "record_position_palette",
  "Record the current programmer values as a position palette. Providing a name saves it to the local registry so Claude can reference it by name in future sessions.",
  {
    palette_id: z.number().int().min(1).max(1024).describe("Position palette ID to record into"),
    name: z.string().optional().describe("Human-readable name for this palette (e.g. \"Centre Stage\")"),
  },
  async ({ palette_id, name }) => {
    await sendCommand(`20,${palette_id}H`, config);
    const resolvedName = name ?? defaultName("position", palette_id);
    upsertPalette("position", palette_id, resolvedName);
    return ok(`Recorded position palette ${palette_id} ("${resolvedName}")`);
  }
);

server.tool(
  "record_colour_palette",
  "Record the current programmer values as a colour palette. Providing a name saves it to the local registry so Claude can reference it by name in future sessions.",
  {
    palette_id: z.number().int().min(1).max(1024).describe("Colour palette ID to record into"),
    name: z.string().optional().describe("Human-readable name for this palette (e.g. \"Deep Blue\")"),
  },
  async ({ palette_id, name }) => {
    await sendCommand(`21,${palette_id}H`, config);
    const resolvedName = name ?? defaultName("colour", palette_id);
    upsertPalette("colour", palette_id, resolvedName);
    return ok(`Recorded colour palette ${palette_id} ("${resolvedName}")`);
  }
);

server.tool(
  "record_beam_palette",
  "Record the current programmer values as a beam palette. Providing a name saves it to the local registry so Claude can reference it by name in future sessions.",
  {
    palette_id: z.number().int().min(1).max(1024).describe("Beam palette ID to record into"),
    name: z.string().optional().describe("Human-readable name for this palette (e.g. \"Open White\")"),
  },
  async ({ palette_id, name }) => {
    await sendCommand(`22,${palette_id}H`, config);
    const resolvedName = name ?? defaultName("beam", palette_id);
    upsertPalette("beam", palette_id, resolvedName);
    return ok(`Recorded beam palette ${palette_id} ("${resolvedName}")`);
  }
);

server.tool(
  "record_cue",
  "Record the current programmer contents as a cue. The cue stack must already exist on the console.",
  {
    cue_id: z.number().int().min(1).max(5000).describe("Cue ID to record into"),
  },
  async ({ cue_id }) => {
    await sendCommand(`23,${cue_id}H`, config);
    return ok(`Recorded cue ${cue_id}`);
  }
);

server.tool(
  "next_head",
  "Select the next head (cycle through selected heads).",
  {},
  async () => {
    await sendCommand("30H", config);
    return ok("Next head selected");
  }
);

server.tool(
  "prev_head",
  "Select the previous head (cycle through selected heads).",
  {},
  async () => {
    await sendCommand("31H", config);
    return ok("Previous head selected");
  }
);

server.tool(
  "all_heads",
  "MagicQ 'All' key: re-selects all heads WITHIN the current selection (after next/prev head). Selects nothing when the selection is empty — use select_all_heads to select every fixture.",
  {},
  async () => {
    await sendCommand("32H", config);
    return ok("All (within current selection) sent — does nothing if no heads were selected");
  }
);

server.tool(
  "select_all_heads",
  "Select every fixture in the show (head range 1..MAGICQ_MAX_HEAD, default 6145).",
  {},
  async () => {
    await sendCommand(selectAllCommand(), config);
    return ok(`Selected all heads (${selectAllCommand()})`);
  }
);

server.tool(
  "locate_heads",
  "Locate selected heads (reset to default position/attributes).",
  {},
  async () => {
    await sendCommand("40H", config);
    return ok("Heads located");
  }
);

server.tool(
  "lamp_on",
  "Strike the lamp on selected heads.",
  {},
  async () => {
    await sendCommand("41H", config);
    return ok("Lamp on sent to selected heads");
  }
);

server.tool(
  "lamp_off",
  "Douse the lamp on selected heads.",
  {},
  async () => {
    await sendCommand("42H", config);
    return ok("Lamp off sent to selected heads");
  }
);

server.tool(
  "reset_heads",
  "Reset selected heads.",
  {},
  async () => {
    await sendCommand("43H", config);
    return ok("Reset sent to selected heads");
  }
);

// ── High-level composite tools ────────────────────────────────────────────────

server.tool(
  "program_look",
  "Build and record a complete lighting look in one call: clears programmer, selects heads or group, optionally includes colour/position/beam palettes, sets intensity and any raw attribute overrides, records the cue, then clears programmer. Use run_sequence for multi-cue sessions.",
  {
    group: z.number().int().min(1).max(200).optional().describe("Group number — preferred over heads_start/end when a group exists"),
    heads_start: z.number().int().min(1).max(6145).optional().describe("First head number (used when no group is specified)"),
    heads_end: z.number().int().min(1).max(6145).optional().describe("Last head number (omit for single head)"),
    colour_palette_id: z.number().int().min(1).max(1024).optional().describe("Colour palette to include"),
    position_palette_id: z.number().int().min(1).max(1024).optional().describe("Position palette to include"),
    beam_palette_id: z.number().int().min(1).max(1024).optional().describe("Beam palette to include"),
    intensity: z.number().int().min(0).max(100).describe("Intensity level 0–100"),
    attributes: z.record(z.string(), z.number().int()).optional().describe(
      "Hard-coded attribute overrides beyond palettes — map of attribute number (string key) to value"
    ),
    cue_id: z.number().int().min(1).max(5000).describe("Cue ID to record into"),
  },
  async ({ group, heads_start, heads_end, colour_palette_id, position_palette_id, beam_palette_id, intensity, attributes, cue_id }) => {
    const cmds: string[] = [];

    cmds.push("9H"); // clear programmer first
    if (group !== undefined) {
      cmds.push(`4,${group}H`);
    } else if (heads_start !== undefined) {
      cmds.push(heads_end !== undefined ? `1,${heads_start},${heads_end}H` : `1,${heads_start}H`);
    }
    if (colour_palette_id !== undefined) cmds.push(`11,${colour_palette_id}H`);
    if (position_palette_id !== undefined) cmds.push(`10,${position_palette_id}H`);
    if (beam_palette_id !== undefined) cmds.push(`12,${beam_palette_id}H`);
    cmds.push(`5,${intensity}H`);
    if (attributes) {
      for (const [attr, value] of Object.entries(attributes)) {
        cmds.push(`6,${attr},${value}H`);
      }
    }
    cmds.push(`23,${cue_id}H`);
    cmds.push("9H"); // clear programmer after

    await sendCommands(cmds, config);

    const selectionDesc = group !== undefined
      ? `group ${group}`
      : heads_end !== undefined ? `heads ${heads_start}–${heads_end}` : `head ${heads_start}`;
    const palettes = [
      colour_palette_id !== undefined ? `colour ${colour_palette_id}` : null,
      position_palette_id !== undefined ? `position ${position_palette_id}` : null,
      beam_palette_id !== undefined ? `beam ${beam_palette_id}` : null,
    ].filter(Boolean);
    const attrCount = attributes ? Object.keys(attributes).length : 0;

    return ok(
      [
        `Programmed look: ${selectionDesc}, intensity ${intensity}%`,
        palettes.length > 0 ? `palettes: ${palettes.join(", ")}` : null,
        attrCount > 0 ? `${attrCount} raw attribute override(s)` : null,
        `→ recorded as cue ${cue_id}, programmer cleared`,
      ].filter(Boolean).join("; ")
    );
  }
);

server.tool(
  "apply_look",
  [
    "Put a look live in the programmer in ONE call, without recording a cue.",
    "For a different colour per group use rgb (selected heads only) — colour palettes apply to all their heads.",
    "Selects groups (by number or registry name, e.g. \"RivaleProf\"), a head range, or all heads,",
    "then includes colour/position/beam palettes (number or name, e.g. \"Red\") and sets intensity.",
    "clear_first (default true) clears the programmer before; the look stays live until clear_programmer.",
    "Several groups get the same look — call again with clear_first=false to layer a different look on other groups.",
  ].join("\n"),
  {
    groups: z.array(Ref).optional().describe("Groups to select (numbers or names)"),
    heads_start: z.number().int().min(1).max(6145).optional().describe("First head of a range (when no groups)"),
    heads_end: z.number().int().min(1).max(6145).optional().describe("Last head of the range"),
    all_heads: z.boolean().optional().describe("Select every fixture (when no groups / heads given)"),
    colour: Ref.optional().describe("Colour palette number or name. NOTE: include applies the palette to EVERY head stored in it, not just the selection — use rgb for per-group colour"),
    rgb: z.tuple([z.number().int().min(0).max(255), z.number().int().min(0).max(255), z.number().int().min(0).max(255)])
      .optional().describe("Colour for the SELECTED heads only, as [r,g,b] 0–255 (sent as CMY attributes 16–18)"),
    position: Ref.optional().describe("Position palette number or name"),
    beam: Ref.optional().describe("Beam palette number or name"),
    intensity: z.number().int().min(0).max(100).optional().describe("Intensity 0–100"),
    fade_time: z.number().int().min(0).optional().describe("Intensity fade time in seconds"),
    attributes: z.record(z.string(), z.number().int()).optional().describe("Raw attribute overrides {attr: value}"),
    clear_first: z.boolean().default(true).describe("Clear the programmer first (default true)"),
  },
  async (a) => {
    // Resolve every name before sending anything, so a typo sends nothing.
    const groupIds = (a.groups ?? []).map((g) => resolveId("group", g));
    const colourId = a.colour !== undefined ? resolveId("colour", a.colour) : undefined;
    const positionId = a.position !== undefined ? resolveId("position", a.position) : undefined;
    const beamId = a.beam !== undefined ? resolveId("beam", a.beam) : undefined;

    const cmds: string[] = [];
    const desc: string[] = [];
    if (a.clear_first) { cmds.push("9H"); desc.push("cleared"); }

    if (groupIds.length > 0) {
      for (const g of groupIds) cmds.push(`4,${g}H`);
      desc.push(`groups ${groupIds.join(", ")}`);
    } else if (a.heads_start !== undefined) {
      cmds.push(a.heads_end !== undefined ? `1,${a.heads_start},${a.heads_end}H` : `1,${a.heads_start}H`);
      desc.push(`heads ${a.heads_start}${a.heads_end !== undefined ? `–${a.heads_end}` : ""}`);
    } else if (a.all_heads) {
      cmds.push(selectAllCommand());
      desc.push("all heads");
    } else if (a.clear_first) {
      throw new Error("No selection: pass groups, heads_start or all_heads (the programmer was not changed).");
    }

    if (colourId !== undefined) { cmds.push(`11,${colourId}H`); desc.push(`colour ${colourId}`); }
    if (positionId !== undefined) { cmds.push(`10,${positionId}H`); desc.push(`position ${positionId}`); }
    if (beamId !== undefined) { cmds.push(`12,${beamId}H`); desc.push(`beam ${beamId}`); }
    if (a.rgb) {
      // MagicQ colour-mix attributes are Cyan/Magenta/Yellow (0–255), converted to RGB per fixture.
      const [r, g, b] = a.rgb;
      cmds.push(`6,16,${255 - r}H`, `6,17,${255 - g}H`, `6,18,${255 - b}H`);
      desc.push(`rgb ${r},${g},${b}`);
    }
    if (a.intensity !== undefined) {
      cmds.push(a.fade_time !== undefined ? `5,${a.intensity},${a.fade_time}H` : `5,${a.intensity}H`);
      desc.push(`intensity ${a.intensity}%${a.fade_time !== undefined ? ` over ${a.fade_time}s` : ""}`);
    }
    for (const [attr, value] of Object.entries(a.attributes ?? {})) {
      cmds.push(`6,${attr},${value}H`);
      desc.push(`attr ${attr}=${value}`);
    }

    await sendCommands(cmds, config);
    return ok(`Look live: ${desc.join("; ")}\nSent: ${cmds.join(" ")}`);
  }
);

// ── Palette registry tools ────────────────────────────────────────────────────

server.tool(
  "list_palettes",
  "List all groups and palettes in the local registry (group, colour, position, beam). Use this at the start of a session — names listed here can be passed to apply_look.",
  {},
  async () => {
    const registry = loadRegistry();
    return ok(formatRegistry(registry));
  }
);

server.tool(
  "declare_palette",
  "Register a palette or group that already exists on the console into the local registry, so it can be referenced by name. Does not send any command to MagicQ.",
  {
    type: z.enum(["colour", "position", "beam", "group"]).describe("Palette type, or 'group'"),
    palette_id: z.number().int().min(1).max(1024).describe("Palette / group number on the console"),
    name: z.string().min(1).describe("Name as shown on the console"),
  },
  async ({ type, palette_id, name }) => {
    upsertPalette(type as RegistryType, palette_id, name);
    return ok(`Registered ${type} palette ${palette_id} as "${name}"`);
  }
);

server.tool(
  "import_palettes_csv",
  [
    "Import palette names from a CSV file into the local registry.",
    "Expected format (one palette per line): type,id,name",
    "  type: colour | color | c | position | p | beam | b  (case-insensitive)",
    "  id:   palette number (1–1024)",
    "  name: human-readable label (optional — defaults to 'Colour N' etc.)",
    "Lines starting with # and blank lines are ignored.",
    "MagicQ raw attribute-value exports (where the third column is a number) are accepted but use a default name.",
  ].join("\n"),
  {
    file_path: z.string().describe("Absolute path to the CSV file"),
  },
  async ({ file_path }) => {
    const result = importCsv(file_path);
    const parts = [`Imported ${result.imported} palette(s)`];
    if (result.skipped > 0) parts.push(`skipped ${result.skipped} unrecognised row(s)`);
    if (result.errors.length > 0) parts.push(`errors:\n${result.errors.join("\n")}`);
    return ok(parts.join("; "));
  }
);

server.resource(
  "palette-registry",
  "palettes://registry",
  { description: "All registered MagicQ palettes (colour, position, beam) with their IDs and names.", mimeType: "text/plain" },
  async (uri) => ({
    contents: [{
      uri: uri.toString(),
      mimeType: "text/plain",
      text: formatRegistry(loadRegistry()),
    }],
  })
);

server.tool(
  "run_sequence",
  [
    "Execute a sequence of MagicQ operations in a single tool call.",
    "Use this instead of chaining individual tool calls — the entire sequence is planned upfront and executed with correct inter-command delays, eliminating LLM round trips between steps.",
    "",
    "Each step is an object with an \"op\" field plus operation-specific params:",
    "  Programmer: clear_programmer | select_group | select_heads | deselect_all_heads",
    "              include_colour_palette | include_position_palette | include_beam_palette",
    "              set_intensity | set_attribute",
    "              record_cue | record_colour_palette | record_position_palette | record_beam_palette",
    "  Playback:   activate_playback | release_playback | go_playback | stop_playback",
    "              set_playback_level | jump_to_cue | change_page",
    "  Fixture:    locate_heads | lamp_on | lamp_off | reset_heads",
    "  Control:    delay (extra wait in ms) | raw (raw CREP command string)",
    "",
    "The configured inter-command delay (default 75ms) is applied between steps automatically.",
    "Palette registry is updated for record_*_palette steps.",
    "",
    "Example — program a cue using a colour palette:",
    "[{\"op\":\"clear_programmer\"},{\"op\":\"select_group\",\"group\":1},",
    "{\"op\":\"include_colour_palette\",\"palette_id\":3},{\"op\":\"set_intensity\",\"level\":80},",
    "{\"op\":\"record_cue\",\"cue_id\":10},{\"op\":\"clear_programmer\"}]",
  ].join("\n"),
  { steps: z.array(StepSchema).min(1).describe("Ordered list of steps to execute") },
  async ({ steps }) => {
    const log = await executeSequence(steps, config);
    return ok(`Executed ${log.length} step(s):\n${log.map((l, i) => `  ${i + 1}. ${l}`).join("\n")}`);
  }
);

server.tool(
  "send_raw_command",
  "Send a raw CREP command string directly to MagicQ. Use this for commands not covered by other tools.",
  {
    command: z.string().min(1).describe("Raw ASCII CREP command string, e.g. \"1A\" or \"23,10H\""),
  },
  async ({ command }) => {
    await sendCommand(command, config);
    return ok(`Sent: ${command}`);
  }
);

// ── Console feedback ──────────────────────────────────────────────────────────

server.tool(
  "get_feedback",
  [
    "Read what MagicQ has sent back to this server (OSC transmit / CREP tx), e.g. playback fader levels.",
    "Requires MAGICQ_FEEDBACK_PORT on the server and MagicQ Setup → Network → OSC tx port/IP pointed at this machine.",
    "mode 'latest' = last value per OSC address; 'recent' = message log in arrival order.",
  ].join("\n"),
  {
    mode: z.enum(["latest", "recent"]).default("latest"),
    filter: z.string().optional().describe("Only addresses containing this text, e.g. \"/pb\""),
    limit: z.number().int().min(1).max(500).default(50).describe("Max messages for mode 'recent'"),
  },
  async ({ mode, filter, limit }) => {
    const msgs = mode === "latest" ? getLatest(filter) : getRecent(limit, filter);
    const rows = msgs.map((m) => `  ${m.at.slice(11, 23)}  ${m.address}  ${JSON.stringify(m.args)}`);
    return ok([`Feedback ${feedbackStatus()}`, ...(rows.length ? rows : ["  (no messages)"])].join("\n"));
  }
);

// ── OSC ───────────────────────────────────────────────────────────────────────
// Needs MagicQ Setup → Network → OSC mode Rx (or Tx and Rx) with OSC rx port =
// MAGICQ_OSC_PORT. MagicQ PC only handles OSC when unlocked (wing/interface).

const OscArg = z.union([z.number(), z.string(), z.boolean()]);

server.tool(
  "osc_send",
  [
    "Send any OSC message to MagicQ (escape hatch for OSC addresses without a dedicated tool).",
    "Integers are sent as int32, other numbers as float32. Examples: /pb/1 [100], /pb/1/go, /exec/3/201 [1],",
    "/rpc [\"4,1H\"], or a custom address defined in MagicQ's MACRO → VIEW AUTOM window.",
  ].join("\n"),
  {
    address: z.string().regex(/^\//, "must start with /").describe("OSC address, e.g. \"/pb/1/go\""),
    args: z.array(OscArg).default([]).describe("Arguments, e.g. [100], [0.5] or [\"text\"]"),
  },
  async ({ address, args }) => {
    await sendOscMessage(address, args, config);
    return ok(`OSC sent: ${address}${args.length ? " " + JSON.stringify(args) : ""}`);
  }
);

server.tool(
  "osc_playback",
  [
    "Control playbacks via OSC (MagicQ built-in /pb addresses, playbacks 1–10 only).",
    "action: level (value 0–100), go, flash (value 0 = off, else on), pause, release, cue (value = cue id, e.g. 2.5).",
    "Use get_console_state afterwards to read the resulting fader levels.",
  ].join("\n"),
  {
    playbacks: z.array(z.number().int().min(1).max(10)).min(1).describe("Playback numbers 1–10"),
    action: z.enum(["level", "go", "flash", "pause", "release", "cue"]),
    value: z.number().min(0).optional().describe("level 0–100, flash 0/1, or cue id for action 'cue'"),
  },
  async ({ playbacks, action, value }) => {
    if ((action === "level" || action === "cue") && value === undefined) {
      return ok(`action '${action}' needs a value`);
    }
    const sent: string[] = [];
    for (const pb of playbacks) {
      let address = `/pb/${pb}/${action}`;
      let args: OscValue[] = [];
      if (action === "level") {
        address = `/pb/${pb}`;
        args = [Math.round(Math.min(value!, 100))];
      } else if (action === "flash") {
        args = [value === 0 ? 0 : 1];
      } else if (action === "cue") {
        address = `/pb/${pb}/${value}`;
      }
      await sendOscMessage(address, args, config);
      sent.push(`${address}${args.length ? " " + args.join(",") : ""}`);
    }
    return ok(`OSC sent: ${sent.join("  ")}`);
  }
);

server.tool(
  "osc_exec",
  [
    "Control a button, fader or encoder in MagicQ's Execute Window via OSC (/exec/<page>/<item>).",
    "item = box number, grid reference like \"4x3\", or execute item name. page = execute grid 1–10 or name (optional).",
    "value: omit = activate; 0 = release / lower encoder; 1 = activate / raise encoder; 0–100 = fader level.",
    "get_console_state lists the execute addresses MagicQ reports.",
  ].join("\n"),
  {
    item: z.union([z.number().int().min(1), z.string().min(1)]),
    page: z.union([z.number().int().min(1), z.string().min(1)]).optional(),
    value: z.number().int().min(0).max(100).optional(),
  },
  async ({ item, page, value }) => {
    const address = page !== undefined ? `/exec/${page}/${item}` : `/exec/${item}`;
    const args = value !== undefined ? [value] : [];
    await sendOscMessage(address, args, config);
    return ok(`OSC sent: ${address}${args.length ? " " + args[0] : ""}`);
  }
);

server.tool(
  "blackout",
  "Turn MagicQ's DBO (dead blackout) on or off via OSC /dbo.",
  { on: z.boolean().describe("true = blackout on, false = off") },
  async ({ on }) => {
    // MagicQ /dbo: 0 turns blackout on, non-zero turns it off.
    await sendOscMessage("/dbo", [on ? 0 : 1], config);
    return ok(`Blackout ${on ? "ON" : "OFF"} (OSC /dbo ${on ? 0 : 1})`);
  }
);

server.tool(
  "get_console_state",
  [
    "Ask MagicQ (OSC /feedback/...) to transmit the current playback and/or execute states, then report them.",
    "This also turns on MagicQ's continuous feedback, so later get_feedback calls stay current.",
    "Needs MAGICQ_FEEDBACK_PORT = MagicQ's OSC tx port and OSC mode 'Tx and Rx'.",
  ].join("\n"),
  {
    what: z.enum(["pb", "exec", "pb+exec"]).default("pb+exec"),
    wait_ms: z.number().int().min(100).max(5000).default(800).describe("How long to wait for replies"),
  },
  async ({ what, wait_ms }) => {
    if (!isListening()) return ok(`Cannot read state: feedback ${feedbackStatus()}`);
    const since = new Date().toISOString();
    await sendOscMessage(`/feedback/${what}`, [], config);
    await delay(wait_ms);
    const lines: string[] = [];
    if (what !== "exec") {
      const pbs = getLatest("/pb/").filter((m) => /^\/pb\/\d+$/.test(m.address));
      lines.push("Playbacks (fader level):");
      for (const m of pbs) {
        const v = typeof m.args[0] === "number" ? m.args[0] : 0;
        const pct = Math.round(Math.min(Math.max(v, 0), 1) * 100);
        const stale = m.at < since ? "  (no fresh reply)" : "";
        lines.push(`  PB${m.address.slice(4).padEnd(3)}${String(pct).padStart(4)}%${stale}`);
      }
      if (!pbs.length) lines.push("  (no reply)");
    }
    if (what !== "pb") {
      const ex = getLatest("/exec/");
      const active = ex.filter((m) => typeof m.args[0] === "number" && m.args[0] > 0);
      lines.push(`Execute items: ${ex.length} reported, ${active.length} active`);
      for (const m of active) lines.push(`  ${m.address}  ${JSON.stringify(m.args)}`);
      if (ex.length) lines.push(`  range: ${ex[0].address} … ${ex[ex.length - 1].address}`);
    }
    return ok(lines.join("\n"));
  }
);

// ── Web server (read console windows) ────────────────────────────────────────
// Needs MagicQ Setup → Network → Web server Enabled (port MAGICQ_WEB_PORT, 8080).

const webConfig = getWebConfig();
const WindowEnum = z.enum(Object.keys(WINDOWS) as [WindowName, ...WindowName[]]);

server.tool(
  "console_info",
  "Read MagicQ's web server front page: console name, time, software version, IP address and loaded show file.",
  {},
  async () => {
    const w = parseWindow(await fetchPage("index.html", webConfig));
    return ok([w.title, ...w.rows.map((r) => r.filter(Boolean).join(": "))].join("\n"));
  }
);

server.tool(
  "read_window",
  [
    "Read any MagicQ window via the console's web server — real console state, not just what this server sent.",
    "Tables (prog, outputs, patch, cue, cue_stack, palette_view, setup, network, timeline, …) return only non-empty",
    "columns; grid windows (group, colour, position, beam, cue_store, cue_stack_store, playbacks, page, fx, macros,",
    "intensity) return the filled slots. Useful: prog = programmer, outputs = live values per head, patch = head",
    "types/DMX addresses, group = group names + head counts, playbacks = what is on each playback,",
    "cue_stack / cue = the stack/cue currently open on the console.",
    "view switches the window's view (e.g. prog: Levels / Simple Times / FX / Adv Times; group: Groups / Heads) —",
    "this also changes that window's view on the console.",
  ].join("\n"),
  {
    window: WindowEnum,
    filter: z.string().optional().describe("Only rows/cells containing this text, e.g. \"Rivale\" or \"301\""),
    columns: z.array(z.string()).optional().describe("Only these columns (substring match), e.g. [\"Cyan\",\"Magenta\",\"Yellow\"]"),
    view: z.string().optional().describe("View button number or label, e.g. \"2\" or \"Heads\""),
    max_rows: z.number().int().min(1).max(2000).default(200),
  },
  async ({ window, filter, columns, view, max_rows }) => {
    const w = await readWindow(window, webConfig, view);
    return ok(formatWindow(w, { filter, columns, maxRows: max_rows }));
  }
);

server.tool(
  "read_programmer",
  "Read what is in the MagicQ programmer right now (heads and their programmed values, empty columns dropped).",
  {
    filter: z.string().optional().describe("Only rows containing this text, e.g. a head type"),
  },
  async ({ filter }) => {
    const w = await readWindow("prog", webConfig);
    const rows = w.rows.filter((r) => r.some((c) => c));
    if (!rows.length) return ok("Programmer is empty.");
    return ok(formatWindow(w, { filter, maxRows: 500 }));
  }
);

server.tool(
  "web_keypad",
  [
    "Type on MagicQ's web Remote Keypad: enter command-line text, then press a key.",
    "Text uses the keypad syntax: digits, '>' = THRU, '@' = AT, '#' = FULL, '/', '*', '+', '-', '.', 'GP' = group.",
    "Keys: ENTER (execute the text), CL (clear), RC (record), IN (include), UN (update), NH (next head),",
    "HL (highlight), '<' / '>' (previous/next). E.g. text \"1>10@50\" + ENTER = heads 1 thru 10 at 50%.",
    "RC/UN write to the show — only use when the user asked to record/update. Verify with read_programmer.",
  ].join("\n"),
  {
    text: z.string().default("").describe("Command-line text"),
    key: z.enum(KEYPAD_KEYS).default("ENTER"),
  },
  async ({ text, key }) => {
    const status = await keypad(text, key, webConfig);
    return ok(`Keypad: "${text}" ${key}${status ? ` → ${status}` : ""}`);
  }
);

// ── Record onto a playback (OSC → Autom → keyboard macro) ────────────────────
// The remote protocols cannot select a playback. On the console, record a
// keyboard macro (RECORD, then the playback's S button) and add an Autom row:
// Type OSC Message, P1 = /recpb<N>, Function Run macro, F1 = that macro.

const recordAddress = process.env.MAGICQ_RECORD_OSC ?? "/recpb{pb}";

function playbackCell(w: { rows: string[][] }, pb: number): string {
  const re = new RegExp(`^PB${pb}(\\s|$)`);
  return w.rows.flat().find((c) => re.test(c)) ?? `PB${pb}`;
}

server.tool(
  "record_playback",
  [
    "Record the current programmer onto a playback by sending the OSC trigger of a console macro",
    `(default address ${recordAddress.replace("{pb}", "<N>")}, set MAGICQ_RECORD_OSC). Needs, per playback, a MagicQ`,
    "keyboard macro (RECORD + that playback's S button) and an Autom row OSC → Run macro. Build the look first",
    "(apply_look / run_sequence). Verifies via the web server Playbacks window and clears the programmer after.",
    "Only records onto an EMPTY playback: if the playback already holds a cue stack it does nothing.",
  ].join("\n"),
  {
    playback: z.number().int().min(1).max(202),
    clear_after: z.boolean().default(true).describe("Clear the programmer after recording (default true)"),
  },
  async ({ playback, clear_after }) => {
    const prog = await readWindow("prog", webConfig);
    const heads = prog.rows.filter((r) => r.some((c) => c)).length;
    if (!heads) return ok("Programmer is empty — nothing to record. Build a look first.");

    const before = playbackCell(await readWindow("playbacks", webConfig), playback);
    if (before.trim() !== `PB${playback}`) {
      return ok(`PB${playback} already has a cue stack (${before}) — not recording. Only empty playbacks are recorded.`);
    }
    const address = recordAddress.replace("{pb}", String(playback));
    await sendOscMessage(address, [], config);
    await delay(1500);
    const after = playbackCell(await readWindow("playbacks", webConfig), playback);

    const changed = after !== before;
    if (changed && clear_after) await sendCommand("9H", config);
    return ok(
      [
        `Sent OSC ${address} with ${heads} head(s) in the programmer.`,
        `Before: ${before || "(empty)"}   After: ${after || "(empty)"}`,
        changed
          ? `Recorded onto PB${playback}.${clear_after ? " Programmer cleared." : ""}`
          : `PB${playback} did not change — check the Autom row (${address} → Run macro) and the macro on the console` +
            " (read_window macros, view Autom), or a merge prompt on the console. Programmer left as is.",
      ].join("\n")
    );
  }
);

// ── Reference resource ────────────────────────────────────────────────────────

server.tool(
  "attribute_list",
  "Return the full list of MagicQ attribute numbers and their names for use with set_attribute, increment_attribute, etc.",
  {},
  async () => {
    const rows = Object.entries(ATTR)
      .map(([name, num]) => `  ${String(num).padStart(2, " ")}  ${name}`)
      .join("\n");
    return ok(`MagicQ attribute numbers:\n\n${rows}`);
  }
);

// ── Start server ──────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
