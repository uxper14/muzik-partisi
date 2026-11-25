const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname)));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const rooms = new Map();
const MAX_PLAYERS = 8;

const CHALLENGE_INSTRUMENTS = [
  "acoustic_grand_piano",
  "electric_piano_1",
  "music_box",
  "violin",
  "cello",
  "acoustic_guitar_nylon",
  "electric_guitar_clean",
  "flute",
  "clarinet",
  "trumpet",
  "vibraphone",
  "marimba"
];

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = "";
    for (let i = 0; i < 5; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(code));
  return code;
}

function generateChallenge() {
  const scales = [
    [60, 62, 64, 65, 67, 69, 71, 72],
    [60, 62, 63, 65, 67, 68, 70, 72],
    [62, 64, 66, 67, 69, 71, 73, 74],
    [64, 66, 67, 69, 71, 72, 74, 76],
    [67, 69, 71, 72, 74, 76, 78, 79]
  ];
  const scale = scales[Math.floor(Math.random() * scales.length)];
  const length = 4;
  const sequence = [];

  for (let i = 0; i < length; i++) {
    const note = scale[Math.floor(Math.random() * scale.length)];
    sequence.push([note]);
  }

  const instrument = CHALLENGE_INSTRUMENTS[Math.floor(Math.random() * CHALLENGE_INSTRUMENTS.length)];
  const tempo = [0.45, 0.55, 0.65][Math.floor(Math.random() * 3)];

  return { instrument, tempo, sequence };
}

function calculateSimilarity(target, submission) {
  if (!target || !submission || !Array.isArray(submission.sequence)) return 0;

  const targetSeq = target.sequence;
  const userSeq = submission.sequence;
  const steps = targetSeq.length;
  let noteScoreTotal = 0;

  for (let i = 0; i < steps; i++) {
    const tNotes = targetSeq[i] || [];
    const uNotes = userSeq[i] || [];
    if (uNotes.length === 0 || tNotes.length === 0) continue;

    const tMidi = tNotes[0];
    let bestStepScore = 0;

    for (const uMidi of uNotes) {
      const diff = Math.abs(tMidi - uMidi);
      let score = 0;
      if (diff === 0) score = 100;
      else if (diff === 12) score = 80;
      else if (diff === 1) score = 65;
      else if (diff === 2) score = 45;
      else if (diff <= 4) score = 20;
      else score = 5;
      if (score > bestStepScore) bestStepScore = score;
    }

    const extraPenalty = Math.max(0, (uNotes.length - tNotes.length) * 10);
    noteScoreTotal += Math.max(0, bestStepScore - extraPenalty);
  }

  const melodyPart = (noteScoreTotal / steps) * 0.85;
  const instrumentBonus = submission.instrument === target.instrument ? 15 : 0;
  return Math.min(100, Math.round(melodyPart + instrumentBonus));
}

function publicRoom(room) {
  return {
    code: room.code,
    mode: room.mode,
    solo: room.solo,
    host: room.host,
    started: room.started,
    currentTurn: room.currentTurn,
    beat: room.beat,
    players: room.players.map(p => ({ id: p.id, name: p.name })),
    actions: room.actions,
    challenge: room.challenge
      ? {
          instrument: room.challenge.instrument,
          tempo: room.challenge.tempo,
          sequence: room.challenge.sequence,
          submissions: room.challenge.submissions.map(s => ({
            playerId: s.playerId,
            playerName: s.playerName,
            instrument: s.instrument,
            sequence: s.sequence,
            score: s.score
          })),
          revealed: room.challenge.revealed
        }
      : null
  };
}

function sendRoom(room) {
  io.to(room.code).emit("room-state", publicRoom(room));
}

function getRoom(socket, code) {
  const room = rooms.get(String(code || "").toUpperCase());
  if (!room || !room.players.some(p => p.id === socket.id)) return null;
  return room;
}

function removePlayer(socket) {
  for (const [code, room] of rooms) {
    const index = room.players.findIndex(p => p.id === socket.id);
    if (index === -1) continue;

    room.players.splice(index, 1);

    if (room.players.length === 0) {
      rooms.delete(code);
      return;
    }

    if (room.host === socket.id) {
      room.host = room.players[0].id;
    }

    if (room.currentTurn >= room.players.length) {
      room.currentTurn = 0;
    }

    sendRoom(room);
    return;
  }
}

io.on("connection", socket => {
  socket.on("create-room", (data, callback) => {
    const name = String(data?.name || "Oyuncu").trim().slice(0, 18);
    const allowedModes = ["party", "free", "mimic"];
    const mode = allowedModes.includes(data?.mode) ? data.mode : "party";
    const solo = Boolean(data?.solo);
    const code = makeCode();

    const room = {
      code,
      mode,
      solo,
      host: socket.id,
      started: solo,
      currentTurn: 0,
      beat: "none",
      players: [{ id: socket.id, name }],
      actions: [],
      challenge: null
    };

    if (solo && mode === "mimic") {
      const ch = generateChallenge();
      room.challenge = { ...ch, submissions: [], revealed: false };
    }

    rooms.set(code, room);
    socket.join(code);

    callback?.({ ok: true, room: publicRoom(room) });
    sendRoom(room);
    if (solo) socket.emit("game-started");
  });

  socket.on("join-room", (data, callback) => {
    const code = String(data?.code || "").trim().toUpperCase();
    const name = String(data?.name || "Oyuncu").trim().slice(0, 18);
    const room = rooms.get(code);

    if (!room) return callback?.({ ok: false, message: "Oda bulunamadı." });
    if (room.solo) return callback?.({ ok: false, message: "Bu oda tek kişilik." });
    if (room.started) return callback?.({ ok: false, message: "Oyun başlamış." });
    if (room.players.length >= MAX_PLAYERS) return callback?.({ ok: false, message: "Oda dolu." });
    if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase())) {
      return callback?.({ ok: false, message: "Bu isim odada kullanılıyor." });
    }

    room.players.push({ id: socket.id, name });
    socket.join(code);

    callback?.({ ok: true, room: publicRoom(room) });
    sendRoom(room);
  });

  socket.on("start-game", (data, callback) => {
    const room = getRoom(socket, data?.code);
    if (!room) return callback?.({ ok: false, message: "Oda bulunamadı." });
    if (room.host !== socket.id) return callback?.({ ok: false, message: "Yalnızca oda sahibi başlatabilir." });

    room.started = true;
    room.actions = [];
    room.currentTurn = 0;

    if (room.mode === "mimic") {
      const ch = generateChallenge();
      room.challenge = { ...ch, submissions: [], revealed: false };
    } else {
      room.challenge = null;
    }

    sendRoom(room);
    callback?.({ ok: true });
    io.to(room.code).emit("game-started");
  });

  // Arka plan ritim (Beat) seçimi
  socket.on("set-beat", (data, callback) => {
    const room = getRoom(socket, data?.code);
    if (!room) return callback?.({ ok: false, message: "Oda bulunamadı." });
    if (room.host !== socket.id) return callback?.({ ok: false, message: "Ritmi yalnızca oda sahibi değiştirebilir." });

    const allowedBeats = ["none", "pop", "lofi", "trap"];
    room.beat = allowedBeats.includes(data?.beat) ? data.beat : "none";
    sendRoom(room);
    io.to(room.code).emit("beat-changed", { beat: room.beat });
    callback?.({ ok: true });
  });

  // Hem tekli/akor hem de ritimli kayıt (events) ekleme
  socket.on("add-sound", (data, callback) => {
    const room = getRoom(socket, data?.code);
    if (!room || !room.started) return callback?.({ ok: false, message: "Oyun başlamamış." });
    if (room.mode === "mimic") return callback?.({ ok: false, message: "Bu modda melodi gönder." });

    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (room.mode === "party" && playerIndex !== room.currentTurn) {
      return callback?.({ ok: false, message: "Henüz senin sıran değil." });
    }

    // Ritimli kayıt geldiyse events dizisini doğrula
    const rawEvents = Array.isArray(data?.events) ? data.events.slice(0, 64) : [];
    const events = rawEvents
      .map(ev => ({
        time: clamp(ev?.time, 0, 8000, 0),
        notes: Array.isArray(ev?.notes)
          ? ev.notes.slice(0, 12).map(n => Math.max(0, Math.min(127, Number(n) || 60)))
          : []
      }))
      .filter(ev => ev.notes.length > 0);

    const notes = Array.isArray(data?.notes)
      ? data.notes.slice(0, 16).map(n => Math.max(0, Math.min(127, Number(n) || 60)))
      : [];

    if (events.length === 0 && notes.length === 0) {
      return callback?.({ ok: false, message: "Önce nota seç veya ritim kaydet." });
    }

    const finalEvents = events.length > 0 ? events : [{ time: 0, notes }];

    const action = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      playerId: socket.id,
      playerName: room.players[playerIndex].name,
      instrument: String(data.instrument || "acoustic_grand_piano").slice(0, 60),
      notes: finalEvents[0].notes,
      events: finalEvents,
      isRhythm: events.length > 1,
      settings: {
        volume: clamp(data.settings?.volume, 0, 1, 0.7),
        pitch: clamp(data.settings?.pitch, -12, 12, 0),
        duration: clamp(data.settings?.duration, 0.1, 5, 0.8),
        attack: clamp(data.settings?.attack, 0, 2, 0.02),
        release: clamp(data.settings?.release, 0, 3, 0.2),
        sustain: clamp(data.settings?.sustain, 0, 1, 0.8),
        reverb: clamp(data.settings?.reverb, 0, 1, 0.15),
        echo: clamp(data.settings?.echo, 0, 1, 0),
        distortion: clamp(data.settings?.distortion, 0, 1, 0),
        filter: clamp(data.settings?.filter, 200, 12000, 12000)
      }
    };

    room.actions.push(action);
    io.to(room.code).emit("sound-added", action);

    if (room.mode === "party") {
      room.currentTurn = (room.currentTurn + 1) % room.players.length;
    }

    sendRoom(room);
    callback?.({ ok: true });
  });

  socket.on("remove-action", (data, callback) => {
    const room = getRoom(socket, data?.code);
    if (!room) return callback?.({ ok: false, message: "Oda bulunamadı." });
    if (room.host !== socket.id) return callback?.({ ok: false, message: "Yalnızca oda sahibi katman silebilir." });

    room.actions = room.actions.filter(a => a.id !== data?.actionId);
    sendRoom(room);
    callback?.({ ok: true });
  });

  socket.on("play-song", (data, callback) => {
    const room = getRoom(socket, data?.code);
    if (!room) return callback?.({ ok: false, message: "Oda bulunamadı." });
    if (room.host !== socket.id) return callback?.({ ok: false, message: "Yalnızca oda sahibi çalabilir." });
    if ((!room.actions || room.actions.length === 0) && room.beat === "none") {
      return callback?.({ ok: false, message: "Çalınacak ses veya ritim yok." });
    }

    io.to(room.code).emit("song-playback", { action: "play" });
    callback?.({ ok: true });
  });

  socket.on("stop-song", (data, callback) => {
    const room = getRoom(socket, data?.code);
    if (!room) return callback?.({ ok: false, message: "Oda bulunamadı." });
    if (room.host !== socket.id) return callback?.({ ok: false, message: "Yalnızca oda sahibi durdurabilir." });

    io.to(room.code).emit("song-playback", { action: "stop" });
    callback?.({ ok: true });
  });

  socket.on("submit-mimic", (data, callback) => {
    const room = getRoom(socket, data?.code);
    if (!room || !room.started || room.mode !== "mimic" || !room.challenge) {
      return callback?.({ ok: false, message: "Aktif melodi yarışması bulunamadı." });
    }
    if (room.challenge.revealed) {
      return callback?.({ ok: false, message: "Bu tur sonuçlandı. Yeni tur başlat." });
    }

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return callback?.({ ok: false, message: "Oyuncu bulunamadı." });

    const rawSeq = Array.isArray(data?.sequence) ? data.sequence.slice(0, 8) : [];
    const sequence = rawSeq.map(step =>
      Array.isArray(step)
        ? step.slice(0, 6).map(n => Math.max(0, Math.min(127, Number(n) || 60)))
        : []
    );

    if (sequence.length !== room.challenge.sequence.length || sequence.some(s => s.length === 0)) {
      return callback?.({ ok: false, message: "Lütfen 4 adımın tamamına nota seç." });
    }

    const instrument = String(data?.instrument || "acoustic_grand_piano").slice(0, 60);
    const score = calculateSimilarity(room.challenge, { instrument, sequence });

    const existingIdx = room.challenge.submissions.findIndex(s => s.playerId === socket.id);
    const entry = { playerId: socket.id, playerName: player.name, instrument, sequence, score };

    if (existingIdx >= 0) room.challenge.submissions[existingIdx] = entry;
    else room.challenge.submissions.push(entry);

    if (room.solo || room.challenge.submissions.length >= room.players.length) {
      room.challenge.revealed = true;
      room.challenge.submissions.sort((a, b) => b.score - a.score);
    }

    sendRoom(room);
    callback?.({ ok: true, room: publicRoom(room) });
  });

  socket.on("reveal-mimic", (data, callback) => {
    const room = getRoom(socket, data?.code);
    if (!room || room.mode !== "mimic" || !room.challenge) {
      return callback?.({ ok: false, message: "Aktif yarışma bulunamadı." });
    }
    if (room.host !== socket.id) {
      return callback?.({ ok: false, message: "Sonuçları yalnızca oda sahibi açıklayabilir." });
    }

    room.challenge.revealed = true;
    room.challenge.submissions.sort((a, b) => b.score - a.score);
    sendRoom(room);
    callback?.({ ok: true, room: publicRoom(room) });
  });

  socket.on("next-round", (data, callback) => {
    const room = getRoom(socket, data?.code);
    if (!room) return callback?.({ ok: false, message: "Oda bulunamadı." });
    if (room.host !== socket.id) return callback?.({ ok: false, message: "Yalnızca oda sahibi sıfırlayabilir." });

    room.actions = [];
    room.currentTurn = 0;

    if (room.mode === "mimic") {
      const ch = generateChallenge();
      room.challenge = { ...ch, submissions: [], revealed: false };
    }

    sendRoom(room);
    io.to(room.code).emit("round-cleared");
    callback?.({ ok: true });
  });

  socket.on("disconnect", () => {
    removePlayer(socket);
  });
});

function clamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Müzik Partisi çalışıyor: ${PORT}`);
});
