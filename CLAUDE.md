# MagicQ MCP Server

This repo is an MCP server for controlling ChamSys MagicQ lighting consoles via the CREP protocol over UDP or TCP.

## Critical Domain Knowledge

### Programmer State — Always Clear Before and After

The MagicQ programmer is a **shared, stateful edit buffer**. It is not scoped to a single operation — values accumulate until explicitly cleared.

Rules:
- **Always `clear_programmer` before starting any programming sequence** — stale values from a previous edit will bleed into the new look
- **Always `clear_programmer` after recording** — leaving values in the programmer causes them to override playback output, making the show look wrong
- The only exception: intentionally layering multiple elements (e.g. include a cue, then add attributes on top) — still clear when done

### Palette-First Programming

Raw attribute values written directly into cues are "hard-coded" and never change. Cues that **reference palettes** automatically update when the palette is updated — this is the professional MagicQ workflow.

**Preferred approach:**
1. Record a colour palette for each colour needed (`record_colour_palette`)
2. Record a position palette for each position needed (`record_position_palette`)
3. Build cues by including those palettes + setting intensity — not by writing raw CMY/pan/tilt values

Only write raw attribute values into a cue when a unique value is needed that doesn't belong in any palette.

### Programming Order (Mandatory)

When building a look, this order is required — MagicQ ignores attributes set before heads are selected:

1. `clear_programmer` — always start clean
2. `select_group` or `select_heads` — **must come before any attribute changes**
3. `include_colour_palette` / `include_position_palette` — if using palette references
4. `set_intensity` — set level on selected heads
5. `set_attribute` — any hard-coded overrides needed beyond palettes
6. `record_cue` — write to cue slot
7. `clear_programmer` — always clean up

Never set attributes before selecting heads. Never skip the trailing clear.

### Head Selection — Prefer Groups

Use `select_group` over `select_heads` whenever the console has groups configured. Groups map to how the operator and designer think about the rig, and are more maintainable. Use `select_heads` with a range only for ad-hoc or one-off selections.

### Playback vs Programmer

Playback commands (`activate_playback`, `go_playback`, `set_playback_level`, etc.) are **independent of the programmer**. They affect live output directly and can be used freely without clearing. The programmer only matters for cue/palette recording.

### Cue Stacks Must Pre-Exist

The remote API cannot create or name cue stacks. Before recording a cue, confirm the target cue stack already exists on the console. Remote programming can only record *into* existing slots.

### PC/Mac Limitation

MagicQ PC/Mac without a hardware wing only supports playbacks 1–10. Full consoles support all 202.

### Command Delay

When sending multiple chained programmer commands, the server automatically inserts a 75ms delay between them (configurable via `MAGICQ_CMD_DELAY_MS`). Don't try to work around this — MagicQ needs time to process each command.

## Palette Registry

The server maintains a local `palettes.json` file that tracks palette names and IDs. This is the source of truth for what palettes exist — always check it before programming.

**At the start of any programming session:**
1. Call `list_palettes` (or read the `palettes://registry` resource) to see what palettes are available
2. Use those IDs and names when building cues — never guess at palette numbers

**Keeping the registry current:**
- `record_colour_palette`, `record_position_palette`, `record_beam_palette` — auto-update the registry when a palette is recorded through this server. Always pass a `name`.
- `declare_palette` — register a palette that already exists on the console (created there directly, not through this server)
- `import_palettes_csv` — bulk-import palette names from a CSV file exported from MagicQ or written manually

**CSV format for import:**
```
# type, id, name
colour, 1, Deep Blue
colour, 2, Red
position, 1, Centre Stage
position, 2, Stage Right
beam, 1, Open White
```

## Tool Selection — Reducing Round Trips

Prefer tools that express the full intent in one call:

| Situation | Use |
|-----------|-----|
| Single cue with optional palettes | `program_look` |
| Multi-step or multi-cue programming | `run_sequence` |
| Single playback action | individual playback tools |
| Multi-playback sequence or show transition | `run_sequence` |
| Anything unusual | `run_sequence` with `raw` steps |

**Do not make individual tool calls for each programmer step** (clear → select → include → intensity → record → clear). That costs 6 LLM round trips. Use `run_sequence` and express the entire plan in one call.

`run_sequence` supports all ops: `clear_programmer`, `select_group`, `select_heads`, `deselect_all_heads`, `include_colour_palette`, `include_position_palette`, `include_beam_palette`, `set_intensity`, `set_attribute`, `record_cue`, `record_colour_palette`, `record_position_palette`, `record_beam_palette`, `activate_playback`, `release_playback`, `go_playback`, `stop_playback`, `set_playback_level`, `jump_to_cue`, `change_page`, `locate_heads`, `lamp_on`, `lamp_off`, `reset_heads`, `delay`, `raw`.

## Tools at a Glance

| Category | Key Tools |
|----------|-----------|
| Playback | `activate_playback`, `release_playback`, `go_playback`, `stop_playback`, `set_playback_level`, `jump_to_cue`, `change_page` |
| Live look (no record) | `apply_look` — groups/palettes by number or registry name |
| Programmer | `select_group`, `select_heads`, `select_all_heads`, `set_intensity`, `set_attribute`, `clear_programmer` |
| Record | `record_cue`, `record_colour_palette`, `record_position_palette`, `record_beam_palette` |
| Include | `include_cue`, `include_colour_palette`, `include_position_palette`, `include_beam_palette` |
| Fixture | `locate_heads`, `lamp_on`, `lamp_off`, `reset_heads` |
| Registry | `list_palettes`, `declare_palette` (also `type: "group"`), `import_palettes_csv` |
| OSC | `osc_playback` (level/go/flash/pause/release/cue, PB1–10), `osc_exec` (execute window), `blackout`, `osc_send` (any address) — to `MAGICQ_OSC_PORT` (8000) |
| Feedback | `get_console_state` (requests `/feedback/pb+exec`, returns fader levels + execute states), `get_feedback` (needs `MAGICQ_FEEDBACK_PORT` + MagicQ OSC tx) |
| Read console (web server) | `read_programmer`, `read_window` (any of 26 windows: prog, outputs, patch, group, playbacks, cue_stack, cue_store, colour, …; `filter`, `columns`, `view`), `console_info` — needs MagicQ Setup → Web server Enabled (`MAGICQ_WEB_PORT`, 8080) |
| Keypad (web server) | `web_keypad` — MagicQ command-line text + key (ENTER/CL/RC/IN/UN/NH/HL/</>), e.g. `1>10@50` ENTER |
| Resource | `palettes://registry` (MCP resource — read at session start) |
| Reference | `attribute_list` (prints all attribute numbers) |
| Escape hatch | `send_raw_command` |

## Gotchas

- `all_heads` (32H) is MagicQ's "All" key: it only re-selects within the current selection, so after `clear_programmer` it selects nothing. Use `select_all_heads` (head range 1..MAGICQ_MAX_HEAD).
- Including a palette (`11,nH` etc.) applies it to every head stored in the palette, ignoring the selection. For per-group colour set attributes on the selection: 16/17/18 = Cyan/Magenta/Yellow, 0–255 (red = 0,255,255) — `apply_look` `rgb` does this.
- Deselect (`3H`, `2,a,bH`) had no visible effect. Not needed: selecting a group (`4,nH`) after setting values replaces the selection, so layer per-group looks with `apply_look` `clear_first: false`.
- MagicQ PC ignores CREP whose source IP is its own. On the same machine give MagicQ its own IP and send from another local IP (`MAGICQ_LOCAL_IP`).
- Head numbers are MagicQ patch head numbers, not visualiser fixture IDs — prefer groups.
- Verify looks with `read_programmer` (what is programmed) or `read_window` `outputs` with `filter` (live values per head). `group` lists group names + head counts; `patch` gives head numbers, types and DMX addresses.
- `read_window` `view` presses that window's view button, which also changes the view on the console.
- `web_keypad` text syntax: `>` THRU, `@` AT, `#` FULL; `1@50` ENTER put head 1 at 50% in the programmer, `CL` cleared it (tested).
- Recording onto a playback remotely did NOT work: `web_keypad` `2/1` + RC, and `2/1` + ENTER, left PB2 empty (the manual's playback/cue + RECORD + ENTER syntax). Workaround (tested 2026-09-28): a keyboard macro recorded on the console (RECORD, then the playback's S button) plus an Autom row (Type OSC Message, P1 `/recpb2`, Function Run macro, F1 M2). Then `osc_send /recpb2` recorded the programmer onto PB2 (it became CS16). Check the macros with `read_window` macros, and the Autom rows with view "Autom".
- Tool results only confirm the packet was sent, not that MagicQ acted on it. Verify on the console, via `get_feedback`, or in the visualiser.
