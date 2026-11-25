const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT) || 3000;
const INDEX_FILE = path.join(__dirname, "index.html");

const rooms = new Map();

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return rooms.has(code) ? generateRoomCode() : code;
}

const server = http.createServer((req, res) => {
  const reqPath = (req.url || "/").split("?")[0];
  if (reqPath === "/" || reqPath === "/index.html") {
    fs.readFile(INDEX_FILE, "utf8", (err, html) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Sunucu hatasi: index.html okunamadi.");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache"
      });
      res.end(html);
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Sayfa bulunamadi.");
});

const wss = new WebSocket.Server({ server });

function serializeRoomForClient(room, viewerId) {
  const isSecretActive = Boolean(room.settings?.secretMode) && room.started && !room.finished;
  const visibleLayers = isSecretActive
    ? room.layers.map((l, idx) => ({
        ...l,
        playerName: "Gizli Oyuncu",
        avatar: "🕵️",
        instrumentName: `Gizli Katman #${idx + 1}`
      }))
    : room.layers;

  return {
    code: room.code,
    hostId: room.hostId,
    started: room.started,
    finished: room.finished,
    settings: room.settings,
    players: room.players,
    turnIndex: room.turnIndex,
    currentRound: room.currentRound,
    concept: room.concept,
    djEffect: room.djEffect,
    loopPlaying: room.loopPlaying,
    loopBpm: room.loopBpm,
    loopAnchorServerMs: room.loopAnchorServerMs,
    layers: visibleLayers,
    challenge: room.challenge,
    submissions: room.submissions,
    votes: room.votes,
    myVotedFor: room.votes?.[viewerId] || null,
    tabu: room.tabu
  };
}

function broadcastRoom(room) {
  room.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(
        JSON.stringify({
          type: "room_state",
          serverNow: Date.now(),
          room: serializeRoomForClient(room, client.playerId)
        })
      );
    }
  });
}

function broadcastEvent(room, data, excludeWs = null) {
  const payload = JSON.stringify({ ...data, serverNow: Date.now() });
  room.clients.forEach((client) => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

function advanceStudioTurn(room, nextConcept) {
  if (nextConcept) room.concept = nextConcept;
  const totalPlayers = Math.max(1, room.players.length);
  const nextIndex = room.turnIndex + 1;

  if (nextIndex >= totalPlayers) {
    room.turnIndex = 0;
    if (room.currentRound >= room.settings.totalRounds) {
      room.finished = true;
      room.loopPlaying = false;
    } else {
      room.currentRound += 1;
    }
  } else {
    room.turnIndex = nextIndex;
  }
}

wss.on("connection", (ws) => {
  ws.playerId = "p_" + Math.random().toString(36).slice(2, 9);
  ws.roomCode = null;

  ws.send(JSON.stringify({ type: "welcome", playerId: ws.playerId, serverNow: Date.now() }));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }

    if (msg.type === "create_room") {
      const code = generateRoomCode();
      const startBpm = Number(msg.settings?.bpm) || 110;
      const room = {
        code,
        hostId: ws.playerId,
        started: false,
        finished: false,
        settings: {
          mode: msg.settings?.mode || "collab",
          bpm: startBpm,
          beats: Number(msg.settings?.beats) || 8,
          totalRounds: Number(msg.settings?.totalRounds) || 2,
          turnDuration: Number(msg.settings?.turnDuration) || 0,
          secretMode: Boolean(msg.settings?.secretMode)
        },
        players: [
          {
            id: ws.playerId,
            name: (msg.player?.name || "Oyuncu").slice(0, 18),
            avatar: msg.player?.avatar || "🦊"
          }
        ],
        turnIndex: 0,
        currentRound: 1,
        concept: "Gergin Robot",
        djEffect: "normal",
        loopPlaying: false,
        loopBpm: startBpm,
        loopAnchorServerMs: Date.now(),
        layers: [],
        challenge: null,
        submissions: {},
        votes: {},
        tabu: {
          card: null,
          scores: {},
          guesses: [],
          turnToken: 0
        },
        clients: new Set([ws])
      };
      rooms.set(code, room);
      ws.roomCode = code;
      broadcastRoom(room);
      return;
    }

    if (msg.type === "join_room") {
      const code = String(msg.code || "").trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) {
        ws.send(JSON.stringify({ type: "error_msg", message: "Oda bulunamadı. Kodu kontrol et." }));
        return;
      }
      if (room.players.length >= 10) {
        ws.send(JSON.stringify({ type: "error_msg", message: "Oda dolu (en fazla 10 oyuncu)." }));
        return;
      }
      ws.roomCode = code;
      room.clients.add(ws);
      if (!room.players.some((p) => p.id === ws.playerId)) {
        room.players.push({
          id: ws.playerId,
          name: (msg.player?.name || "Oyuncu").slice(0, 18),
          avatar: msg.player?.avatar || "🐼"
        });
      }
      if (room.tabu && typeof room.tabu.scores === "object" && room.tabu.scores[ws.playerId] === undefined) {
        room.tabu.scores[ws.playerId] = 0;
      }
      broadcastRoom(room);
      return;
    }

    const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
    if (!room) return;

    if (msg.type === "update_settings" && ws.playerId === room.hostId) {
      room.settings = { ...room.settings, ...msg.settings };
      if (msg.settings?.bpm) {
        room.loopBpm = Number(msg.settings.bpm) || room.loopBpm;
      }
      broadcastRoom(room);
    } else if (msg.type === "start_game" && ws.playerId === room.hostId) {
      room.started = true;
      room.finished = false;
      room.turnIndex = 0;
      room.currentRound = 1;
      room.djEffect = "normal";
      room.loopPlaying = false;
      room.loopBpm = Number(room.settings.bpm) || 110;
      room.loopAnchorServerMs = Date.now();
      room.layers = [];
      room.submissions = {};
      room.votes = {};
      if (msg.concept) room.concept = msg.concept;
      if (msg.challenge) room.challenge = msg.challenge;

      const scores = {};
      room.players.forEach((p) => { scores[p.id] = 0; });
      room.tabu = {
        card: msg.tabuCard || null,
        scores,
        guesses: [],
        turnToken: Date.now()
      };

      broadcastRoom(room);
    } else if (msg.type === "restart_game") {
      room.started = false;
      room.finished = false;
      room.turnIndex = 0;
      room.currentRound = 1;
      room.djEffect = "normal";
      room.loopPlaying = false;
      room.loopBpm = Number(room.settings.bpm) || 110;
      room.loopAnchorServerMs = Date.now();
      room.layers = [];
      room.submissions = {};
      room.votes = {};
      broadcastRoom(room);
    } else if (msg.type === "set_loop_playing") {
      const nextPlaying = Boolean(msg.playing);
      room.loopPlaying = nextPlaying;
      if (nextPlaying) {
        room.loopAnchorServerMs = Date.now();
      }
      broadcastRoom(room);
    } else if (msg.type === "set_loop_bpm") {
      const nextBpm = Math.max(50, Math.min(200, Number(msg.bpm) || room.loopBpm || 110));
      room.loopBpm = nextBpm;
      if (room.loopPlaying) {
        room.loopAnchorServerMs = Date.now();
      }
      broadcastRoom(room);
    } else if (msg.type === "set_dj_effect" && ws.playerId === room.hostId) {
      room.djEffect = String(msg.effect || "normal");
      broadcastRoom(room);
    } else if (msg.type === "cast_vote") {
      const targetId = String(msg.targetPlayerId || "");
      if (room.players.some((p) => p.id === targetId)) {
        room.votes[ws.playerId] = targetId;
        broadcastRoom(room);
      }
    } else if (msg.type === "submit_challenge") {
      const player = room.players.find((p) => p.id === ws.playerId);
      if (player) {
        room.submissions[ws.playerId] = {
          playerId: ws.playerId,
          name: player.name,
          avatar: player.avatar,
          accuracy: Math.max(0, Math.min(100, Math.round(Number(msg.accuracy) || 0))),
          detail: String(msg.detail || "")
        };
      }
      if (room.players.every((p) => Boolean(room.submissions[p.id]))) {
        room.finished = true;
        room.loopPlaying = false;
      }
      broadcastRoom(room);
    } else if (msg.type === "force_finish_challenge" && ws.playerId === room.hostId) {
      room.players.forEach((p) => {
        if (!room.submissions[p.id]) {
          room.submissions[p.id] = {
            playerId: p.id,
            name: p.name,
            avatar: p.avatar,
            accuracy: 0,
            detail: "Süre doldu"
          };
        }
      });
      room.finished = true;
      room.loopPlaying = false;
      broadcastRoom(room);
    } else if (msg.type === "add_layer") {
      if (msg.layer) {
        room.layers.push(msg.layer);
      }
      advanceStudioTurn(room, msg.nextConcept);
      broadcastRoom(room);
    } else if (msg.type === "skip_turn") {
      advanceStudioTurn(room, msg.nextConcept);
      broadcastRoom(room);
    } else if (msg.type === "new_concept") {
      room.concept = msg.concept || room.concept;
      broadcastRoom(room);
    } else if (msg.type === "toggle_mute") {
      const layer = room.layers.find((l) => l.id === msg.layerId);
      if (layer) layer.muted = !layer.muted;
      broadcastRoom(room);
    } else if (msg.type === "toggle_reverse") {
      const layer = room.layers.find((l) => l.id === msg.layerId);
      if (layer) layer.reverse = !layer.reverse;
      broadcastRoom(room);
    } else if (msg.type === "delete_layer") {
      room.layers = room.layers.filter((l) => l.id !== msg.layerId);
      broadcastRoom(room);
    } else if (msg.type === "live_note") {
      broadcastEvent(
        room,
        {
          type: "live_note",
          freq: msg.freq,
          slot: msg.slot,
          instrumentId: msg.instrumentId,
          synthParams: msg.synthParams
        },
        ws
      );
    } else if (msg.type === "tabu_guess") {
      const player = room.players.find((p) => p.id === ws.playerId);
      const text = String(msg.text || "").trim().slice(0, 40);
      if (!player || !text || !room.tabu?.card) return;

      const normGuess = text.toLocaleLowerCase("tr-TR");
      const normTarget = String(room.tabu.card.word || "").toLocaleLowerCase("tr-TR");
      const isCorrect = normGuess === normTarget;

      room.tabu.guesses.push({
        name: player.name,
        avatar: player.avatar,
        text,
        correct: isCorrect
      });
      if (room.tabu.guesses.length > 18) room.tabu.guesses.shift();

      if (isCorrect) {
        const teller = room.players[room.turnIndex];
        room.tabu.scores[ws.playerId] = (room.tabu.scores[ws.playerId] || 0) + 1;
        if (teller) {
          room.tabu.scores[teller.id] = (room.tabu.scores[teller.id] || 0) + 1;
        }
        if (msg.nextCard) room.tabu.card = msg.nextCard;
      }
      broadcastRoom(room);
    } else if (msg.type === "tabu_correct") {
      const teller = room.players[room.turnIndex];
      if (teller) {
        room.tabu.scores[teller.id] = (room.tabu.scores[teller.id] || 0) + 1;
      }
      if (msg.nextCard) room.tabu.card = msg.nextCard;
      room.tabu.guesses.push({
        name: "Sistem",
        avatar: "✅",
        text: "Doğru bilindi! (+1)",
        correct: true
      });
      broadcastRoom(room);
    } else if (msg.type === "tabu_pass") {
      if (msg.nextCard) room.tabu.card = msg.nextCard;
      room.tabu.guesses.push({
        name: "Sistem",
        avatar: "⏭️",
        text: "Kart pas geçildi.",
        correct: false
      });
      broadcastRoom(room);
    } else if (msg.type === "tabu_next_turn") {
      room.turnIndex = (room.turnIndex + 1) % Math.max(1, room.players.length);
      if (msg.nextCard) room.tabu.card = msg.nextCard;
      room.tabu.guesses = [];
      room.tabu.turnToken = Date.now();
      broadcastRoom(room);
    }
  });

  ws.on("close", () => {
    const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
    if (!room) return;
    room.clients.delete(ws);
    room.players = room.players.filter((p) => p.id !== ws.playerId);
    delete room.submissions[ws.playerId];
    delete room.votes[ws.playerId];
    if (room.players.length === 0) {
      rooms.delete(room.code);
      return;
    }
    if (room.hostId === ws.playerId) {
      room.hostId = room.players[0].id;
    }
    room.turnIndex = room.turnIndex % room.players.length;
    if (room.started && !room.finished && (room.settings.mode === "rhythm" || room.settings.mode === "melody")) {
      if (room.players.every((p) => Boolean(room.submissions[p.id]))) {
        room.finished = true;
        room.loopPlaying = false;
      }
    }
    broadcastRoom(room);
  });
});

server.listen(PORT, () => {
  console.log(`Kollay Gelsin! sunucusu aktif -> Port: ${PORT}`);
});
