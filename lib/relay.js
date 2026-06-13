"use strict";

// ---------------------------------------------------------------------------
// ZoneRelay — makes a Roon zone appear as a Spotify Connect speaker.
//
// Architecture per zone:
//   1. Spawn librespot with --backend pipe → registers as Spotify Connect
//      device on LAN; raw S16LE PCM 44100Hz stereo flows to stdout.
//   2. Audio is served through the MAIN Express app (same port 3399) via
//      GET /relay/audio/:zoneId — no separate HTTP server, no random port.
//      A 6-second rolling PCM buffer lets late-connecting Roon catch up.
//   3. Roon AudioInput session: begin_session() binds to the zone.
//      play() fires the moment the first PCM chunk arrives from librespot
//      so Roon only fetches the stream when audio is actually flowing.
//   4. librespot --onevent POSTs track metadata back to the main app so
//      Roon's now-playing info stays current.
// ---------------------------------------------------------------------------

const { spawn, execFileSync } = require("child_process");
const fs   = require("fs");
const os   = require("os");
const path = require("path");
const { EventEmitter } = require("events");

const BYTES_PER_SEC    = 176400;           // S16LE 44100 Hz stereo
const MAX_BUFFER_BYTES = BYTES_PER_SEC * 6; // 6-second rolling buffer

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
    this.appPort  = appPort;   // main app port (3399) — used in media_url
    this.debug    = !!debug;

    this.state        = "stopped";
    this.error        = null;
    this.currentTrack = null;

    this._proc          = null;
    this._localIP       = null;
    this._clients       = new Set();   // active streaming HTTP responses
    this._pcmChunks     = [];
    this._pcmBufferSize = 0;
    this._sessionId     = null;
    this._audioinput    = null;
    this._eventScript   = null;
    this._audioStarted  = false;
    this._pendingTrack  = null;

    // Diagnostics
    this.bytesReceived  = 0;
    this.clientsEver    = 0;
  }

  // Audio is served via the MAIN app — same host:port as the web UI.
  get mediaUrl() {
    return `http://${this._localIP}:${this.appPort}/relay/audio/${this.zoneId}`;
  }

  // ── Public ───────────────────────────────────────────────────────────────

  async start(librespotPath, audioinput) {
    if (this.state !== "stopped") return;
    this.state = "starting";
    this.error = null;
    this._localIP = getLocalIP();
    try {
      this._writeEventScript();
      await this._spawnLibrespot(librespotPath);
      await this._beginSession(audioinput);
      this.state = "active";
      console.log(`[relay:${this.zoneName}] active — Roon will pull from ${this.mediaUrl}`);
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

  // Called by Express GET /relay/audio/:zoneId
  streamToClient(req, res) {
    this.clientsEver++;
    console.log(`[relay:${this.zoneName}] Roon connected to audio stream (client #${this.clientsEver}, from ${req.socket.remoteAddress})`);

    res.writeHead(200, {
      "Content-Type":      "audio/wav",
      "Transfer-Encoding": "chunked",
      "Cache-Control":     "no-cache, no-store",
      "Connection":        "keep-alive",
      "X-Relay-Zone":      this.zoneName
    });
    res.write(makeWavHeader());

    // Replay buffer so Roon doesn't miss the start of the track
    for (const chunk of this._pcmChunks) {
      try { res.write(chunk); } catch {}
    }
    console.log(`[relay:${this.zoneName}] sent WAV header + ${Math.round(this._pcmBufferSize / BYTES_PER_SEC * 1000)}ms of buffered audio`);

    this._clients.add(res);
    const cleanup = () => this._clients.delete(res);
    req.on("close",   cleanup);
    req.on("aborted", cleanup);
    res.on("error",   cleanup);
  }

  // Called when librespot fires --onevent
  handleEvent(evt) {
    this.currentTrack = evt;
    this.emit("event", evt);
    const { event, name, artists, album, track_id, cover_url, position_ms } = evt;
    console.log(`[relay:${this.zoneName}] librespot event: ${event} — ${name || "?"}`);

    const isPlay = event === "playing" || event === "start" ||
                   event === "changed" || event === "change";
    if (!isPlay) return;

    const info = {
      track_id, name: name || "Spotify", artists: artists || "",
      album: album || "", cover_url: cover_url || null,
      position_ms: parseInt(position_ms, 10) || 0
    };

    if (this._audioStarted) {
      this._callPlay(info);
    } else {
      this._pendingTrack = info;
    }
  }

  toJSON() {
    return {
      zone_id:        this.zoneId,
      zone_name:      this.zoneName,
      state:          this.state,
      error:          this.error,
      current_track:  this.currentTrack,
      media_url:      this._localIP ? this.mediaUrl : null,
      local_ip:       this._localIP,
      bytes_received: this.bytesReceived,
      clients_ever:   this.clientsEver,
      active_clients: this._clients.size
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

  _onFirstAudio() {
    if (this._audioStarted) return;
    this._audioStarted = true;
    const info = this._pendingTrack || {
      track_id: `relay-${Date.now()}`, name: "Spotify",
      artists: this.zoneName, album: "", cover_url: null, position_ms: 0
    };
    this._pendingTrack = null;
    this._callPlay(info);
    console.log(`[relay:${this.zoneName}] first PCM arrived — play() sent, url=${this.mediaUrl}`);
  }

  _writeEventScript() {
    const tmp = path.join(os.tmpdir(), `rra-relay-${this.zoneId.slice(0, 8)}.sh`);
    const zid = this.zoneId.replace(/"/g, "");
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
      console.log(`[relay:${this.zoneName}] spawning librespot: ${librespotPath} ${args.join(" ")}`);

      this._proc = spawn(librespotPath, args, { stdio: ["ignore", "pipe", "pipe"] });

      this._proc.stdout.on("data", (chunk) => {
        this.bytesReceived += chunk.length;
        // Rolling buffer
        this._pcmChunks.push(chunk);
        this._pcmBufferSize += chunk.length;
        while (this._pcmBufferSize > MAX_BUFFER_BYTES) {
          const d = this._pcmChunks.shift();
          this._pcmBufferSize -= d.length;
        }
        // First audio chunk → tell Roon to start pulling
        this._onFirstAudio();
        // Broadcast to connected clients
        for (const c of this._clients) {
          try { c.write(chunk); } catch { this._clients.delete(c); }
        }
      });

      let ready = false;
      this._proc.stderr.on("data", (buf) => {
        const txt = buf.toString().trim();
        // Always log librespot output so the user can see it when debugging
        if (txt) console.log(`[librespot:${this.zoneName}] ${txt}`);
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
        console.error(`[relay:${this.zoneName}] librespot error: ${e.message}`);
        if (!ready) { ready = true; reject(e); }
        else { this.state = "error"; this.error = e.message; this.emit("error", e); }
      });

      this._proc.on("exit", (code, signal) => {
        console.log(`[relay:${this.zoneName}] librespot exited code=${code} signal=${signal}`);
        if (!ready) { ready = true; resolve(); }
        for (const c of this._clients) { try { c.end(); } catch {} }
        this._clients.clear();
        if (this.state === "active") {
          this.state = "stopped";
          this.emit("stopped");
        }
      });

      setTimeout(() => {
        if (!ready) {
          console.log(`[relay:${this.zoneName}] librespot startup timeout — continuing anyway`);
          ready = true;
          resolve();
        }
      }, 8000);
    });
  }

  _beginSession(audioinput) {
    this._audioinput = audioinput;
    return new Promise((resolve, reject) => {
      console.log(`[relay:${this.zoneName}] calling begin_session for zone ${this.zoneId}`);
      audioinput.begin_session({
        zone_id:      this.zoneId,
        display_name: "Spotify",
        icon_url:     "https://storage.googleapis.com/pr-newsroom-wp/1/2018/11/Spotify_Logo_RGB_Green.png"
      }, (msg, body) => {
        console.log(`[relay:${this.zoneName}] AudioInput callback: ${msg}`, body || "");
        if (msg === "SessionBegan") {
          this._sessionId = body.session_id;
          audioinput.update_transport_controls({
            session_id: body.session_id,
            controls:   { is_previous_allowed: false, is_next_allowed: false }
          }, () => {});
          resolve();
        } else if (msg === "ZoneNotFound") {
          reject(new Error(`Zone not found: ${this.zoneId}`));
        } else if (msg === "SessionEnded" || msg === "ZoneLost") {
          console.log(`[relay:${this.zoneName}] session ended: ${msg}`);
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
    this.bytesReceived  = 0;
    this.clientsEver    = 0;
  }
}

module.exports = { ZoneRelay, findLibrespot };
