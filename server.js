
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

const rooms = new Map();

function makeCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function publicRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    mode: room.mode,
    started: room.started,
    round: room.round,
    tempo: room.tempo,
    players: room.players,
    actions: room.actions,
    acted: room.acted,
    turn: room.turn,
    finished: room.finished
  };
}

function broadcast(room) {
  io.to(room.code).emit("room-state", publicRoom(room));
}

function findRoom(socket) {
  for (const room of rooms.values()) {
    if (room.players.some(p => p.id === socket.id)) return room;
  }
  return null;
}

io.on("connection", socket => {
  socket.on("create-room", ({ name, mode }, callback) => {
    let code;
    do {
      code = makeCode();
    } while (rooms.has(code));

    const room = {
      code,
      hostId: socket.id,
      mode: mode === "free" ? "free" : "party",
      started: false,
      round: 1,
      tempo: 115,
      players: [{
        id: socket.id,
        name: String(name || "Oyuncu").trim().slice(0, 18),
        avatar: "🎧"
      }],
      actions: [],
      acted: [],
      turn: 0,
      finished: false
    };

    rooms.set(code, room);
    socket.join(code);
    callback?.({ ok: true, room: publicRoom(room) });
    broadcast(room);
  });

  socket.on("join-room", ({ name, code }, callback) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) return callback?.({
      ok: false,
      error: "Oda bulunamadı."
    });

    if (room.started) return callback?.({
      ok: false,
      error: "Oyun zaten başlamış."
    });

    if (room.players.length >= 8) return callback?.({
      ok: false,
      error: "Oda dolu."
    });

    room.players.push({
      id: socket.id,
      name: String(name || "Oyuncu").trim().slice(0, 18),
      avatar: "🎹"
    });

    socket.join(code);
    callback?.({ ok: true, room: publicRoom(room) });
    broadcast(room);
  });

  socket.on("start-game", callback => {
    const room = findRoom(socket);

    if (!room) return callback?.({
      ok: false,
      error: "Oda bulunamadı."
    });

    if (room.hostId !== socket.id) return callback?.({
      ok: false,
      error: "Oyunu sadece oda sahibi başlatabilir."
    });

    if (room.players.length < 2) return callback?.({
      ok: false,
      error: "En az 2 oyuncu gerekli."
    });

    room.started = true;
    room.round = 1;
    room.actions = [];
    room.acted = [];
    room.turn = 0;
    room.finished = false;

    callback?.({ ok: true });
    broadcast(room);
  });

  socket.on("add-action", ({ type, label, data }, callback) => {
    const room = findRoom(socket);

    if (!room || !room.started) return callback?.({
      ok: false,
      error: "Oyun başlamadı."
    });

    const player = room.players.find(p => p.id === socket.id);

    if (room.mode === "party") {
      const current = room.players[room.turn % room.players.length];

      if (room.finished || current.id !== socket.id) {
        return callback?.({
          ok: false,
          error: "Şu an sıra sende değil."
        });
      }
    }

    const allowed = [
      "note", "melody", "drums", "bass",
      "effect", "style", "instrument",
      "funny", "chord"
    ];

    if (!allowed.includes(type)) return callback?.({
      ok: false,
      error: "Geçersiz ses."
    });

    room.actions.push({
      id: crypto.randomUUID(),
      playerId: socket.id,
      playerName: player.name,
      type,
      label: String(label || "Ses").slice(0, 50),
      data: data || {}
    });

    if (room.mode === "party") {
      room.acted.push(socket.id);

      if (room.acted.length >= room.players.length) {
        room.finished = true;
      } else {
        room.turn = (room.turn + 1) % room.players.length;
      }
    }

    callback?.({ ok: true });
    broadcast(room);
  });

  socket.on("next-round", callback => {
    const room = findRoom(socket);

    if (!room || room.hostId !== socket.id || !room.finished) {
      return callback?.({
        ok: false,
        error: "Yeni tur başlatılamadı."
      });
    }

    room.round++;
    room.acted = [];
    room.turn = 0;
    room.finished = false;

    callback?.({ ok: true });
    broadcast(room);
  });

  socket.on("change-tempo", ({ tempo }, callback) => {
    const room = findRoom(socket);

    if (!room) return callback?.({
      ok: false,
      error: "Oda bulunamadı."
    });

    room.tempo = Math.max(60, Math.min(180, Number(tempo) || 115));

    callback?.({ ok: true });
    broadcast(room);
  });

  socket.on("disconnect", () => {
    const room = findRoom(socket);
    if (!room) return;

    room.players = room.players.filter(p => p.id !== socket.id);
    room.acted = room.acted.filter(id => id !== socket.id);

    if (room.players.length === 0) {
      rooms.delete(room.code);
      return;
    }

    if (room.hostId === socket.id) {
      room.hostId = room.players[0].id;
    }

    room.turn = Math.min(room.turn, room.players.length - 1);
    broadcast(room);
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log("Müzik Partisi çalışıyor: http://localhost:" + PORT);
});
