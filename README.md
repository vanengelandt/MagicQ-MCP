# MagicQ MCP Server

An MCP (Model Context Protocol) server that lets an AI agent control a ChamSys MagicQ lighting console over the network using the ChamSys Remote Ethernet Protocol (CREP).

## Requirements

- Node.js 18+
- A ChamSys MagicQ console or MagicQ PC/Mac **with a hardware wing attached**

## MagicQ Setup

In MagicQ, configure the following:

| Menu | Setting | Value |
|------|---------|-------|
| Setup → View Settings → Network | Ethernet Remote Protocol | `ChamSys Rem (tx + rx no header)` |
| Setup → View Settings → Network | Playback Sync Port | `6553` |
| Setup → Multi Console | Enable Remote Control | `Yes` |
| Setup → Multi Console | Net Session Mode | `None` |

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
| `MAGICQ_TRANSPORT` | `udp` | `udp`, `tcp` or `osc` (OSC `/rpc` wrapper — needed for MagicQ PC on the same machine) |
| `MAGICQ_CMD_DELAY_MS` | `75` | Delay between chained commands (ms) |
| `MAGICQ_FEEDBACK_PORT` | *(off)* | UDP port to receive MagicQ OSC/CREP transmit on; read it with `get_feedback` |
| `MAGICQ_OSC_PORT` | `8000` | MagicQ OSC rx port, used by the OSC tools (`osc_send`, `osc_playback`, `osc_exec`, `blackout`, `get_console_state`) |
| `MAGICQ_WEB_PORT` | `8080` | MagicQ web server port, used by `console_info`, `read_window`, `read_programmer`, `web_keypad` |
| `MAGICQ_WEB_HOST` | `MAGICQ_IP` | Web server host, if different from `MAGICQ_IP` |
| `MAGICQ_RECORD_OSC` | `/recpb{pb}` | OSC address `record_playback` sends (`{pb}` = playback number); needs a console macro + Autom row per playback |
| `MAGICQ_MAX_HEAD` | `6145` | Upper head number used by `select_all_heads` |

For production use, set `MAGICQ_IP` to the console's actual IP address and consider `MAGICQ_TRANSPORT=tcp` for reliability.

## Running

```bash
# Development
MAGICQ_IP=192.168.1.100 npm run dev

# Production
MAGICQ_IP=192.168.1.100 npm start
```

## Claude Desktop Integration

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "magicq": {
      "command": "node",
      "args": ["/path/to/MagicQ-MCP/dist/index.js"],
      "env": {
        "MAGICQ_IP": "192.168.1.100",
        "MAGICQ_TRANSPORT": "udp"
      }
    }
  }
}
```

## Available Tools

### Playback Control

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

### Direct DMX

| Tool | Description |
|------|-------------|
| `set_channel` | Set a DMX channel intensity directly |

### Programmer

| Tool | Description |
|------|-------------|
| `select_heads` | Select a head or range of heads |
| `deselect_heads` | Deselect a head or range |
| `deselect_all_heads` | Deselect all heads |
| `select_group` | Select a group by number |
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
| `record_cue` | Record programmer as a cue |
| `record_position_palette` | Record as a position palette |
| `record_colour_palette` | Record as a colour palette |
| `record_beam_palette` | Record as a beam palette |
| `next_head` | Cycle to next head |
| `prev_head` | Cycle to previous head |
| `all_heads` | Select all heads |
| `locate_heads` | Locate selected heads |
| `lamp_on` | Lamp on selected heads |
| `lamp_off` | Lamp off selected heads |
| `reset_heads` | Reset selected heads |

### Palette Registry

| Tool / Resource | Description |
|----------------|-------------|
| `list_palettes` | List all registered palettes with IDs and names |
| `declare_palette` | Register a pre-existing console palette by name |
| `import_palettes_csv` | Bulk-import palette names from a CSV file |
| `palettes://registry` | MCP resource — full palette list, readable by Claude |

The server maintains a local `palettes.json` file (gitignored, show-specific). `record_colour_palette`, `record_position_palette`, and `record_beam_palette` all accept an optional `name` parameter and auto-update this registry when a palette is recorded.

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

### High-Level

| Tool | Description |
|------|-------------|
| `program_look` | Build and record a complete look in one call |
| `send_raw_command` | Send a raw CREP command string |
| `attribute_list` | List all attribute numbers |

## Known Limitations

- **No cue stack creation/naming** — stacks must be pre-created on the console
- **No patch management** — fixture patching must be done on the console
- **No stored cue timing** — fade times on recorded cues are not settable remotely
- **PC/Mac only supports PB1–10** without a hardware wing
- The programmer is **shared state** — always `clear_programmer` before and after building a look

## Protocol Reference

- [ChamSys CREP Specification](https://www.mikrocontroller.net/attachment/113173/magicqremoteethernet.pdf)
- [ChamSys Remote Control Commands](https://secure.chamsys.co.uk/docs/magicq/manual/remote_control_commands.html)
