# MagicQ MCP Server

An MCP (Model Context Protocol) server that lets an AI agent control a ChamSys MagicQ lighting console over the network.

## How it talks to MagicQ

The server uses three independent channels. Each one needs its own setting on the console (see [MagicQ Setup](#magicq-setup)).

| Channel | Port (default) | Direction | Used for |
|---------|----------------|-----------|----------|
| **CREP** — ChamSys Remote Ethernet Protocol | UDP 6553 | send only | Programming: select heads/groups, set attributes and intensity, include/record palettes and cues, playback basics |
| **OSC** | rx 8000 / tx 9000 | send + receive | Playbacks 1–10, execute window, blackout, custom Autom triggers — and **feedback** (fader levels, execute states) |
| **Web server** | TCP 8080 | read (+ keypad) | Reading any MagicQ window: programmer, outputs, patch, groups, playbacks, cue stacks, macros, automations… and typing on the remote keypad |

CREP and OSC are fire-and-forget: a tool result only means the packet was sent. Use the OSC feedback and web-server tools to **verify** what the console actually did.

## Requirements

- Node.js 18+
- A ChamSys MagicQ console, or MagicQ PC/Mac **unlocked with a MagicQ Wing / USB interface** (OSC and Automation only work when unlocked)

## MagicQ Setup

### CREP (programming)

| Menu | Setting | Value |
|------|---------|-------|
| Setup → View Settings → Network | Ethernet Remote Protocol | `ChamSys Rem (tx + rx no header)` |
| Setup → View Settings → Network | Ethernet remote port | `6553` |
| Setup → Multi Console | Enable Remote Control | `Yes` |
| Setup → Multi Console | Net Session Mode | `None` |

**MagicQ PC on the same computer:** MagicQ ignores CREP whose source IP is its own IP. Give MagicQ one IP (e.g. `10.10.10.10`) and send from a second local IP with `MAGICQ_LOCAL_IP`.

### OSC (playbacks, execute, feedback)

| Menu | Setting | Value |
|------|---------|-------|
| Setup → View Settings → Network | OSC mode | `Tx and Rx` |
| Setup → View Settings → Network | OSC rx port | `8000` (= `MAGICQ_OSC_PORT`) |
| Setup → View Settings → Network | OSC tx port | `9000` (= `MAGICQ_FEEDBACK_PORT`) |
| Setup → View Settings → Network | OSC tx IP | `0.0.0.0` (broadcast) or the IP of the machine running this server |

Allow the ports through the firewall. Test on MagicQ with `testosc /pb/1,100` (sets fader 1 to 100%).

### Web server (read windows, keypad)

| Menu | Setting | Value |
|------|---------|-------|
| Setup → View Settings → Network | Web server | `Enabled` |
| Setup → View Settings → Network | Web server port | `8080` (= `MAGICQ_WEB_PORT`) |

Check it in a browser: `http://<magicq-ip>:8080/`.

### Recording onto a playback (macro + automation)

None of the remote protocols can press a playback's **S** (select) button, so "record onto playback N" is not possible directly. The workaround is a **keyboard macro** triggered by an **OSC automation**, set up once per playback on the console:

1. **Macro** — Macro → Record macro, press **RECORD**, then the **S** button of playback N, stop recording. (One macro per playback, e.g. M1 → PB1 … M10 → PB10.)
2. **Automation** — Macro → View Autom, add a row:

   | Type | P1 | Function | F1 |
   |------|----|----------|----|
   | OSC Message | `/recpbN` | Run macro | the macro from step 1 |

3. `record_playback` (playback N) then sends OSC `/recpbN` and checks the Playbacks window to confirm the recording.

> ⚠️ **Recording the macro also executes it.** Pressing RECORD + S while recording the macro records the current programmer onto that playback — on a playback that already has a cue stack this **adds a cue**. Record the macros on empty playbacks, or check the cue stacks afterwards.

> `record_playback` only records onto an **empty** playback. If the playback already holds a cue stack it does nothing (avoids MagicQ's merge/add prompt, which a macro cannot answer). Remove the cue stack from the playback on the console first.

Check the setup remotely with `read_window` → `macros` (view `Macros` lists the macros and step counts, view `Data` shows the key presses of the selected macro, view `Autom` shows the automations).

## Installation

```bash
npm install
npm run build
```

## Configuration

Set environment variables before running:

| Variable | Default | Description |
|----------|---------|-------------|
| `MAGICQ_IP` | `255.255.255.255` | Console IP address (or broadcast) |
| `MAGICQ_PORT` | `6553` | CREP port |
| `MAGICQ_TRANSPORT` | `udp` | `udp`, `tcp` or `osc` (sends CREP wrapped in OSC `/rpc` — then set `MAGICQ_PORT` to the OSC rx port) |
| `MAGICQ_LOCAL_IP` | *(any)* | Local IP to send from (needed when MagicQ PC runs on the same machine) |
| `MAGICQ_CMD_DELAY_MS` | `75` | Delay between chained commands (ms) |
| `MAGICQ_OSC_PORT` | `8000` | MagicQ OSC rx port, used by the OSC tools |
| `MAGICQ_FEEDBACK_PORT` | *(off)* | UDP port this server listens on for MagicQ OSC tx (set to MagicQ's OSC tx port, e.g. `9000`); needed by `get_console_state` / `get_feedback` |
| `MAGICQ_WEB_PORT` | `8080` | MagicQ web server port |
| `MAGICQ_WEB_HOST` | `MAGICQ_IP` | Web server host, if different from `MAGICQ_IP` |
| `MAGICQ_RECORD_OSC` | `/recpb{pb}` | OSC address `record_playback` sends (`{pb}` = playback number) |
| `MAGICQ_PALETTE_REGISTRY` | `palettes.json` | Path of the palette/group name registry |
| `MAGICQ_MAX_HEAD` | `6145` | Upper head number used by `select_all_heads` |

## Running

```bash
# Development
MAGICQ_IP=192.168.1.100 npm run dev

# Production
MAGICQ_IP=192.168.1.100 npm start
```

## Claude Code / Claude Desktop Integration

Add to your MCP config (`claude_desktop_config.json`, or `claude mcp add` / `.mcp.json` for Claude Code):

```json
{
  "mcpServers": {
    "magicq": {
      "command": "node",
      "args": ["/path/to/MagicQ-MCP/dist/index.js"],
      "env": {
        "MAGICQ_IP": "192.168.1.100",
        "MAGICQ_TRANSPORT": "udp",
        "MAGICQ_LOCAL_IP": "192.168.1.50",
        "MAGICQ_FEEDBACK_PORT": "9000",
        "MAGICQ_PALETTE_REGISTRY": "/path/to/MagicQ-MCP/palettes.json"
      }
    }
  }
}
```

## Available Tools

### Live looks & sequences (CREP)

| Tool | Description |
|------|-------------|
| `apply_look` | Put a look live without recording: groups (number or name), `rgb` for the selection only, palettes, intensity. `clear_first: false` layers looks per group |
| `program_look` | Build and record a complete look as a cue in one call |
| `run_sequence` | Run an ordered list of programming / playback steps in one call |

### Playback Control (CREP)

| Tool | Description |
|------|-------------|
| `activate_playback` | Activate a playback, optionally at a set level |
| `release_playback` | Release (deactivate) a playback |
| `go_playback` | Step forward (Go) on a playback |
| `stop_playback` | Stop / go back on a playback |
| `set_playback_level` | Set playback fader level (0–100) |
| `jump_to_cue` | Jump to a specific cue on a playback |
| `change_page` | Change the active playback page |
| `test_playback` | Activate playback at 100% (test) |
| `untest_playback` | Release playback from test mode |

### OSC

| Tool | Description |
|------|-------------|
| `osc_playback` | Level / go / flash / pause / release / jump-to-cue on playbacks 1–10 (several at once) |
| `osc_exec` | Press a button or set a fader/encoder in the Execute window (`/exec/<page>/<item>`) |
| `blackout` | DBO on/off (`/dbo`) |
| `osc_send` | Send any OSC message, e.g. a custom Autom address |
| `get_console_state` | Request `/feedback/pb+exec` and report fader levels (%) and active execute items |
| `get_feedback` | Everything MagicQ has transmitted (latest per address or message log) |

### Reading the console (web server)

| Tool | Description |
|------|-------------|
| `read_programmer` | What is in the programmer now, per head (empty columns dropped) |
| `read_window` | Any of 26 windows — `prog`, `outputs` (live values per head), `patch`, `group`, `playbacks`, `cue_stack_store`, `cue_store`, `colour`/`position`/`beam` palettes, `macros`, `setup`, `network`, … Options: `filter` rows, `columns`, `view` (note: switching the view also switches it on the console) |
| `console_info` | Console name, software version, IP and loaded show file |
| `web_keypad` | Type command-line text and press a key (ENTER, CL, RC, IN, UN, NH, HL, `<`, `>`). Syntax: `>` THRU, `@` AT, `#` FULL — e.g. `1>10@50` ENTER |

### Recording onto a playback

| Tool | Description |
|------|-------------|
| `record_playback` | Record the programmer onto an **empty** playback via its OSC-triggered macro (see [setup](#recording-onto-a-playback-macro--automation)); verifies via the Playbacks window and clears the programmer |

### Direct DMX

| Tool | Description |
|------|-------------|
| `set_channel` | Set a DMX channel intensity directly |

### Programmer (CREP)

| Tool | Description |
|------|-------------|
| `select_heads` | Select a head or range of heads |
| `deselect_heads` | Deselect a head or range |
| `deselect_all_heads` | Deselect all heads |
| `select_group` | Select a group by number |
| `select_all_heads` | Select every head (range 1..`MAGICQ_MAX_HEAD`) |
| `set_intensity` | Set intensity on selected heads |
| `set_attribute` | Set an attribute on selected heads |
| `increment_attribute` | Increment an attribute |
| `decrement_attribute` | Decrement an attribute |
| `clear_programmer` | Clear the programmer buffer |
| `include_cue` | Load a cue into the programmer |
| `include_position_palette` | Include a position palette |
| `include_colour_palette` | Include a colour palette |
| `include_beam_palette` | Include a beam palette |
| `update` | Save programmer back to source |
| `record_cue` | Record programmer as a cue (Cue Store) |
| `record_position_palette` | Record as a position palette |
| `record_colour_palette` | Record as a colour palette |
| `record_beam_palette` | Record as a beam palette |
| `next_head` | Cycle to next head |
| `prev_head` | Cycle to previous head |
| `all_heads` | MagicQ "All" key — only reselects within the current selection |
| `locate_heads` | Locate selected heads |
| `lamp_on` | Lamp on selected heads |
| `lamp_off` | Lamp off selected heads |
| `reset_heads` | Reset selected heads |

### Palette Registry

| Tool / Resource | Description |
|----------------|-------------|
| `list_palettes` | List all registered palettes (and groups) with IDs and names |
| `declare_palette` | Register a pre-existing console palette or group by name |
| `import_palettes_csv` | Bulk-import palette names from a CSV file |
| `palettes://registry` | MCP resource — full palette list, readable by Claude |

The server maintains a local `palettes.json` file (gitignored, show-specific). `record_colour_palette`, `record_position_palette`, and `record_beam_palette` all accept an optional `name` parameter and auto-update this registry when a palette is recorded. Tip: `read_window` → `group` / `colour` / `position` / `beam` shows the names on the console.

#### CSV import format

```csv
# type, id, name
colour, 1, Deep Blue
colour, 2, Red
position, 1, Centre Stage
position, 2, Stage Right
beam, 1, Open White
```

Type aliases accepted: `colour`/`color`/`c`, `position`/`p`, `beam`/`b` (case-insensitive).

### Other

| Tool | Description |
|------|-------------|
| `send_raw_command` | Send a raw CREP command string |
| `attribute_list` | List all attribute numbers |

## Tips & Gotchas

- **Including a colour palette colours every head stored in it**, ignoring the selection. For per-group colour use `apply_look` with `rgb` (attributes 16/17/18 = C/M/Y, 0–255).
- Selecting a group after values were set **replaces** the selection; layer per-group looks with `apply_look` `clear_first: false`. Selecting head **ranges** after values were set **adds** to the selection instead. For a fresh multi-range selection use `web_keypad` (`1>25+51>75` ENTER), then set attributes.
- `all_heads` selects nothing after a clear — use `select_all_heads`.
- Head numbers are MagicQ patch head numbers — prefer groups (`read_window` → `group` lists names and head counts).
- Verify a look with `read_programmer`, or live output with `read_window` `outputs` + `filter` (e.g. a head type).
- Faders don't affect the programmer: a look stays live until `clear_programmer`.

## Known Limitations

- **No playback select** in CREP, OSC or the web keypad — record onto a playback via the [macro + automation](#recording-onto-a-playback-macro--automation) setup
- **No cue stack creation/naming** — stacks must be pre-created on the console
- **No patch management** — fixture patching must be done on the console
- **No stored cue timing** — fade times on recorded cues are not settable remotely
- **No fixture feedback over OSC** — only fader and execute states; use the web server to read values
- **PC/Mac only supports PB1–10** remotely (CREP, OSC and Automation)
- The programmer is **shared state** — always `clear_programmer` before and after building a look

## Protocol Reference

- [ChamSys CREP Specification](https://www.mikrocontroller.net/attachment/113173/magicqremoteethernet.pdf)
- [ChamSys Remote Control Commands](https://docs.chamsys.co.uk/magicq/1.9.9.x/manual/remote_control_commands.html)
- [MagicQ Open Sound Control (OSC)](https://docs.chamsys.co.uk/magicq/1.9.9.x/manual/OSC.html)
- [MagicQ Automation](https://docs.chamsys.co.uk/magicq/1.9.9.x/manual/automation.html)
