# Branch

Sloths hang from branches, and Branch is the small program that reaches
from Slothbench out to your printers. (It used to be called the printer
bridge; same program, new name.)

Branch shows what your printers are doing inside Slothbench: on the
Printers page (state, progress, time left, temperatures, the spools
loaded) and on the Dashboard, where "At the printers" plans around the
print that is running now.

It runs on a computer on the **same network as your printers** - the shop
PC, a Raspberry Pi, a NAS - because your printers only talk to things on
their own network, and your Slothbench shop may be on a server somewhere
else. Branch reads the printers and sends their status to the app: every
10 seconds while someone has the Printers or Planner page open, every 60
seconds otherwise, and at once when something that matters changes (a
print starts or ends, an error, a spool).

**It reads unless you say otherwise.** Out of the box it never starts,
pauses, stops or changes a print. You can turn on control for a printer -
see [Control from the app](#control-from-the-app-opt-in-per-printer). Printer
passwords (Bambu access codes, Moonraker API keys) stay in Branch's
settings file on that computer; the app never receives them.

**It only calls out.** Branch never listens for connections. It sends
reports to the app and asks the app, every few seconds, whether there is a
command for it.

**You can read every line.** Branch runs on your computer and holds your
printers' access codes, so its code is here in the open: plain JavaScript,
no dependencies, about 1,500 lines. Run the tests with `npm test`.

## What it can read

| Printer | How | What you need |
|---|---|---|
| Bambu Lab (X1, P1, P2S, A1, H2D, H2C...) | The printer's local status feed (MQTT, port 8883) | IP address, serial number, LAN access code |
| Klipper printers (Snapmaker U1, Voron, Creality K, Sovol...) | Moonraker's web API (port 7125) | IP address; an API key only if you turned authorization on |

## Set it up

1. **In Slothbench:** Settings > Integrations > Branch > Generate key.
   Keep the page open; you need the report address and the key.
2. **On the computer next to your printers:** install Node.js 20 or later
   from nodejs.org. Then download Branch: on this page, **Code > Download
   ZIP**, and unzip it into a folder of its own. It is self-contained;
   nothing else to install.
3. In that folder, copy `branch.config.example.json` to
   `branch.config.json` and fill it in:
   - `reportUrl`: the report address from the Settings card
   - `key`: the Branch key from the Settings card
   - `name`: what to call this computer (shown in Settings)
   - `printers`: one entry per printer (below)

   Already have a `bridge.config.json` from before the rename? Branch
   still reads it when there is no `branch.config.json`, so nothing needs
   changing. Rename it to `branch.config.json` whenever you like.
4. Check it: `node slothbench-branch.js --once`. It reads every printer,
   prints what it saw, sends it to the app and stops.
   (`node slothbench-branch.js --help` lists every option.)
5. Run it for real: `node slothbench-branch.js` (or double-click
   `start-branch.cmd` on Windows). Leave it running.
6. **Back in Slothbench:** a printer with the same name as one in
   `branch.config.json` links by itself. Otherwise open the printer
   (Printers > Edit) and pick it under **Live status from**.

### A Bambu Lab printer

```json
{ "name": "H2D", "type": "bambu", "host": "192.168.1.50", "serial": "0948XXXXXXXXXXX", "accessCode": "12345678" }
```

- **IP address:** on the printer's screen under Settings > Network (or
  WLAN). Give the printer a fixed address in your router so it doesn't
  change.
- **Serial number:** Settings > Device on the printer, or in Bambu Studio
  under the printer's details.
- **Access code:** Settings > Network / WLAN on the printer ("LAN Only
  Access Code"). It changes if you turn LAN mode off and on again.

Recent Bambu firmware restricts what other programs may *do* to a printer
on the network, but still lets them *read* its status - so for status and
the camera, normal cloud mode works and you do not need LAN-only or
Developer Mode. (Control does need it; see below.) If a printer refuses the
connection anyway (Branch says "not authorised" with the right access
code), your firmware is stricter: switching the printer to LAN-only mode
with Developer Mode on will let it through, at the cost of the Bambu cloud
and app for that printer. That is Bambu's trade-off, not Branch's.

### A Klipper printer (Snapmaker U1 and others)

```json
{ "name": "Snapmaker U1", "type": "moonraker", "host": "192.168.1.60", "port": 7125 }
```

Add `"apiKey": "..."` only if Moonraker has `[authorization]` turned on
(the U1 does not out of the box). The U1 runs Snapmaker's own build of
Klipper and Moonraker; Branch uses only the standard print status
endpoint.

### Settings per printer

| Setting | Default | What it does |
|---|---|---|
| `allowControl` | `false` | Lets this printer take commands from the app. The app's own switch must be on too. |
| `camera` | `true` | Sends a camera picture while the printer prints. |
| `webcamUrl` | `http://<host>/webcam/?action=snapshot` | Klipper only: the webcam's snapshot address. |

## Camera pictures

While a printer is printing or paused, Branch sends a still picture to the
app: every 30 seconds while someone has the Printers or Planner page open,
every 10 minutes otherwise. Each picture is up to 2 MB. The newest one
shows on the printer card with its time; click it for a bigger view. The
app keeps only the newest picture per printer (in memory and as one file in
the shop's data folder). Only signed-in people can see it.

Reading the camera changes nothing on the printer, so it needs no control
switch. Turn it off with `"camera": false`.

- **Bambu A1 and P1 printers:** the camera stream on port 6000, with the
  access code. Works in normal cloud mode.
- **Bambu X1, H2 and P2S printers** stream their camera another way (RTSP),
  which Branch does not read yet. It tries 3 times, then rests the camera
  for 10 minutes; the app shows no picture.
- **Klipper printers:** the webcam snapshot address (`webcamUrl`, or the
  usual `/webcam/?action=snapshot`).

## Control from the app (opt-in per printer)

With control on, the printer card gets **Pause**, **Resume**, **Stop** (it
asks first) and **Light on / off**. Clicking a spool on a Bambu card lets you
tell the printer what is loaded in that AMS slot, picked from your filament
list. And a product option with a stored print file gets a **Print** button
(see below).

Control needs **two switches**, both off by default:

1. **In the app:** Printers > Edit > **Let the app control this printer**.
   Only an owner or admin can turn it on.
2. **In Branch:** `"allowControl": true` on that printer in
   `branch.config.json`, then restart Branch.

Members can see the buttons' results but cannot send commands. Every
command is written to Settings > Activity.

### The Bambu trade-off: LAN Only Mode with Developer Mode

Current Bambu Lab firmware refuses **every** control command from other
programs - pause, stop, the light, setting a slot, starting a print -
unless the printer is in **LAN Only Mode with Developer Mode** on (on the
printer: Settings > Network / WLAN). That mode **turns off the Bambu cloud
and the Bambu Handy app for that printer**: no remote view in Handy, no
cloud printing from Bambu Studio. That is Bambu's rule, not Slothbench's.

Reading status and the camera work without it. If you turn control on for
a printer that is not in Developer Mode, the printer refuses the first
command; the app says why, and Branch stops offering that kind of command
for 30 minutes.

Klipper printers have no such rule.

### The key

Branch uses its one Branch key for everything: reports, pictures, asking
for commands and answering them. We chose not to add a second "control
key". The key **cannot create a command** - only a signed-in owner or
admin can - so someone who steals it can at worst see what is waiting and
fake an answer. They cannot stop a print. The two switches above are the
guard. Regenerate the key in Settings if it leaks.

### How a command travels

1. You click Pause. The app queues the command (it refuses at once if the
   switch is off, the printer is not reporting, or Branch cannot do it).
2. Branch asks for commands every few seconds (every 2 seconds while one
   is waiting, up to 2 minutes when nothing is happening), runs it, and
   answers done or failed.
3. The app checks every 2 seconds for up to 20 seconds and shows the result.

A command nobody picks up within 2 minutes (a print: 150 seconds) expires.
You can run Branch on more than one computer for the same shop: a command
for a printer one copy does not have is left for the copy that does.
Branch refuses any command type it does not know; there is no G-code
console.

## Print from the app

Upload the sliced file on the product option first (Products > the product
> the option's **Print file**). Then:

- **Products:** the **Print** button next to the print file.
- **Planner:** **Print** on a printer's Next plate, or **Print next plates**
  at the top for every free printer. The plate is marked started once the
  printer starts.

The dialog checks each printer, in this order:

1. Is it online and reporting?
2. Is app control on, and can Branch print on it? (Bambu: needs LAN Only
   Mode with Developer Mode.)
3. The right file for the printer: `.gcode.3mf` for Bambu Lab, `.gcode` for
   Klipper.
4. Is it printing right now?

Then warnings you have to tick before printing: the file was sliced for
another model, several filaments would all come from the outside spool, a
filament's material is not in the slot it maps to, or the color is quite
different.

**AMS slots** are picked for you: for each filament in the file, the first
free slot with the same material and exact color, else the same material,
else any loaded slot. With nothing in an AMS, the outside spool (single
filament files). You can change any of them in the dialog.

**Options:** bed levelling (on), timelapse (off), which plate, and for
several printers, how far apart to start them (at once, 1, 2 or 5 minutes;
at most an hour). Later starts are held by the app, not by Branch.

What Branch does:

- Downloads the file from the app with a link that lasts 15 minutes. It only
  accepts a link on the app's own address (the one in `reportUrl`), over
  https, without redirects, up to 60 MB, and the size and checksum must
  match.
- **Bambu:** copies it to the SD card over FTPS (port 990, user `bblp`, the
  access code) as `slothbench-print.gcode.3mf` (the same name every time,
  so the card does not fill up), starts the chosen plate, and waits up to a
  minute for the printer to start.
- **Klipper:** uploads it to Moonraker and starts it. If Moonraker only
  queues it (the printer was busy), that counts as failed.
- A job gets 12 minutes, or more for a big file (10 minutes plus the file at
  20 KB/s).

When the print starts, the printer's history gets a row; when it ends,
Branch's report fills it in.

## Telegram when a print ends

Settings > Integrations > Branch > **Telegram me when a print finishes or
fails**. Off by default. It uses the family bot (the Telegram card) and
sends to its owner.

## Keep it running

- **Windows:** put a shortcut to `start-branch.cmd` in the Startup folder
  (Win+R, `shell:startup`).
- **Raspberry Pi / Linux:** a systemd service running
  `node /path/to/slothbench-branch/slothbench-branch.js`, with `Restart=always`.
- It reconnects to printers on its own after a printer reboots or drops
  off Wi-Fi, and keeps trying the app if the internet goes away.

## Updating

When a newer Branch is out, Branch says so once in its window, and the
Settings card in Slothbench shows **Update to x.y.z** next to it. To update:

1. Stop Branch (close its window, or stop the service).
2. Download the new one (**Code > Download ZIP** on this page).
3. Unzip it over the old folder, or into a new folder and copy your
   `branch.config.json` across. That file is yours; the download never
   contains one, so it is never overwritten.
4. Start Branch again.

If the app needs a newer Branch than yours, Branch stops sending and its
window says so, with the same download link. What changed in each version
is in [CHANGELOG.md](CHANGELOG.md).

## Troubleshooting

| Branch says | What it means |
|---|---|
| `bad username or password (check the access code)` | The Bambu access code is wrong, or changed |
| `No answer from ... within 10 seconds` | Wrong IP address, printer off, or not on this network |
| `the app refused the Branch key` | The key was regenerated in Settings; copy the new one |
| `Moonraker refused the request (check the API key)` | The Klipper printer has authorization on; add `apiKey` |
| `The printer refused ... Developer Mode` | A Bambu printer not in LAN Only Mode with Developer Mode took a command |
| `no camera picture 3 times` | An X1/H2/P2S camera, or a wrong webcam address; it tries again in 10 minutes |
| `The download address is not on the app's own host` | A print link pointed somewhere else; refused on purpose |

The Settings card lists every copy of Branch and every printer the app has
heard from and when, and which printer in the app each one shows on.

## For developers: the addresses

The addresses keep their original `bridge` names, so copies of Branch from
before the rename keep working. All are under the shop prefix `/s/<shop>/`,
with the Branch key in `X-Api-Key`:

| Address | What |
|---|---|
| `POST /api/bridge/report` | Status, with `bridge: { name, version }`. The reply has `watched`, `pollAfterMs` and `branch: { latest, minimum, download }`. A Branch older than `minimum` gets 426 with an `error` to show. |
| `POST /api/bridge/history` | A print that ended. |
| `POST /api/bridge/snapshot` | A camera picture: `image/jpeg`, up to 2 MB, `X-Printer-Key` header. |
| `GET /api/bridge/commands` | Waiting commands: `{ commands, watched, pollAfterMs }`. Send `X-Bridge-Name`, `X-Bridge-Version`, `X-Bridge-Capabilities`. 426 when the version is under the app's minimum. |
| `POST /api/bridge/commands/:id/ack` | `{ status: running/done/failed, errorMessage }`. 404 means expired or taken by another copy of Branch. |
| `GET /api/bridge/download/:token` | A print file, for a print command only. |

Watching state and the newest pictures are kept in memory per app server
(pictures also on disk). Running several app servers behind one address
would need them shared, or Branch kept talking to one server.

## Licence

Branch is open source under the [MIT licence](LICENSE): use it, change it,
share it.

The licence covers the code, not the name. Only this repository
(github.com/loumoisters/slothbench-branch) is the official Branch. A
changed copy is welcome, but it must not call itself Slothbench or Slothbench
Branch. If you got Branch from anywhere else, download it again from here.
