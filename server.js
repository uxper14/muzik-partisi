
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 20 * 1024 * 1024
});

app.use(express.static(path.join(__dirname)));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const rooms = new Map();
const MAX_PLAYERS = 8;

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

function publicRoom(room) {
  return {
    code: room.code,
    mode: room.mode,
    host: room.host,
    started: room.started,
    currentTurn: room.currentTurn,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name
    })),
    actions: room.actions
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
    const mode = data?.mode === "free" ? "free" : "party";
    const code = makeCode();

    const room = {
      code,
      mode,
      host: socket.id,
      started: false,
      currentTurn: 0,
      players: [{ id: socket.id, name }],
      actions: [],
      dj: null
    };

    rooms.set(code, room);
    socket.join(code);

    if (typeof callback === "function") {
      callback({ ok: true, room: publicRoom(room) });
    }

    sendRoom(room);
  });

  socket.on("join-room", (data, callback) => {
    const code = String(data?.code || "").trim().toUpperCase();
    const name = String(data?.name || "Oyuncu").trim().slice(0, 18);
    const room = rooms.get(code);

    if (!room) {
      return callback?.({ ok: false, message: "Oda bulunamadı." });
    }

    if (room.started) {
      return callback?.({ ok: false, message: "Oyun başlamış." });
    }

    if (room.players.length >= MAX_PLAYERS) {
      return callback?.({ ok: false, message: "Oda dolu. En fazla 8 kişi." });
    }

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
    if (room.host !== socket.id) {
      return callback?.({ ok: false, message: "Oyunu yalnızca oda sahibi başlatabilir." });
    }

    room.started = true;
    room.actions = [];
    room.currentTurn = 0;

    sendRoom(room);
    callback?.({ ok: true });
    io.to(room.code).emit("game-started");
  });

  socket.on("add-sound", (data, callback) => {
    const room = getRoom(socket, data?.code);

    if (!room || !room.started) {
      return callback?.({ ok: false, message: "Oyun başlamamış." });
    }

    const playerIndex = room.players.findIndex(p => p.id === socket.id);

    if (room.mode === "party" && playerIndex !== room.currentTurn) {
      return callback?.({ ok: false, message: "Henüz senin sıran değil." });
    }

    const notes = Array.isArray(data.notes)
      ? data.notes.slice(0, 16).map(n => Math.max(0, Math.min(127, Number(n) || 60)))
      : [];

    if (notes.length === 0) {
      return callback?.({ ok: false, message: "Önce piyanodan nota seç." });
    }

    const action = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      playerId: socket.id,
      playerName: room.players[playerIndex].name,
      instrument: String(data.instrument || "acoustic_grand_piano").slice(0, 60),
      notes,
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

  socket.on("next-round", (data, callback) => {
    const room = getRoom(socket, data?.code);

    if (!room) return callback?.({ ok: false, message: "Oda bulunamadı." });
    if (room.host !== socket.id) {
      return callback?.({ ok: false, message: "Bu işlemi yalnızca oda sahibi yapabilir." });
    }

    room.actions = [];
    room.currentTurn = 0;
    sendRoom(room);
    io.to(room.code).emit("round-cleared");
    callback?.({ ok: true });
  });

  socket.on("dj-upload", (data, callback) => {
    const room = getRoom(socket, data?.code);

    if (!room) return callback?.({ ok: false, message: "Oda bulunamadı." });
    if (room.host !== socket.id) {
      return callback?.({ ok: false, message: "DJ dosyasını yalnızca oda sahibi yükleyebilir." });
    }

    const fileName = String(data.fileName || "DJ müziği").slice(0, 100);
    const dataUrl = String(data.dataUrl || "");

    if (!dataUrl.startsWith("data:audio/")) {
      return callback?.({ ok: false, message: "Geçerli bir ses dosyası seç." });
    }

    if (dataUrl.length > 18 * 1024 * 1024) {
      return callback?.({ ok: false, message: "Dosya çok büyük. Daha küçük bir dosya dene." });
    }

    room.dj = { fileName, dataUrl };
    io.to(room.code).emit("dj-ready", room.dj);
    callback?.({ ok: true });
  });

  socket.on("dj-control", (data, callback) => {
    const room = getRoom(socket, data?.code);

    if (!room) return callback?.({ ok: false, message: "Oda bulunamadı." });
    if (room.host !== socket.id) {
      return callback?.({ ok: false, message: "DJ kontrolleri oda sahibinde." });
    }

    const action = ["play", "pause", "stop", "volume"].includes(data.action)
      ? data.action
      : null;

    if (!action) return callback?.({ ok: false, message: "Geçersiz DJ komutu." });

    io.to(room.code).emit("dj-control", {
      action,
      volume: clamp(data.volume, 0, 1, 0.7)
    });

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
