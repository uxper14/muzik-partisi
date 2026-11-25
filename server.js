
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  maxHttpBufferSize: 20 * 1024 * 1024
});

app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
const rooms = new Map();

const CHALLENGE_MELODIES = [
  [60, 62, 64, 67, 64, 62, 60],
  [60, 64, 67, 72, 67, 64, 60],
  [64, 64, 67, 69, 67, 64, 62],
  [60, 60, 62, 64, 64, 62, 60],
  [67, 64, 67, 72, 71, 67, 64],
  [60, 63, 65, 67, 70, 67, 65]
];

function makeCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function makeId() {
  return crypto.randomBytes(8).toString("hex");
}

function getRoom(code) {
  return rooms.get(String(code || "").toUpperCase());
}

function publicRoom(room) {
  return {
    code: room.code,
    host: room.host,
    mode: room.mode,
    started: room.started,
    round: room.round,
    tempo: room.tempo,
    players: room.players,
    actions: room.actions,
    acted: room.acted,
    turn: room.turn,
    finished: room.finished,
    challenge: room.challenge
      ? {
          active: room.challenge.active,
          melodyLength: room.challenge.melody.length,
          timeLimit: room.challenge.timeLimit,
          endsAt: room.challenge.endsAt,
          submissions: Object.keys(room.challenge.submissions).length,
          results: room.challenge.results
        }
      : null
  };
}

function sendRoom(room) {
  io.to(room.code).emit("room-state", publicRoom(room));
}

function playerName(room, socketId) {
  const player = room.players.find(p => p.id === socketId);
  return player ? player.name : "Oyuncu";
}

function makeChallenge(room) {
  const melody = CHALLENGE_MELODIES[
    Math.floor(Math.random() * CHALLENGE_MELODIES.length)
  ];

  room.challenge = {
    active: true,
    melody,
    timeLimit: 45,
    endsAt: Date.now() + 45000,
    submissions: {},
    results: []
  };

  setTimeout(() => {
    const currentRoom = getRoom(room.code);

    if (
      !currentRoom ||
      !currentRoom.challenge ||
      !currentRoom.challenge.active
    ) {
      return;
    }

    finishChallenge(currentRoom);
  }, 45000);
}

function finishChallenge(room) {
  if (!room.challenge || !room.challenge.active) return;

  room.challenge.active = false;

  const results = room.players.map(player => {
    const submitted = room.challenge.submissions[player.id] || [];
    const target = room.challenge.melody;

    let correct = 0;
    const maxLength = Math.max(target.length, submitted.length);

    for (let i = 0; i < Math.min(target.length, submitted.length); i++) {
      if (Number(submitted[i]) === Number(target[i])) {
        correct++;
      }
    }

    const lengthPenalty = Math.abs(target.length - submitted.length);
    const score = Math.max(
      0,
      Math.round((correct / Math.max(1, maxLength)) * 100) - lengthPenalty * 5
    );

    return {
      id: player.id,
      name: player.name,
      score,
      correct,
      total: target.length
    };
  });

  results.sort((a, b) => b.score - a.score);

  room.challenge.results = results;
  room.finished = true;

  io.to(room.code).emit("challenge-result", results);
  sendRoom(room);
}

io.on("connection", socket => {
  socket.on("create-room", (data, callback) => {
    const name = String(data?.name || "Oyuncu").trim().slice(0, 18);
    const requestedMode = data?.mode;

    const mode = ["party", "free", "challenge"].includes(requestedMode)
      ? requestedMode
      : "party";

    let code;

    do {
      code = makeCode();
    } while (rooms.has(code));

    const room = {
      code,
      host: socket.id,
      mode,
      started: false,
      round: 1,
      tempo: 110,
      players: [
        {
          id: socket.id,
          name: name || "Oyuncu",
          ready: true
        }
      ],
      actions: [],
      acted: [],
      turn: 0,
      finished: false,
      challenge: null,
      dj: {
        playing: false,
        currentTime: 0,
        startedAt: null,
        fileName: null
      }
    };

    rooms.set(code, room);
    socket.join(code);

    if (typeof callback === "function") {
      callback({ success: true, code });
    }

    sendRoom(room);
  });

  socket.on("join-room", (data, callback) => {
    const code = String(data?.code || "").toUpperCase().trim();
    const name = String(data?.name || "Oyuncu").trim().slice(0, 18);
    const room = getRoom(code);

    if (!room) {
      if (typeof callback === "function") {
        callback({ success: false, message: "Oda bulunamadı." });
      }
      return;
    }

    if (room.started) {
      if (typeof callback === "function") {
        callback({ success: false, message: "Oyun zaten başlamış." });
      }
      return;
    }

    if (room.players.length >= 8) {
      if (typeof callback === "function") {
        callback({ success: false, message: "Oda dolu." });
      }
      return;
    }

    room.players.push({
      id: socket.id,
      name: name || "Oyuncu",
      ready: true
    });

    socket.join(code);

    if (typeof callback === "function") {
      callback({ success: true, code });
    }

    sendRoom(room);
  });

  socket.on("start-game", (data, callback) => {
    const code = String(data?.code || "").toUpperCase();
    const room = getRoom(code);

    if (!room) {
      if (typeof callback === "function") {
        callback({ success: false, message: "Oda bulunamadı." });
      }
      return;
    }

    if (room.host !== socket.id) {
      if (typeof callback === "function") {
        callback({ success: false, message: "Oyunu sadece oda sahibi başlatabilir." });
      }
      return;
    }

    if (room.players.length < 2) {
      if (typeof callback === "function") {
        callback({ success: false, message: "Başlamak için en az 2 oyuncu gerekli." });
      }
      return;
    }

    room.started = true;
    room.round = 1;
    room.actions = [];
    room.acted = [];
    room.turn = 0;
    room.finished = false;

io.to(code).emit("challenge-start", {
  timeLimit: room.challenge.timeLimit,
  endsAt: room.challenge.endsAt,
  melody: room.challenge.melody
});
    }

    if (typeof callback === "function") {
      callback({ success: true });
    }

    sendRoom(room);
  });

  socket.on("add-action", data => {
    const code = String(data?.code || "").toUpperCase();
    const room = getRoom(code);

    if (!room || !room.started || room.finished) return;

    const allowedTypes = [
      "note",
      "melody",
      "drums",
      "bass",
      "effect",
      "style",
      "instrument",
      "funny",
      "chord"
    ];

    if (!allowedTypes.includes(data?.type)) return;

    if (
      room.mode === "party" &&
      room.players[room.turn]?.id !== socket.id
    ) {
      return;
    }

    const action = {
      id: makeId(),
      playerId: socket.id,
      playerName: playerName(room, socket.id),
      type: data.type,
      sound: String(data.sound || "").slice(0, 30),
      note: Number.isFinite(Number(data.note)) ? Number(data.note) : null,
      data: data.data && typeof data.data === "object"
        ? data.data
        : {},
      time: Date.now()
    };

    room.actions.push(action);

    if (room.mode === "party") {
      if (!room.acted.includes(socket.id)) {
        room.acted.push(socket.id);
      }

      if (room.acted.length >= room.players.length) {
        room.finished = true;
      } else {
        room.turn = (room.turn + 1) % room.players.length;
      }
    }

    io.to(code).emit("new-action", action);
    sendRoom(room);
  });

  socket.on("next-round", (data, callback) => {
    const code = String(data?.code || "").toUpperCase();
    const room = getRoom(code);

    if (!room) {
      if (typeof callback === "function") {
        callback({ success: false, message: "Oda bulunamadı." });
      }
      return;
    }

    if (room.host !== socket.id) {
      if (typeof callback === "function") {
        callback({ success: false, message: "Bu işlemi sadece oda sahibi yapabilir." });
      }
      return;
    }

    room.round++;
    room.actions = [];
    room.acted = [];
    room.turn = 0;
    room.finished = false;

    if (typeof callback === "function") {
      callback({ success: true });
    }

    sendRoom(room);
  });

  socket.on("change-tempo", data => {
    const code = String(data?.code || "").toUpperCase();
    const room = getRoom(code);

    if (!room || !room.started) return;

    const tempo = Number(data?.tempo);

    if (!Number.isFinite(tempo)) return;

    room.tempo = Math.max(50, Math.min(200, Math.round(tempo)));
    sendRoom(room);
  });

  socket.on("challenge-submit", data => {
    const code = String(data?.code || "").toUpperCase();
    const room = getRoom(code);

    if (
      !room ||
      room.mode !== "challenge" ||
      !room.challenge ||
      !room.challenge.active
    ) {
      return;
    }

    if (room.challenge.submissions[socket.id]) return;

    if (Date.now() > room.challenge.endsAt) {
      finishChallenge(room);
      return;
    }

    const notes = Array.isArray(data?.notes)
      ? data.notes.slice(0, 30).map(Number).filter(Number.isFinite)
      : [];

    room.challenge.submissions[socket.id] = notes;

    io.to(code).emit("challenge-submitted", {
      playerId: socket.id,
      playerName: playerName(room, socket.id)
    });

    if (
      Object.keys(room.challenge.submissions).length >= room.players.length
    ) {
      finishChallenge(room);
    } else {
      sendRoom(room);
    }
  });

  socket.on("dj-control", data => {
    const code = String(data?.code || "").toUpperCase();
    const room = getRoom(code);

    if (!room || room.host !== socket.id) return;

    const command = data?.command;

    if (!["play", "pause", "resume", "stop", "seek", "volume"].includes(command)) {
      return;
    }

    if (command === "play" || command === "resume") {
      room.dj.playing = true;
      room.dj.startedAt = Date.now();
    }

    if (command === "pause" || command === "stop") {
      room.dj.playing = false;
      room.dj.startedAt = null;
    }

    if (command === "stop") {
      room.dj.currentTime = 0;
    }

    if (command === "seek") {
      room.dj.currentTime = Math.max(0, Number(data.value) || 0);
      if (room.dj.playing) {
        room.dj.startedAt = Date.now();
      }
    }

    io.to(code).emit("dj-control", {
      command,
      value: data.value,
      currentTime: room.dj.currentTime
    });
  });

  socket.on("dj-audio", data => {
    const code = String(data?.code || "").toUpperCase();
    const room = getRoom(code);

    if (!room || room.host !== socket.id) return;

    const audio = data?.audio;

    if (typeof audio !== "string" || !audio.startsWith("data:audio/")) {
      return;
    }

    room.dj.playing = false;
    room.dj.currentTime = 0;
    room.dj.startedAt = null;
    room.dj.fileName = String(data?.fileName || "Müzik dosyası").slice(0, 100);

    io.to(code).emit("dj-audio", {
      audio,
      fileName: room.dj.fileName
    });
  });

  socket.on("disconnect", () => {
    for (const [code, room] of rooms.entries()) {
      const index = room.players.findIndex(p => p.id === socket.id);

      if (index === -1) continue;

      room.players.splice(index, 1);
      room.acted = room.acted.filter(id => id !== socket.id);

      if (room.challenge?.submissions) {
        delete room.challenge.submissions[socket.id];
      }

      if (room.players.length === 0) {
        rooms.delete(code);
        continue;
      }

      if (room.host === socket.id) {
        room.host = room.players[0].id;
      }

      if (room.turn >= room.players.length) {
        room.turn = 0;
      }

      sendRoom(room);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Müzik Partisi çalışıyor: ${PORT}`);
});
