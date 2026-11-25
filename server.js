const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const INDEX_PATH = path.join(__dirname, "index.html");

const rooms = new Map();

const TABU_CARDS = [
  { word: "PİYANO", forbidden: ["Tuş", "Siyah", "Beyaz", "Müzik", "Çalmak"] },
  { word: "GİTAR", forbidden: ["Tel", "Akustik", "Elektro", "Pena", "Çalmak"] },
  { word: "KEMAN", forbidden: ["Yay", "Tel", "Orkestra", "Omuz", "Klasik"] },
  { word: "BATERİ", forbidden: ["Davul", "Baget", "Ritim", "Zil", "Vurmak"] },
  { word: "KONSER", forbidden: ["Sahne", "Şarkıcı", "Bilet", "Seyirci", "Canlı"] },
  { word: "NAKARAT", forbidden: ["Şarkı", "Tekrar", "Söz", "Melodi", "Bölüm"] },
  { word: "MİKROFON", forbidden: ["Ses", "Şarkı", "Konuşmak", "Sahne", "Kayıt"] },
  { word: "KULAKLIK", forbidden: ["Müzik", "Dinlemek", "Kablo", "Bluetooth", "Ses"] },
  { word: "ORKESTRA", forbidden: ["Şef", "Klasik", "Keman", "Enstrüman", "Grup"] },
  { word: "DANS PİSTİ", forbidden: ["Müzik", "Oynamak", "Parti", "DJ", "Işık"] },
  { word: "METRONOM", forbidden: ["Tempo", "BPM", "Ritim", "Zaman", "Hız"] },
  { word: "AKOR", forbidden: ["Nota", "Gitar", "Piyano", "Majör", "Minör"] }
];

const MELODY_PRESETS = [
  { id: "twinkle", title: "Daha Dün Annemizin", notes: [60, 60, 67, 67, 69, 69, 67] },
  { id: "ode", title: "Neşeye Övgü", notes: [64, 64, 65, 67, 67, 65, 64, 62] },
  { id: "mario", title: "Oyun Teması", notes: [64, 64, 64, 60, 64, 67, 55] },
  { id: "canon", title: "Kanon Melodisi", notes: [64, 62, 60, 59, 57, 55, 57, 59] },
  { id: "happy", title: "İyi Ki Doğdun", notes: [60, 60, 62, 60, 65, 64] }
];

const CONCEPTS = [
  "Güneşli Piknik",
  "Gergin Robot",
  "Yağmurda Koşmak",
  "Uzay Gemisi",
  "Gece Nöbeti",
  "Büyülü Orman",
  "Hızlı Kaçış",
  "Dans Pisti",
  "Korsan Gemisi",
  "Gizemli Şato",
  "Siberpunk Gece",
  "Sahil Gün Batımı"
];

function normalizeCode(raw) {
  return String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9ĞÜŞİÖÇ]/g, "")
    .slice(0, 6);
}

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return rooms.has(code) ? generateRoomCode() : code;
}

function makeId(prefix = "id") {
  return `${prefix}_${crypto.randomBytes(4).toString("hex")}`;
}

function safeSend(ws, payload) {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (_) {}
}

function defaultSettings() {
  return {
    mode: "collab",
    rounds: 2,
    bpm: 110,
    beats: 8,
    turnTimer: 0,
    voteTimer: 30,
    secretMode: false
  };
}

function serializeRoom(room) {
  const players = Array.from(room.players.values()).map((p) => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    score: Number(p.score || 0),
    connected: Boolean(p.ws && p.ws.readyState === 1)
  }));

  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    sessionId: room.sessionId,
    round: room.round,
    turnIndex: room.turnIndex,
    currentTurnPlayerId: room.turnOrder[room.turnIndex] || null,
    turnEndsAt: room.turnEndsAt,
    cycleStartServerMs: room.cycleStartServerMs,
    djEffect: room.djEffect,
    concept: room.concept,
    settings: { ...room.settings },
    players,
    layers: room.layers,
    votes: room.votes,
    voteEndsAt: room.voteEndsAt,
    tabu: room.tabu
      ? {
          tellerId: room.tabu.tellerId,
          word: room.tabu.word,
          forbidden: room.tabu.forbidden,
          guesses: room.tabu.guesses,
          endsAt: room.tabu.endsAt
        }
      : null,
    challenge: room.challenge
      ? {
          kind: room.challenge.kind,
          pattern: room.challenge.pattern,
          melodyTitle: room.challenge.melodyTitle || null,
          melodyChoices: room.challenge.melodyChoices || [],
          instrumentId: room.challenge.instrumentId,
          submittedIds: Array.from(room.challenge.submitted.keys()),
          results: room.challenge.results || null
        }
      : null
  };
}

function broadcastRoom(room) {
  const state = serializeRoom(room);
  for (const player of room.players.values()) {
    safeSend(player.ws, {
      type: "room_state",
      room: state,
      serverNow: Date.now()
    });
  }
}

function assignHostIfNeeded(room) {
  const currentHost = room.players.get(room.hostId);
  if (currentHost && currentHost.ws && currentHost.ws.readyState === 1) return;
  for (const p of room.players.values()) {
    if (p.ws && p.ws.readyState === 1) {
      room.hostId = p.id;
      return;
    }
  }
  const first = room.players.values().next().value;
  if (first) room.hostId = first.id;
}

function cleanupEmptyRooms() {
  for (const [code, room] of rooms.entries()) {
    let anyConnected = false;
    for (const p of room.players.values()) {
      if (p.ws && p.ws.readyState === 1) {
        anyConnected = true;
        break;
      }
    }
    if (!anyConnected && Date.now() - room.lastActiveAt > 1000 * 60 * 20) {
      rooms.delete(code);
    }
  }
}

setInterval(cleanupEmptyRooms, 60 * 1000);

function setStudioTurnDeadline(room) {
  const sec = Number(room.settings.turnTimer || 0);
  room.turnEndsAt = sec > 0 ? Date.now() + sec * 1000 : null;
}

function startChallenge(room, kind) {
  const maxBeat = Math.max(1, Number(room.settings.beats || 8));
  room.phase = "challenge";
  if (kind === "rhythm") {
    const rawPatterns = [
      [0, 0.5, 1, 1.5, 2, 3, 3.5],
      [0, 1, 1.5, 2.5, 3, 3.5],
      [0, 0.75, 1.5, 2, 2.75, 3.5]
    ];
    const picked = rawPatterns[Math.floor(Math.random() * rawPatterns.length)];
    room.challenge = {
      kind: "rhythm",
      pattern: picked.map((b) => Math.min(maxBeat - 0.15, b)),
      instrumentId: "clap",
      submitted: new Map(),
      results: null
    };
  } else {
    const picked = MELODY_PRESETS[Math.floor(Math.random() * MELODY_PRESETS.length)];
    room.challenge = {
      kind: "melody",
      pattern: picked.notes,
      melodyTitle: picked.title,
      melodyChoices: MELODY_PRESETS.map((m) => m.title),
      instrumentId: "grand_piano",
      submitted: new Map(),
      results: null
    };
  }
}

function nextTabuCard(room) {
  const card = TABU_CARDS[Math.floor(Math.random() * TABU_CARDS.length)];
  room.tabu.word = card.word;
  room.tabu.forbidden = card.forbidden;
}

function startTabuRound(room) {
  const playerIds = Array.from(room.players.keys());
  const tellerId = playerIds[room.turnIndex % Math.max(1, playerIds.length)] || room.hostId;
  const card = TABU_CARDS[Math.floor(Math.random() * TABU_CARDS.length)];
  room.phase = "tabu";
  room.tabu = {
    tellerId,
    word: card.word,
    forbidden: card.forbidden,
    guesses: [],
    endsAt: Date.now() + 60000
  };
}

function beginGame(room) {
  room.sessionId = makeId("sess");
  room.round = 1;
  room.turnIndex = 0;
  room.turnOrder = Array.from(room.players.keys());
  room.layers = [];
  room.votes = {};
  room.voteEndsAt = null;
  room.cycleStartServerMs = Date.now();
  room.lastActiveAt = Date.now();

  if (room.settings.mode === "rhythm" || room.settings.mode === "melody") {
    startChallenge(room, room.settings.mode);
    return;
  }
  if (room.settings.mode === "tabu") {
    startTabuRound(room);
    return;
  }
  room.phase = "studio";
  room.concept = CONCEPTS[Math.floor(Math.random() * CONCEPTS.length)];
  setStudioTurnDeadline(room);
}

function advanceStudioTurn(room) {
  room.turnIndex += 1;
  if (room.turnIndex >= room.turnOrder.length) {
    if (room.round < room.settings.rounds) {
      room.round += 1;
      room.turnIndex = 0;
    } else {
      room.phase = "results";
      room.turnEndsAt = null;
      room.voteEndsAt = Date.now() + (room.settings.voteTimer || 30) * 1000;
      return;
    }
  }
  setStudioTurnDeadline(room);
}

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.phase === "studio" && room.turnEndsAt && now >= room.turnEndsAt) {
      advanceStudioTurn(room);
      broadcastRoom(room);
    } else if (room.phase === "results" && room.voteEndsAt && now >= room.voteEndsAt) {
      room.phase = "final";
      room.voteEndsAt = null;
      broadcastRoom(room);
    }
  }
}, 1000);

const server = http.createServer((req, res) => {
  const cleanUrl = (req.url || "/").split("?")[0];

  if (cleanUrl === "/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, now: Date.now() }));
    return;
  }

  fs.readFile(INDEX_PATH, (err, content) => {
    if (err) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("index.html okunamadı");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(content);
  });
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  let boundRoomCode = null;
  let boundPlayerId = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }

    if (msg.type === "ping") {
      safeSend(ws, { type: "pong", serverNow: Date.now() });
      return;
    }

    if (msg.type === "create_room") {
      const code = generateRoomCode();
      const playerId = msg.playerId || makeId("p");
      const room = {
        code,
        hostId: playerId,
        phase: "lobby",
        sessionId: null,
        round: 1,
        turnIndex: 0,
        turnOrder: [],
        turnEndsAt: null,
        cycleStartServerMs: Date.now(),
        djEffect: "normal",
        concept: "Güneşli Piknik",
        settings: defaultSettings(),
        players: new Map(),
        layers: [],
        votes: {},
        voteEndsAt: null,
        tabu: null,
        challenge: null,
        lastActiveAt: Date.now()
      };

      room.players.set(playerId, {
        id: playerId,
        name: String(msg.name || "Oyuncu 1").trim().slice(0, 24) || "Oyuncu 1",
        avatar: msg.avatar || "fox",
        score: 0,
        ws
      });

      rooms.set(code, room);
      boundRoomCode = code;
      boundPlayerId = playerId;

      safeSend(ws, {
        type: "joined_room",
        playerId,
        roomCode: code,
        serverNow: Date.now()
      });
      broadcastRoom(room);
      return;
    }

    if (msg.type === "join_room" || msg.type === "rejoin_room") {
      const code = normalizeCode(msg.roomCode);
      const room = rooms.get(code);
      if (!room) {
        safeSend(ws, {
          type: "error_msg",
          message: "Oda bulunamadı. Kodu kontrol et."
        });
        return;
      }

      const playerId = msg.playerId && room.players.has(msg.playerId) ? msg.playerId : makeId("p");
      const existing = room.players.get(playerId);
      const defaultName = `Oyuncu ${room.players.size + 1}`;

      room.players.set(playerId, {
        id: playerId,
        name: String(msg.name || existing?.name || defaultName).trim().slice(0, 24) || defaultName,
        avatar: msg.avatar || existing?.avatar || "panda",
        score: existing?.score || 0,
        ws
      });

      if (room.phase === "studio" && !room.turnOrder.includes(playerId)) {
        room.turnOrder.push(playerId);
      }

      room.lastActiveAt = Date.now();
      boundRoomCode = code;
      boundPlayerId = playerId;
      assignHostIfNeeded(room);

      safeSend(ws, {
        type: "joined_room",
        playerId,
        roomCode: code,
        serverNow: Date.now()
      });
      broadcastRoom(room);
      return;
    }

    const room = boundRoomCode ? rooms.get(boundRoomCode) : null;
    if (!room || !boundPlayerId) return;
    room.lastActiveAt = Date.now();

    if (msg.type === "update_settings" && room.hostId === boundPlayerId) {
      const incoming = { ...(msg.settings || {}) };
      if (incoming.mode === "muzziko") incoming.mode = "collab";
      room.settings = {
        ...room.settings,
        ...incoming
      };
      broadcastRoom(room);
      return;
    }

    if (msg.type === "start_game" && room.hostId === boundPlayerId) {
      beginGame(room);
      broadcastRoom(room);
      return;
    }

    if (msg.type === "set_dj" && room.hostId === boundPlayerId) {
      room.djEffect = msg.djEffect || "normal";
      broadcastRoom(room);
      return;
    }

    if (msg.type === "set_concept") {
      room.concept = String(msg.concept || "Güneşli Piknik").slice(0, 48);
      broadcastRoom(room);
      return;
    }

    if (msg.type === "submit_layer") {
      const player = room.players.get(boundPlayerId);
      if (player) {
        player.score = (player.score || 0) + 10;
      }
      room.layers.push({
        id: makeId("lyr"),
        playerId: boundPlayerId,
        playerName: player?.name || "Oyuncu",
        playerAvatar: player?.avatar || "fox",
        instrumentId: msg.instrumentId || "grand_piano",
        synth: msg.synth || {},
        reverse: Boolean(msg.reverse),
        notes: Array.isArray(msg.notes) ? msg.notes.slice(0, 400) : [],
        audioClip: typeof msg.audioClip === "string" && msg.audioClip.length < 450000 ? msg.audioClip : null
      });
      advanceStudioTurn(room);
      broadcastRoom(room);
      return;
    }

    if (msg.type === "delete_layer" && room.hostId === boundPlayerId) {
      room.layers = room.layers.filter((l) => l.id !== msg.layerId);
      broadcastRoom(room);
      return;
    }

    if (msg.type === "skip_turn") {
      if (room.phase === "studio") {
        advanceStudioTurn(room);
        broadcastRoom(room);
      }
      return;
    }

    if (msg.type === "cast_vote") {
      if (msg.targetPlayerId) {
        const prevVote = room.votes[boundPlayerId];
        if (prevVote && room.players.has(prevVote)) {
          const prevPl = room.players.get(prevVote);
          prevPl.score = Math.max(0, (prevPl.score || 0) - 5);
        }
        room.votes[boundPlayerId] = msg.targetPlayerId;
        const target = room.players.get(msg.targetPlayerId);
        if (target) {
          target.score = (target.score || 0) + 5;
        }
      }
      broadcastRoom(room);
      return;
    }

    if (msg.type === "finish_voting") {
      room.phase = "final";
      room.voteEndsAt = null;
      broadcastRoom(room);
      return;
    }

    if (msg.type === "return_lobby" && room.hostId === boundPlayerId) {
      room.phase = "lobby";
      room.layers = [];
      room.votes = {};
      room.turnEndsAt = null;
      room.voteEndsAt = null;
      room.challenge = null;
      room.tabu = null;
      broadcastRoom(room);
      return;
    }

    if (msg.type === "submit_challenge" && room.challenge) {
      room.challenge.submitted.set(boundPlayerId, {
        accuracy: Number(msg.accuracy || 0),
        notes: Array.isArray(msg.notes) ? msg.notes : []
      });
      if (room.challenge.submitted.size >= room.players.size) {
        const results = {};
        for (const [pid, val] of room.challenge.submitted.entries()) {
          results[pid] = val;
          const pl = room.players.get(pid);
          if (pl) pl.score = (pl.score || 0) + Math.round(val.accuracy || 0);
        }
        room.challenge.results = results;
        room.phase = "results";
      }
      broadcastRoom(room);
      return;
    }

    if (msg.type === "force_end_challenge" && room.challenge && room.hostId === boundPlayerId) {
      const results = {};
      for (const p of room.players.values()) {
        results[p.id] = room.challenge.submitted.get(p.id) || { accuracy: 0, notes: [] };
      }
      room.challenge.results = results;
      room.phase = "results";
      broadcastRoom(room);
      return;
    }

    if (msg.type === "tabu_action" && room.tabu) {
      const teller = room.players.get(room.tabu.tellerId);
      if (msg.action === "correct" && teller) {
        teller.score = (teller.score || 0) + 1;
        nextTabuCard(room);
      } else if (msg.action === "buzz" && teller) {
        teller.score = (teller.score || 0) - 1;
        nextTabuCard(room);
      } else if (msg.action === "guess" && msg.text) {
        const sender = room.players.get(boundPlayerId);
        const text = String(msg.text).trim().slice(0, 80);
        room.tabu.guesses.push({
          from: sender?.name || "Oyuncu",
          text
        });
        if (text.toLocaleUpperCase("tr-TR") === room.tabu.word.toLocaleUpperCase("tr-TR")) {
          if (sender) sender.score = (sender.score || 0) + 2;
          if (teller) teller.score = (teller.score || 0) + 1;
          nextTabuCard(room);
        }
      } else if (msg.action === "next_turn") {
        room.turnIndex = (room.turnIndex + 1) % Math.max(1, room.players.size);
        const ids = Array.from(room.players.keys());
        room.tabu.tellerId = ids[room.turnIndex] || room.hostId;
        room.tabu.guesses = [];
        nextTabuCard(room);
      }
      broadcastRoom(room);
    }
  });

  ws.on("close", () => {
    if (!boundRoomCode || !boundPlayerId) return;
    const room = rooms.get(boundRoomCode);
    if (!room) return;
    const p = room.players.get(boundPlayerId);
    if (p && p.ws === ws) {
      p.ws = null;
    }
    assignHostIfNeeded(room);
    broadcastRoom(room);
  });
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Kollay Gelsin! sunucusu ${PORT} portunda çalışıyor.`);
});
