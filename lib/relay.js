"use strict";

// ---------------------------------------------------------------------------
// ZoneRelay — makes a Roon zone appear as a Spotify Connect speaker.
//
// Architecture per zone:
//   1. Spawn librespot with --backend pipe → registers as Spotify Connect
//      device on LAN; raw S16LE PCM 44100Hz stereo flows to stdout.
//   2. Internal HTTP server (0.0.0.0, all interfaces) receives that PCM
//      and keeps a 6-second rolling buffer so late-connecting Roon clients
//      get caught up immediately on connect.
//   3. Roon AudioInput session: begin_session() binds to the zone.
//      play() is called the moment the FIRST PCM chunk arrives from
//      librespot — not before — so Roon only fetches the stream when
//      audio is actually flowing and won't time-out on an empty feed.
//   4. librespot --onevent fires a shell script that POSTs track metadata
//      to our internal endpoint so we can update Roon's now-playing info.
// ---------------------------------------------------------------------------

const { spawn, execFileSync } = require("child_process");
const http   = require("http");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");
const { EventEmitter } = require("events");

// S16LE 44100 Hz stereo = 176400 bytes/sec.
const BYTES_PER_SEC    = 176400;
const BUFFER_SECS      = 6;
const MAX_BUFFER_BYTES = BYTES_PER_SEC * BUFFER_SECS;

// Return the machine's first non-loopback IPv4 address.
// Override with RELAY_MEDIA_HOST env var if auto-detection picks wrong interface.
function getLocalIP() {
  if (process.env.RELAY_MEDIA_HOST) return process.env.RELAY_MEDIA_HOST;
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "127.0.0.1";
}

// WAV header for a streaming raw-PCM feed (S16LE, 44100 Hz, stereo).
function makeWavHeader() {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(0xFFFFFFFF, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);             // PCM
  h.writeUInt16LE(2, 22);             // stereo
  h.writeUInt32LE(44100, 24);
  h.writeUInt32LE(BYTES_PER_SEC, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(0xFFFFFFFF, 40);
  return h;
}

// Locate the librespot binary.
function findLibrespot() {
  const candidates = [
    process.env.LIBRESPOT_PATH,
    path.join(os.homedir(), ".cargo", "bin", "librespot"),
    "/opt/homebrew/bin/librespot",
    "/usr/local/bin/librespot",
    "/usr/bin/librespot",
    "/var/lib/raspotify/librespot",
    "/usr/bin/raspotify-librespot",
    path.join(__dirname, "..", "bin", "librespot"),
  ].filter(Boolean);

  for (const p of candidates) {
    try { execFileSync(p, ["--version"], { stdio: "ignore", timeout: 3000 }); return p; } catch {}
  }
  try { execFileSync("librespot", ["--version"], { stdio: "ignore", timeout: 3000 }); return "librespot"; } catch {}
  return null;
}

// ---------------------------------------------------------------------------

class ZoneRelay extends EventEmitter {
  constructor(zoneId, zoneName, appPort, debug) {
    super();
    this.zoneId   = zoneId;
    this.zoneName = zoneName;
    this.appPort  = appPort;
    this.debug    = !!debug;

    this.state        = "stopped";
    this.error        = null;
    this.currentTrack = null;

    this._proc          = null;
    this._srv           = null;
    this._port          = null;
    this._localIP       = null;
    this._clients       = new Set();
    this._pcmChunks     = [];         // rolling PCM buffer
    this._pcmBufferSize = 0;
    this._sessionId     = null;
    this._audioinput    = null;
    this._eventScript   = null;
    this._audioStarted  = false;      // true once play() has been called
    this._pendingTrack  = null;       // track info from onevent, held until audio starts
  }

  get mediaUrl() {
    return `http://${this._localIP}:${this._port}/audio`;
  }

  // ── Public ───────────────────────────────────────────────────────────────

  async start(librespotPath, audioinput) {
    if (this.state !== "stopped") return;
    this.state = "starting";
    this.error = null;
    try {
      this._localIP = getLocalIP();
      await this._startAudioServer();
      this._writeEventScript();
      await this._spawnLibrespot(librespotPath);
      await this._beginSession(audioinput);
      this.state = "active";
      this.emit("started");
    } catch (e) {
      this.state = "error";
      this.error = e.message;
      await this._cleanup();
      this.emit("error", e);
    }
  }

  async stop() {
    this.state = "stopped";
    this.error = null;
    await this._cleanup();
    this.emit("stopped");
  }

  // Called when librespot fires an --onevent callback.
  // librespot 0.8.x events: playing, paused, stopped, changed, end_of_track
  handleEvent(evt) {
    this.currentTrack = evt;
    this.emit("event", evt);

    const { event, name, artists, album, track_id, cover_url, position_ms } = evt;
    const isPlayEvent = event === "playing" || event === "start"  ||
                        event === "changed" || event === "change";
    if (!isPlayEvent) return;

    const info = {
      track_id:    track_id     || null,
      name:        name         || "Spotify",
      artists:     artists      || "",
      album:       album        || "",
      cover_url:   cover_url    || null,
      position_ms: parseInt(position_ms, 10) || 0
    };

    if (this._audioStarted) {
      this._callPlay(info);
    } else {
      // Store so _onFirstAudio() uses real track metadata
      this._pendingTrack = info;
    }
  }

  toJSON() {
    return {
      zone_id:       this.zoneId,
      zone_name:     this.zoneName,
      state:         this.state,
      error:         this.error,
      current_track: this.currentTrack,
      media_url:     this._port ? this.mediaUrl : null,
      local_ip:      this._localIP
    };
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _callPlay({ track_id, name, artists, album, cover_url, position_ms }) {
    if (!this._audioinput || !this._sessionId) return;
    this._audioinput.play({
      session_id:       this._sessionId,
      track_id:         track_id || `relay-${Date.now()}`,
      type:             "track",
      slot:             "play",
      media_url:        this.mediaUrl,
      seek_position_ms: position_ms || 0,
      info: {
        one_line:   { line1: [name, artists].filter(Boolean).join(" — ") || "Spotify" },
        two_line:   { line1: name || "Spotify", line2: artists || "" },
        three_line: { line1: name || "Spotify", line2: artists || "", line3: album || "" },
        image_url:        cover_url || null,
        is_seek_allowed:  false,
        is_pause_allowed: true
      }
    }, () => {});
  }

  // Called on the very first PCM chunk from librespot stdout.
  _onFirstAudio() {
    if (this._audioStarted) return;
    this._audioStarted = true;
    const info = this._pendingTrack || {
      track_id:    `relay-${Date.now()}`,
      name:        "Spotify",
      artists:     this.zoneName,
      album:       "",
      cover_url:   null,
      position_ms: 0
    };
    this._pendingTrack = null;
    this._callPlay(info);
    if (this.debug) {
      console.log(`[relay:${this.zoneName}] first PCM received → play() → ${this.mediaUrl}`);
    }
  }

  _startAudioServer() {
    return new Promise((resolve, reject) => {
      this._srv = http.createServer((req, res) => {
        if (!req.url.startsWith("/audio")) { res.writeHead(404); res.end(); return; }
        if (this.debug) {
          console.log(`[relay:${this.zoneName}] Roon connected from ${req.socket.remoteAddress}`);
        }
        res.writeHead(200, {
          "Content-Type":      "audio/wav",
          "Transfer-Encoding": "chunked",
          "Cache-Control":     "no-cache, no-store",
          "Connection":        "keep-alive"
        });
        res.write(makeWavHeader());
        // Flush the rolling buffer so Roon doesn't miss audio already played
        for (const chunk of this._pcmChunks) {
          try { res.write(chunk); } catch {}
        }
        this._clients.add(res);
        req.on("close",   () => this._clients.delete(res));
        req.on("aborted", () => this._clients.delete(res));
      });
      // Listen on all interfaces so Roon Core on a different machine can reach us
      this._srv.listen(0, "0.0.0.0", () => {
        this._port = this._srv.address().port;
        resolve();
      });
      this._srv.once("error", reject);
    });
  }

  _writeEventScript() {
    const tmp = path.join(os.tmpdir(),
      `rra-relay-${this.zoneId.slice(0, 8)}.sh`);
    const zid = this.zoneId.replace(/"/g, "");
    // curl with wget fallback — handles minimal DietPi images without curl
    fs.writeFileSync(tmp,
      `#!/bin/sh\n` +
      `P='{"zone_id":"${zid}","event":"'$PLAYER_EVENT'","track_id":"'$TRACK_ID'",` +
      `"name":"'$NAME'","artists":"'$ARTISTS'","album":"'$ALBUM'",` +
      `"cover_url":"'$COVER_URL'","duration_ms":"'$DURATION_MS'","position_ms":"'$POSITION_MS'"}'\n` +
      `U="http://127.0.0.1:${this.appPort}/internal/relay-event"\n` +
      `if command -v curl >/dev/null 2>&1; then\n` +
      `  curl -s -X POST "$U" -H "Content-Type: application/json" -d "$P" &\n` +
      `elif command -v wget >/dev/null 2>&1; then\n` +
      `  wget -q -O /dev/null --post-data="$P" --header="Content-Type: application/json" "$U" &\n` +
      `fi\n`,
      { mode: 0o755 }
    );
    this._eventScript = tmp;
  }

  _spawnLibrespot(librespotPath) {
    return new Promise((resolve, reject) => {
      const args = [
        "--name",     `Roon: ${this.zoneName}`,
        "--bitrate",  "320",
        "--backend",  "pipe",
        "--initial-volume", "100",
        "--enable-volume-normalisation",
        "--onevent",  this._eventScript,
      ];
      if (this.debug) {
        console.log(`[relay:${this.zoneName}] spawn: ${librespotPath} ${args.join(" ")}`);
      }

      this._proc = spawn(librespotPath, args, { stdio: ["ignore", "pipe", "pipe"] });

      this._proc.stdout.on("data", (chunk) => {
        // Rolling PCM buffer
        this._pcmChunks.push(chunk);
        this._pcmBufferSize += chunk.length;
        while (this._pcmBufferSize > MAX_BUFFER_BYTES) {
          const dropped = this._pcmChunks.shift();
          this._pcmBufferSize -= dropped.length;
        }
        // First data triggers play() on the AudioInput session
        this._onFirstAudio();
        // Live broadcast to connected Roon clients
        for (const c of this._clients) {
          try { c.write(chunk); } catch { this._clients.delete(c); }
        }
      });

      let ready = false;
      this._proc.stderr.on("data", (buf) => {
        const txt = buf.toString();
        if (this.debug) process.stderr.write(`[relay:${this.zoneName}] ${txt}`);
        if (!ready && (
          txt.includes("Registered device")   ||
          txt.includes("registered device")   ||
          txt.includes("Using Zeroconf")       ||
          txt.includes("discovery")            ||
          txt.includes("Listening on")         ||
          txt.includes("Session connected")    ||
          txt.includes("Session::connect")     ||
          txt.includes("librespot v")
        )) {
          ready = true;
          resolve();
        }
      });

      this._proc.on("error", (e) => {
        if (!ready) { ready = true; reject(e); }
        else { this.state = "error"; this.error = e.message; this.emit("error", e); }
      });

      this._proc.on("exit", () => {
        if (!ready) { ready = true; resolve(); }
        for (const c of this._clients) { try { c.end(); } catch {} }
        this._clients.clear();
        if (this.state === "active") {
          this.state = "stopped";
          this.emit("stopped");
        }
      });

      setTimeout(() => { if (!ready) { ready = true; resolve(); } }, 8000);
    });
  }

  _beginSession(audioinput) {
    this._audioinput = audioinput;
    return new Promise((resolve, reject) => {
      audioinput.begin_session({
        zone_id:      this.zoneId,
        display_name: "Spotify",
        icon_url:     "https://storage.googleapis.com/pr-newsroom-wp/1/2018/11/Spotify_Logo_RGB_Green.png"
      }, (msg, body) => {
        if (msg === "SessionBegan") {
          this._sessionId = body.session_id;
          audioinput.update_transport_controls({
            session_id: body.session_id,
            controls:   { is_previous_allowed: false, is_next_allowed: false }
          }, () => {});
          // play() is deferred until first PCM arrives — see _onFirstAudio()
          resolve();
        } else if (msg === "ZoneNotFound") {
          reject(new Error(`Zone not found: ${this.zoneId}`));
        } else if (msg === "SessionEnded" || msg === "ZoneLost") {
          this._sessionId    = null;
          this._audioStarted = false;
          this.state = "stopped";
          this.emit("stopped");
        }
      });
    });
  }

  async _cleanup() {
    if (this._proc) {
      try { this._proc.kill("SIGTERM"); } catch {}
      this._proc = null;
    }
    if (this._srv) {
      this._srv.close();
      this._srv = null;
    }
    if (this._eventScript) {
      try { fs.unlinkSync(this._eventScript); } catch {}
      this._eventScript = null;
    }
    for (const c of this._clients) { try { c.end(); } catch {} }
    this._clients.clear();
    this._pcmChunks     = [];
    this._pcmBufferSize = 0;
    this._audioStarted  = false;
    this._pendingTrack  = null;
    this._sessionId     = null;
    this._audioinput    = null;
    this._port          = null;
    this._localIP       = null;
  }
}

module.exports = { ZoneRelay, findLibrespot };
