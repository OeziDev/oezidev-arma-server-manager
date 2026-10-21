<div align="center">

<img src="packages/app/build/icon.png" width="96" alt="OeziDev Arma Server Manager">

# OeziDev Arma Server Manager

[🇹🇷 Türkçe](README.md) · **🇬🇧 English** · [🇩🇪 Deutsch](README.de.md)

A desktop app to set up, configure, start and monitor Arma 3 dedicated servers from one place.<br>
Runs on Windows and manages both servers on the same computer and remote Linux VPS servers over SSH.

[![Latest release](https://img.shields.io/github/v/release/OeziDev/oezidev-arma-server-manager?label=release&color=e9b44c)](https://github.com/OeziDev/oezidev-arma-server-manager/releases/latest)
![Platform](https://img.shields.io/badge/platform-Windows%2010%20%2F%2011-3c4a3e)
![Servers](https://img.shields.io/badge/servers-Windows%20%7C%20Linux-3c4a3e)
[![Discord](https://img.shields.io/badge/Discord-OeziDev-5865F2?logo=discord&logoColor=white)](https://discord.gg/JNnkdBN5GP)

**[⬇ Download (Windows installer)](https://github.com/OeziDev/oezidev-arma-server-manager/releases/latest)**

<img src="docs/screenshots/genel-bakis.png" alt="Overview: running server, live log and the ports that need to be opened" width="900">

</div>

> The screenshots show the Turkish interface. The app can be switched to English under **Settings → Language**.

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/oyuncular.png" alt="Players"><br><sub><b>Players and RCON</b>: ping, GUID, message, kick, ban, chat feed</sub></td>
    <td width="50%"><img src="docs/screenshots/konsol.png" alt="Console"><br><sub><b>Live console</b>: RPT / journald, filter, warning and error highlighting, RCON commands</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/zorluk.png" alt="Difficulty settings"><br><sub><b>Configuration</b>: server.cfg, basic.cfg and difficulty with Arma 3's real values</sub></td>
    <td><img src="docs/screenshots/modlar.png" alt="Mods"><br><sub><b>Workshop mods</b>: add by link, collection or Launcher preset, download with one click</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/gorevler.png" alt="Missions"><br><sub><b>Mission rotation</b>: MPMissions scan, .pbo upload, difficulty and parameters</sub></td>
    <td><img src="docs/screenshots/makineler.png" alt="Machines"><br><sub><b>Remote Linux VPS</b>: connect over SSH, run the server as a systemd service</sub></td>
  </tr>
</table>

## Features

**Configuration**
- Generates server.cfg, basic.cfg, the Arma3Profile (difficulty) and the BattlEye cfg from one profile. Quotes are escaped correctly; numbers always use a decimal point regardless of system language.
- Difficulty settings with Arma 3's real values: 0/1/2 (off / limited distance / always, including third person "vehicles only").
- `kickClientsOnSlowNetwork[]`, `kickTimeout[]`, `admins[]`, `AdvancedOptions`, mission parameters (`class Params`), mission whitelist.
- "Extra lines" for anything not in the UI: syntax is checked while typing, so a broken config never reaches the server.
- Import an existing server.cfg (including TADST) and Arma3Profile. Unknown lines are kept.
- Live checks: weak passwords, port clashes, `persistent` for `-autoInit`, uppercase mod/mission names on Linux and more.

**Server management**
- Start / stop / restart. Stopping sends `#shutdown` via RCON first (so Altis Life data is saved), then ends the process.
- Automatic restart after a crash, at most N times per hour (no restart loops). Discord notifications.
- On a Linux VPS the server becomes a **systemd service**: a crashed server restarts even while the app is closed, and the server comes back after a VPS reboot. Logs are read from journald.
- Headless clients: enter the count; they start and stop together with the server.
- Scheduled restarts: daily times, RCON countdown messages to players, optional SteamCMD update during the restart.
- When the app is reopened it finds running servers and keeps monitoring them. Processes of other profiles using the same exe are never mixed up.
- Port check before start: if another program (e.g. a server started with TADST) holds the game/RCON ports, the app names it and does not start.

**Performance and tracking**
- Performance panel: server FPS, CPU, RAM, players, AI, groups and vehicles, with charts from 15 minutes to 24 hours. FPS is measured by a small server mod, `@oezi_monitor`, which the app adds itself (no signatures needed, players don't download it).
- Warning when FPS stays low for a long time (optional Discord notification).
- Discord status message: a single message in your channel that keeps itself up to date (status, players, FPS, next restart).
- Player history: who joined and left when, total playtime, names used, notes; ban by GUID/IP on one server or on all servers.
- Scheduled backups: profile, missions, BattlEye, keys, extra folders and a MySQL dump; old backups are deleted automatically.
- Automatic announcements (RCON), start the app with Windows, start a server automatically when the app opens.
- Military-style transitions, start screen and highlight effects (can be turned off under Settings → Animations).

**Console and RCON**
- Live log (RPT on Windows, journald on Linux), filter, error/warning highlighting, RCON command line.
- Player list (ping, GUID), message, kick, ban, ban list, ban by GUID/IP, server lock, chat and join/leave feed.

**Steam**
- Install/update the server with SteamCMD (public, creatordlc, profiling, contact branches).
- Steam Guard: the app asks for the code when needed; after one login SteamCMD remembers it.
- Workshop: add mods by link, ID, **collection** or a mod list exported from the Arma 3 Launcher (.html); download/update with one click, retry on timeout, `@mod` links, `.bikey` keys copied into `keys/` (removing a mod removes only its own keys), lowercase conversion for Linux.

**Security**
- Passwords are encrypted with your Windows account (DPAPI / Electron safeStorage); profile exports never contain passwords.
- The SSH host fingerprint is saved on the first connection; if it changes, the app refuses to connect.
- Commands are run as argument arrays, never via shell string concatenation (paths with spaces and quotes are safe).

## Installation (Windows)

Download `OeziDev-Arma-Server-Manager-Setup-<version>.exe` from the [Releases](https://github.com/OeziDev/oezidev-arma-server-manager/releases) page and run it.
The app is not code-signed, so Windows SmartScreen may show "Unknown publisher": **More info → Run anyway**.

**Automatic updates:** the installed version checks GitHub Releases at startup and every 6 hours, downloads new versions in the background and offers
"Restart and update" (Settings → Updates). Only the app restarts during an update; running Arma servers keep running.
The portable exe does not update itself; it keeps its data in the `OeziArmaManager-data` folder next to the exe.

## First steps

1. **Settings → Steam**: user name/password of a Steam account that owns Arma 3, and the SteamCMD path (or "Download and install SteamCMD").
2. If you use a Linux VPS, **Machines → Add machine**: address, user (root or a sudo user), password or SSH key. "Test connection" shows the fingerprint; save. You can install SteamCMD on the VPS from the same screen.
3. **New server**: choose the machine and the server folder; import your old server.cfg if you have one.
4. **Steam** tab: install/update the server. **Mods** tab: add Workshop mods and "download / update".
5. **Missions**: scan the MPMissions folder or upload a .pbo, add it to the rotation.
6. **Start.** Follow along live in the Console and Players tabs.

Default ports (UDP): game 2302, Steam 2303-2304, BattlEye 2306, RCON 2307 (game port + 5). The Overview tab lists the ports you need to open. Keep the RCON port closed to the internet if possible.

## Good to know

- Windows servers are not managed **remotely** over SSH: install the app on that Windows machine and use it as "This computer". Remote management is for Linux.
- Scheduled restarts and automatic restarts on Windows run while the app is open (closing the window keeps it in the tray). On Linux, systemd restarts a crashed server even when the app is closed.
- The Arma server on Linux expects lowercase mod and mission names; Workshop mods are converted automatically.
- If the server on Linux fails with a "steamclient.so" error, use the "Fix steamclient.so" button in the Steam tab.

## Development

```bash
npm install
npm test                                   # core tests (config, RCON, SSH, process manager, SteamCMD)
npm run build -w packages/app              # UI + main process
npm start -w packages/app                  # run the app
npm run dist:win -w packages/app           # Windows installer + portable exe (needs Wine on Linux)
# New release: bump "version" in packages/app/package.json and push to main → GitHub Actions builds it and publishes a Release,
# installed apps update themselves
xvfb-run -a env E2E=1 npx vitest run packages/app/test/e2e.test.ts   # end-to-end UI test
```

SSH and systemd tests run when a test sshd is found at `127.0.0.1:2222`; otherwise they are skipped.

### Structure

```
packages/core   Pure TypeScript core (independent of Electron; could also back a web panel)
  config/       Arma config writer/reader, file generators, import
  model/        Profile schema (zod) and constants
  launch/       Paths and command line (Windows / POSIX / systemd quoting)
  host/         Local machine and SSH (files, processes, systemd, log tailing)
  rcon/         BattlEye RCon client and output parsers
  supervisor/   Process manager and scheduler
  steam/        SteamCMD and Workshop
packages/app    Electron app
  src/main      Main process: data store, encrypted secrets, IPC
  src/preload   Secure bridge exposed to the UI
  src/renderer  React UI (Turkish / English)
```

## License

Copyright © 2026 OeziDev. All rights reserved. This project contains no code from TADST; it was written from scratch.
Licenses of the open-source components used are in `packages/app/build/licenses/` and in the app's `resources/licenses` folder
(Electron, React, ssh2, zod: MIT; Barlow, Saira Stencil One, IBM Plex Mono fonts: SIL Open Font License 1.1).
