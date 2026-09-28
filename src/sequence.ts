import { z } from "zod";
import { sendCommand, sendCommands, delay, type MagicQConfig } from "./transport.js";
import { upsertPalette, defaultName, resolveId } from "./palette-registry.js";

// Palette / group reference: console number or registry name.
const Ref = z.union([z.number().int().min(1), z.string().min(1)]);

// MagicQ's "All" key (32H) only works within an existing selection, so
// "select everything" is a head range covering the whole show.
export function selectAllCommand(): string {
  return `1,1,${parseInt(process.env.MAGICQ_MAX_HEAD ?? "6145", 10)}H`;
}

// Each step is a discriminated union on `op`. The schema is passed directly to
// the run_sequence tool so the LLM sees the exact shape required per operation.
export const StepSchema = z.discriminatedUnion("op", [
  // ── Programmer ────────────────────────────────────────────────────────────
  z.object({ op: z.literal("clear_programmer") }),
  z.object({ op: z.literal("select_group"),
    group: Ref.describe("Group number or registry name") }),
  z.object({ op: z.literal("select_all_heads") }),
  z.object({ op: z.literal("select_heads"),
    start: z.number().int().min(1).max(6145),
    end: z.number().int().min(1).max(6145).optional() }),
  z.object({ op: z.literal("deselect_all_heads") }),
  z.object({ op: z.literal("include_colour_palette"),
    palette_id: Ref.describe("Palette number or registry name") }),
  z.object({ op: z.literal("include_position_palette"),
    palette_id: Ref.describe("Palette number or registry name") }),
  z.object({ op: z.literal("include_beam_palette"),
    palette_id: Ref.describe("Palette number or registry name") }),
  z.object({ op: z.literal("set_intensity"),
    level: z.number().int().min(0).max(100),
    fade_time: z.number().int().min(0).optional() }),
  z.object({ op: z.literal("set_attribute"),
    attr: z.number().int().min(0).max(51),
    value: z.number().int().min(0).max(65535),
    fade_time: z.number().int().min(0).optional() }),
  z.object({ op: z.literal("record_cue"),
    cue_id: z.number().int().min(1).max(5000) }),
  z.object({ op: z.literal("record_colour_palette"),
    palette_id: z.number().int().min(1).max(1024),
    name: z.string().optional() }),
  z.object({ op: z.literal("record_position_palette"),
    palette_id: z.number().int().min(1).max(1024),
    name: z.string().optional() }),
  z.object({ op: z.literal("record_beam_palette"),
    palette_id: z.number().int().min(1).max(1024),
    name: z.string().optional() }),
  // ── Playback ──────────────────────────────────────────────────────────────
  z.object({ op: z.literal("activate_playback"),
    playback: z.number().int().min(1).max(202),
    level: z.number().int().min(0).max(100).optional() }),
  z.object({ op: z.literal("release_playback"),
    playback: z.number().int().min(1).max(202) }),
  z.object({ op: z.literal("go_playback"),
    playback: z.number().int().min(1).max(202) }),
  z.object({ op: z.literal("stop_playback"),
    playback: z.number().int().min(1).max(202) }),
  z.object({ op: z.literal("set_playback_level"),
    playback: z.number().int().min(1).max(202),
    level: z.number().int().min(0).max(100) }),
  z.object({ op: z.literal("jump_to_cue"),
    playback: z.number().int().min(1).max(202),
    cue_id: z.number().int().min(1).max(65536),
    cue_id_dec: z.number().int().min(0).max(99).default(0) }),
  z.object({ op: z.literal("change_page"),
    page: z.number().int().min(1) }),
  // ── Fixture ───────────────────────────────────────────────────────────────
  z.object({ op: z.literal("locate_heads") }),
  z.object({ op: z.literal("lamp_on") }),
  z.object({ op: z.literal("lamp_off") }),
  z.object({ op: z.literal("reset_heads") }),
  // ── Control ───────────────────────────────────────────────────────────────
  z.object({ op: z.literal("delay"),
    ms: z.number().int().min(0).max(30000).describe("Extra wait in milliseconds before the next step") }),
  z.object({ op: z.literal("raw"),
    command: z.string().min(1).describe("Raw CREP ASCII command string") }),
]);

export type Step = z.infer<typeof StepSchema>;

export async function executeSequence(
  steps: Step[],
  config: MagicQConfig
): Promise<string[]> {
  const log: string[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    switch (step.op) {
      case "clear_programmer":
        await sendCommand("9H", config);
        log.push("clear_programmer");
        break;

      case "select_group": {
        const id = resolveId("group", step.group);
        await sendCommand(`4,${id}H`, config);
        log.push(`select_group(${id})`);
        break;
      }

      case "select_all_heads":
        await sendCommand(selectAllCommand(), config);
        log.push("select_all_heads");
        break;

      case "select_heads": {
        const cmd = step.end !== undefined ? `1,${step.start},${step.end}H` : `1,${step.start}H`;
        await sendCommand(cmd, config);
        log.push(`select_heads(${step.start}${step.end !== undefined ? `–${step.end}` : ""})`);
        break;
      }

      case "deselect_all_heads":
        await sendCommand("3H", config);
        log.push("deselect_all_heads");
        break;

      case "include_colour_palette": {
        const id = resolveId("colour", step.palette_id);
        await sendCommand(`11,${id}H`, config);
        log.push(`include_colour_palette(${id})`);
        break;
      }

      case "include_position_palette": {
        const id = resolveId("position", step.palette_id);
        await sendCommand(`10,${id}H`, config);
        log.push(`include_position_palette(${id})`);
        break;
      }

      case "include_beam_palette": {
        const id = resolveId("beam", step.palette_id);
        await sendCommand(`12,${id}H`, config);
        log.push(`include_beam_palette(${id})`);
        break;
      }

      case "set_intensity": {
        const cmd = step.fade_time !== undefined
          ? `5,${step.level},${step.fade_time}H`
          : `5,${step.level}H`;
        await sendCommand(cmd, config);
        log.push(`set_intensity(${step.level}%${step.fade_time !== undefined ? ` over ${step.fade_time}s` : ""})`);
        break;
      }

      case "set_attribute": {
        const cmd = step.fade_time !== undefined
          ? `6,${step.attr},${step.value},${step.fade_time}H`
          : `6,${step.attr},${step.value}H`;
        await sendCommand(cmd, config);
        log.push(`set_attribute(attr=${step.attr}, value=${step.value})`);
        break;
      }

      case "record_cue":
        await sendCommand(`23,${step.cue_id}H`, config);
        log.push(`record_cue(${step.cue_id})`);
        break;

      case "record_colour_palette": {
        await sendCommand(`21,${step.palette_id}H`, config);
        const name = step.name ?? defaultName("colour", step.palette_id);
        upsertPalette("colour", step.palette_id, name);
        log.push(`record_colour_palette(${step.palette_id}, "${name}")`);
        break;
      }

      case "record_position_palette": {
        await sendCommand(`20,${step.palette_id}H`, config);
        const name = step.name ?? defaultName("position", step.palette_id);
        upsertPalette("position", step.palette_id, name);
        log.push(`record_position_palette(${step.palette_id}, "${name}")`);
        break;
      }

      case "record_beam_palette": {
        await sendCommand(`22,${step.palette_id}H`, config);
        const name = step.name ?? defaultName("beam", step.palette_id);
        upsertPalette("beam", step.palette_id, name);
        log.push(`record_beam_palette(${step.palette_id}, "${name}")`);
        break;
      }

      case "activate_playback":
        if (step.level !== undefined) {
          await sendCommands([`${step.playback}A`, `${step.playback},${step.level}L`], config);
        } else {
          await sendCommand(`${step.playback}A`, config);
        }
        log.push(`activate_playback(${step.playback}${step.level !== undefined ? `, ${step.level}%` : ""})`);
        break;

      case "release_playback":
        await sendCommand(`${step.playback}R`, config);
        log.push(`release_playback(${step.playback})`);
        break;

      case "go_playback":
        await sendCommand(`${step.playback}G`, config);
        log.push(`go_playback(${step.playback})`);
        break;

      case "stop_playback":
        await sendCommand(`${step.playback}S`, config);
        log.push(`stop_playback(${step.playback})`);
        break;

      case "set_playback_level":
        await sendCommand(`${step.playback},${step.level}L`, config);
        log.push(`set_playback_level(${step.playback}, ${step.level}%)`);
        break;

      case "jump_to_cue":
        await sendCommand(`${step.playback},${step.cue_id},${step.cue_id_dec}J`, config);
        log.push(`jump_to_cue(pb=${step.playback}, cue=${step.cue_id}.${String(step.cue_id_dec).padStart(2, "0")})`);
        break;

      case "change_page":
        await sendCommand(`${step.page}P`, config);
        log.push(`change_page(${step.page})`);
        break;

      case "locate_heads":
        await sendCommand("40H", config);
        log.push("locate_heads");
        break;

      case "lamp_on":
        await sendCommand("41H", config);
        log.push("lamp_on");
        break;

      case "lamp_off":
        await sendCommand("42H", config);
        log.push("lamp_off");
        break;

      case "reset_heads":
        await sendCommand("43H", config);
        log.push("reset_heads");
        break;

      case "delay":
        await delay(step.ms);
        log.push(`delay(${step.ms}ms)`);
        break;

      case "raw":
        await sendCommand(step.command, config);
        log.push(`raw("${step.command}")`);
        break;
    }

    // Apply the configured inter-command delay between steps.
    // Skipped for `delay` steps (they manage their own timing) and after the last step.
    if (step.op !== "delay" && i < steps.length - 1) {
      await delay(config.commandDelayMs);
    }
  }

  return log;
}
