<div align="center">

<img src="packages/app/build/icon.png" width="96" alt="OeziDev Arma Server Manager">

# OeziDev Arma Server Manager

[🇹🇷 Türkçe](README.md) · [🇬🇧 English](README.en.md) · **🇩🇪 Deutsch**

Desktop-App, um Arma-3-Dedicated-Server an einem Ort einzurichten, zu konfigurieren, zu starten und zu überwachen.<br>
Läuft unter Windows und verwaltet sowohl Server auf dem eigenen Rechner als auch entfernte Linux-VPS per SSH.

[![Neueste Version](https://img.shields.io/github/v/release/OeziDev/oezidev-arma-server-manager?label=version&color=e9b44c)](https://github.com/OeziDev/oezidev-arma-server-manager/releases/latest)
![Plattform](https://img.shields.io/badge/plattform-Windows%2010%20%2F%2011-3c4a3e)
![Server](https://img.shields.io/badge/server-Windows%20%7C%20Linux-3c4a3e)
[![Discord](https://img.shields.io/badge/Discord-OeziDev-5865F2?logo=discord&logoColor=white)](https://discord.gg/JNnkdBN5GP)

**[⬇ Herunterladen (Windows-Installer)](https://github.com/OeziDev/oezidev-arma-server-manager/releases/latest)**

<img src="docs/screenshots/genel-bakis.png" alt="Übersicht: laufender Server, Live-Log und freizugebende Ports" width="900">

</div>

> Die Screenshots zeigen die türkische Oberfläche. Die App selbst ist auf Türkisch und Englisch verfügbar (**Einstellungen → Sprache**).

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/oyuncular.png" alt="Spieler"><br><sub><b>Spieler und RCON</b>: Ping, GUID, Nachricht, Kick, Bann, Chat-Verlauf</sub></td>
    <td width="50%"><img src="docs/screenshots/konsol.png" alt="Konsole"><br><sub><b>Live-Konsole</b>: RPT / journald, Filter, Hervorhebung von Warnungen und Fehlern, RCON-Befehle</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/zorluk.png" alt="Schwierigkeit"><br><sub><b>Konfiguration</b>: server.cfg, basic.cfg und Schwierigkeit mit den echten Arma-3-Werten</sub></td>
    <td><img src="docs/screenshots/modlar.png" alt="Mods"><br><sub><b>Workshop-Mods</b>: per Link, Kollektion oder Launcher-Preset hinzufügen, mit einem Klick herunterladen</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/gorevler.png" alt="Missionen"><br><sub><b>Missionsrotation</b>: MPMissions durchsuchen, .pbo hochladen, Schwierigkeit und Parameter</sub></td>
    <td><img src="docs/screenshots/makineler.png" alt="Maschinen"><br><sub><b>Entfernter Linux-VPS</b>: per SSH verbinden, Server als systemd-Dienst betreiben</sub></td>
  </tr>
</table>

## Funktionen

**Konfiguration**
- Erzeugt server.cfg, basic.cfg, das Arma3Profile (Schwierigkeit) und die BattlEye-cfg aus einem Profil. Anführungszeichen werden korrekt maskiert; Zahlen werden unabhängig von der Systemsprache immer mit Dezimalpunkt geschrieben.
- Schwierigkeitseinstellungen mit den echten Arma-3-Werten: 0/1/2 (aus / begrenzte Distanz / immer, inklusive Third Person „nur Fahrzeuge").
- `kickClientsOnSlowNetwork[]`, `kickTimeout[]`, `admins[]`, `AdvancedOptions`, Missionsparameter (`class Params`), Missions-Whitelist.
- „Zusätzliche Zeilen" für alles, was nicht in der Oberfläche ist: Die Syntax wird schon beim Tippen geprüft, eine kaputte Config erreicht nie den Server.
- Import einer vorhandenen server.cfg (auch von TADST) und eines Arma3Profile. Unbekannte Zeilen bleiben erhalten.
- Live-Prüfungen: schwache Passwörter, Portkonflikte, `persistent` für `-autoInit`, Großbuchstaben in Mod-/Missionsnamen unter Linux und mehr.

**Serververwaltung**
- Starten / Stoppen / Neustarten. Beim Stoppen wird zuerst `#shutdown` per RCON gesendet (damit Altis-Life-Daten gespeichert werden), danach wird der Prozess beendet.
- Automatischer Neustart nach einem Absturz, höchstens N-mal pro Stunde (keine Neustartschleifen). Discord-Benachrichtigungen.
- Auf einem Linux-VPS wird der Server ein **systemd-Dienst**: Ein abgestürzter Server startet neu, auch wenn die App geschlossen ist, und nach einem VPS-Neustart läuft der Server wieder. Logs werden aus journald gelesen.
- Headless Clients: Anzahl eingeben, sie starten und stoppen zusammen mit dem Server.
- Geplante Neustarts: tägliche Uhrzeiten, Countdown-Nachrichten an die Spieler per RCON, optional Update per SteamCMD während des Neustarts.
- Nach dem erneuten Öffnen findet die App laufende Server und überwacht sie weiter. Prozesse anderer Profile mit derselben exe werden nie verwechselt.
- Portprüfung vor dem Start: Belegt ein anderes Programm (z. B. ein mit TADST gestarteter Server) die Spiel-/RCON-Ports, nennt die App es und startet nicht.

**Leistung und Überwachung**
- Leistungsanzeige: Server-FPS, CPU, RAM, Spieler, KI, Gruppen und Fahrzeuge, mit Diagrammen von 15 Minuten bis 24 Stunden. Die FPS misst ein kleiner Server-Mod `@oezi_monitor`, den die App selbst hinzufügt (keine Signaturen nötig, Spieler laden ihn nicht herunter).
- Warnung, wenn die FPS längere Zeit niedrig bleiben (optional als Discord-Benachrichtigung).
- Discord-Statusnachricht: eine einzige Nachricht im Kanal, die sich selbst aktualisiert (Status, Spieler, FPS, nächster Neustart).
- Spielerverlauf: wer wann beigetreten und gegangen ist, Gesamtspielzeit, verwendete Namen, Notizen; Bann per GUID/IP auf einem oder allen Servern.
- Geplante Backups: Profil, Missionen, BattlEye, Schlüssel, zusätzliche Ordner und ein MySQL-Dump; alte Backups werden automatisch gelöscht.
- Automatische Ankündigungen (RCON), App mit Windows starten, Server beim Öffnen der App automatisch starten.
- Übergänge, Startbildschirm und Hervorhebungseffekte im Militär-Stil (abschaltbar unter Einstellungen → Animationen).

**Konsole und RCON**
- Live-Log (RPT unter Windows, journald unter Linux), Filter, Hervorhebung von Fehlern/Warnungen, RCON-Befehlszeile.
- Spielerliste (Ping, GUID), Nachricht, Kick, Bann, Bannliste, Bann per GUID/IP, Server sperren, Chat- und Beitritts-/Austrittsverlauf.

**Steam**
- Server per SteamCMD installieren/aktualisieren (Branches public, creatordlc, profiling, contact).
- Steam Guard: Die App fragt bei Bedarf nach dem Code; nach einer Anmeldung merkt sich SteamCMD die Zugangsdaten.
- Workshop: Mods per Link, ID, **Kollektion** oder aus dem Arma-3-Launcher exportierter Modliste (.html) hinzufügen; mit einem Klick herunterladen/aktualisieren, Wiederholung bei Zeitüberschreitung, `@mod`-Verknüpfungen, `.bikey`-Schlüssel werden nach `keys/` kopiert (beim Entfernen eines Mods werden nur dessen Schlüssel gelöscht), Kleinschreibung für Linux.

**Sicherheit**
- Passwörter werden mit deinem Windows-Konto verschlüsselt (DPAPI / Electron safeStorage); Profilexporte enthalten nie Passwörter.
- Der SSH-Fingerabdruck des Servers wird bei der ersten Verbindung gespeichert; ändert er sich, verbindet die App nicht.
- Befehle werden als Argumentlisten ausgeführt, nie über zusammengesetzte Shell-Befehle (Pfade mit Leerzeichen und Anführungszeichen sind sicher).

## Installation (Windows)

Lade `OeziDev-Arma-Server-Manager-Setup-<Version>.exe` von der [Releases](https://github.com/OeziDev/oezidev-arma-server-manager/releases)-Seite herunter und führe sie aus.
Die App ist nicht signiert, daher zeigt Windows SmartScreen eventuell „Unbekannter Herausgeber" an: **Weitere Informationen → Trotzdem ausführen**.

**Automatische Updates:** Die installierte Version prüft beim Start und alle 6 Stunden GitHub Releases, lädt neue Versionen im Hintergrund herunter und bietet
„Neu starten und aktualisieren" an (Einstellungen → Updates). Beim Update startet nur die App neu; laufende Arma-Server laufen weiter.
Die portable exe aktualisiert sich nicht selbst; sie speichert ihre Daten im Ordner `OeziArmaManager-data` neben der exe.

## Erste Schritte

1. **Einstellungen → Steam**: Benutzername/Passwort eines Steam-Kontos, das Arma 3 besitzt, und der SteamCMD-Pfad (oder „SteamCMD herunterladen und installieren").
2. Wenn du einen Linux-VPS nutzt, **Maschinen → Maschine hinzufügen**: Adresse, Benutzer (root oder ein sudo-Benutzer), Passwort oder SSH-Schlüssel. „Verbindung testen" zeigt den Fingerabdruck; speichern. Im selben Fenster kannst du SteamCMD auf dem VPS installieren.
3. **Neuer Server**: Maschine und Serverordner wählen; eine alte server.cfg kannst du importieren.
4. Tab **Steam**: Server installieren/aktualisieren. Tab **Mods**: Workshop-Mods hinzufügen und „herunterladen / aktualisieren".
5. **Missionen**: MPMissions-Ordner durchsuchen oder eine .pbo hochladen, zur Rotation hinzufügen.
6. **Starten.** In den Tabs Konsole und Spieler live verfolgen.

Standardports (UDP): Spiel 2302, Steam 2303-2304, BattlEye 2306, RCON 2307 (Spielport + 5). Der Tab Übersicht listet die Ports, die du freigeben musst. Den RCON-Port nach Möglichkeit nicht ins Internet öffnen.

## Gut zu wissen

- Windows-Server werden nicht **aus der Ferne** per SSH verwaltet: Installiere die App auf dem Windows-Rechner und nutze ihn als „Dieser Computer". Die Fernverwaltung ist für Linux gedacht.
- Geplante Neustarts und automatische Neustarts unter Windows laufen, solange die App geöffnet ist (beim Schließen des Fensters bleibt sie im Infobereich). Unter Linux startet systemd einen abgestürzten Server neu, auch wenn die App geschlossen ist.
- Der Arma-Server unter Linux erwartet Mod- und Missionsnamen in Kleinbuchstaben; Workshop-Mods werden automatisch umgewandelt.
- Startet der Server unter Linux mit einem „steamclient.so"-Fehler nicht, nutze im Tab Steam den Button „steamclient.so reparieren".

## Entwicklung

```bash
npm install
npm test                                   # Core-Tests (Config, RCON, SSH, Prozessverwaltung, SteamCMD)
npm run build -w packages/app              # Oberfläche + Hauptprozess
npm start -w packages/app                  # App starten
npm run dist:win -w packages/app           # Windows-Installer + portable exe (unter Linux wird Wine benötigt)
# Neue Version: "version" in packages/app/package.json erhöhen und auf main pushen → GitHub Actions baut und veröffentlicht ein Release,
# installierte Apps aktualisieren sich selbst
xvfb-run -a env E2E=1 npx vitest run packages/app/test/e2e.test.ts   # End-to-End-Test der Oberfläche
```

SSH- und systemd-Tests laufen, wenn unter `127.0.0.1:2222` ein Test-sshd erreichbar ist; sonst werden sie übersprungen.

### Aufbau

```
packages/core   Reiner TypeScript-Kern (unabhängig von Electron; auch für ein Webpanel nutzbar)
  config/       Arma-Config-Schreiber/-Leser, Dateigeneratoren, Import
  model/        Profilschema (zod) und Konstanten
  launch/       Pfade und Befehlszeile (Quoting für Windows / POSIX / systemd)
  host/         Lokaler Rechner und SSH (Dateien, Prozesse, systemd, Log-Verfolgung)
  rcon/         BattlEye-RCon-Client und Ausgabe-Parser
  supervisor/   Prozessverwaltung und Zeitplaner
  steam/        SteamCMD und Workshop
packages/app    Electron-App
  src/main      Hauptprozess: Datenspeicher, verschlüsselte Geheimnisse, IPC
  src/preload   Sichere Brücke zur Oberfläche
  src/renderer  React-Oberfläche (Türkisch / Englisch)
```

## Lizenz

Copyright © 2026 OeziDev. Alle Rechte vorbehalten. Dieses Projekt enthält keinen Code aus TADST; es wurde von Grund auf neu geschrieben.
Die Lizenzen der verwendeten Open-Source-Komponenten liegen in `packages/app/build/licenses/` und im Ordner `resources/licenses` der App
(Electron, React, ssh2, zod: MIT; Schriftarten Barlow, Saira Stencil One, IBM Plex Mono: SIL Open Font License 1.1).
