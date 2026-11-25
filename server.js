const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const rooms = new Map();
const clients = new Map();

const DEFAULT_MODES = ["collab", "theme", "muzziko", "rhythm", "melody", "tabu"];
const LOOP_MODES = ["collab", "theme", "muzziko"];

function normalizeBeats(raw) {
  const num = Number(raw);
  if (Number.isInteger(num) && num >= 1 && num <= 16) return num;
  return 8;
}

function createDefaultSettings(override = {}) {
  const mode = DEFAULT_MODES.includes(override.mode) ? override.mode : "collab";
  const bpm = Math.min(180, Math.max(60, Number(override.bpm) || 110));
  const beats = normalizeBeats(override.beats);
  const totalRounds = Math.min(4, Math.max(1, Number(override.totalRounds) || 2));
  const turnDuration = [0, 20, 30, 45, 60].includes(Number(override.turnDuration))
    ? Number(override.turnDuration)
    : 0;
  return {
    mode,
    bpm,
    beats,
    totalRounds,
    turnDuration,
    secretMode: Boolean(override.secretMode)
  };
}

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return rooms.has(code) ? generateRoomCode() : code;
}

function sanitizePlayer(raw, fallbackId) {
  const name = String(raw?.name || "Oyuncu").trim().slice(0, 20) || "Oyuncu";
  const avatar = String(raw?.avatar || "fox").trim().slice(0, 24) || "fox";
  return {
    id: fallbackId,
    name,
    avatar
  };
}

function serializeRoomForClient(room, viewerId) {
  const hideLayers =
    room.started &&
    !room.finished &&
    room.settings.secretMode &&
    LOOP_MODES.includes(room.settings.mode);

  const visibleLayers = hideLayers
    ? room.layers.map((l) => ({
        id: l.id,
        playerId: l.playerId,
        playerName: l.playerName,
        avatar: l.avatar,
        instrumentName: "Gizli Katman",
        notes: [],
        hasVocal: false,
        muted: l.muted,
        reverse: l.reverse,
        hiddenUntilEnd: true
      }))
    : room.layers;

  const uniquePlayers = [];
  const seen = new Set();
  for (const p of room.players) {
    if (!p || !p.id || seen.has(p.id)) continue;
    seen.add(p.id);
    uniquePlayers.push({ id: p.id, name: p.name, avatar: p.avatar });
  }

  return {
    code: room.code,
    hostId: room.hostId,
    players: uniquePlayers,
    settings: room.settings,
    started: room.started,
    finished: room.finished,
    gameSessionId: room.gameSessionId,
    turnSeq: room.turnSeq,
    currentRound: room.currentRound,
    turnIndex: room.turnIndex,
    concept: room.concept,
    loopPlaying: room.loopPlaying,
    loopAnchorServerMs: room.loopAnchorServerMs,
    loopBpm: room.loopBpm,
    djEffect: room.djEffect,
    layers: visibleLayers,
    challenge: room.challenge,
    submissions: room.submissions,
    tabu: room.tabu,
    votes: room.votes,
    myVotedFor: room.votes[viewerId] || null,
    serverNow: Date.now()
  };
}

function broadcastRoom(room) {
  for (const p of room.players) {
    const meta = clients.get(p.id);
    if (meta && meta.ws.readyState === 1) {
      meta.ws.send(
        JSON.stringify({
          type: "room_state",
          room: serializeRoomForClient(room, p.id),
          serverNow: Date.now()
        })
      );
    }
  }
}

function advanceStudioTurn(room, nextConcept) {
  if (!room.players.length) return;
  if (nextConcept) room.concept = nextConcept;
  room.turnSeq = (room.turnSeq || 0) + 1;

  const nextIdx = room.turnIndex + 1;
  if (nextIdx >= room.players.length) {
    room.turnIndex = 0;
    if (room.currentRound >= room.settings.totalRounds) {
      room.finished = true;
      room.loopPlaying = true;
      room.loopAnchorServerMs = Date.now();
      return;
    }
    room.currentRound += 1;
  } else {
    room.turnIndex = nextIdx;
  }
}

function advanceTabuTurn(room, nextCard) {
  if (!room.players.length) return;
  room.turnSeq = (room.turnSeq || 0) + 1;
  room.turnIndex = (room.turnIndex + 1) % room.players.length;
  room.tabu = {
    card: nextCard || room.tabu?.card || null,
    scores: room.tabu?.scores || {},
    guesses: [],
    turnToken: (room.tabu?.turnToken || 0) + 1
  };
}

function resetToLobby(room) {
  room.started = false;
  room.finished = false;
  room.gameSessionId = (room.gameSessionId || 0) + 1;
  room.turnSeq = (room.turnSeq || 0) + 1;
  room.currentRound = 1;
  room.turnIndex = 0;
  room.loopPlaying = false;
  room.loopBpm = room.settings.bpm;
  room.djEffect = "normal";
  room.layers = [];
  room.challenge = null;
  room.submissions = {};
  room.tabu = null;
  room.votes = {};
}

function removePlayerFromRoom(playerId) {
  const meta = clients.get(playerId);
  if (!meta || !meta.roomCode) return;
  const room = rooms.get(meta.roomCode);
  meta.roomCode = null;
  if (!room) return;

  room.players = room.players.filter((p) => p.id !== playerId);
  delete room.votes[playerId];
  for (const [voterId, targetId] of Object.entries(room.votes)) {
    if (targetId === playerId) delete room.votes[voterId];
  }

  if (!room.players.length) {
    rooms.delete(room.code);
    return;
  }

  if (room.hostId === playerId) {
    room.hostId = room.players[0].id;
  }
  if (room.turnIndex >= room.players.length) {
    room.turnIndex = 0;
  }
  broadcastRoom(room);
}

const server = http.createServer((req, res) => {
  const reqPath = (req.url || "/").split("?")[0];
  if (reqPath === "/" || reqPath === "/index.html") {
    const filePath = path.join(__dirname, "index.html");
    fs.readFile(filePath, "utf8", (err, data) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("index.html okunamadi.");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    });
    return;
  }

  if (reqPath === "/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, time: Date.now() }));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Bulunamadi");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  const playerId = "p_" + crypto.randomBytes(6).toString("hex");
  clients.set(playerId, { ws, roomCode: null });

  ws.send(
    JSON.stringify({
      type: "welcome",
      playerId,
      serverNow: Date.now()
    })
  );

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch (_) {
      return;
    }

    const meta = clients.get(playerId);
    if (!meta) return;

    if (msg.type === "create_room") {
      removePlayerFromRoom(playerId);
      const code = generateRoomCode();
      const player = sanitizePlayer(msg.player, playerId);
      const settings = createDefaultSettings(msg.settings);
      const room = {
        code,
        hostId: playerId,
        players: [player],
        settings,
        started: false,
        finished: false,
        gameSessionId: 1,
        turnSeq: 1,
        currentRound: 1,
        turnIndex: 0,
        concept: "Güneşli Piknik",
        loopPlaying: false,
        loopAnchorServerMs: Date.now(),
        loopBpm: settings.bpm,
        djEffect: "normal",
        layers: [],
        challenge: null,
        submissions: {},
        tabu: null,
        votes: {}
      };
      rooms.set(code, room);
      meta.roomCode = code;
      broadcastRoom(room);
      return;
    }

    if (msg.type === "join_room") {
      const code = String(msg.code || "").trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) {
        ws.send(JSON.stringify({ type: "error_msg", message: "Oda bulunamadı. Kodu kontrol et.", serverNow: Date.now() }));
        return;
      }
      removePlayerFromRoom(playerId);
      const player = sanitizePlayer(msg.player, playerId);
      if (!room.players.some((p) => p.id === playerId)) {
        room.players.push(player);
      }
      meta.roomCode = code;
      broadcastRoom(room);
      return;
    }

    const room = meta.roomCode ? rooms.get(meta.roomCode) : null;
    if (!room) return;
    const isHost = room.hostId === playerId;
    const senderPlayer = room.players.find((p) => p.id === playerId);

    if (msg.type === "update_settings") {
      if (!isHost || room.started) return;
      room.settings = createDefaultSettings({ ...room.settings, ...(msg.settings || {}) });
      room.loopBpm = room.settings.bpm;
      broadcastRoom(room);
      return;
    }

    if (msg.type === "start_game") {
      if (!isHost) return;
      const mode = room.settings.mode;
      room.started = true;
      room.finished = false;
      room.gameSessionId = (room.gameSessionId || 0) + 1;
      room.turnSeq = (room.turnSeq || 0) + 1;
      room.currentRound = 1;
      room.turnIndex = 0;
      room.concept = String(msg.concept || "Güneşli Piknik").slice(0, 60);
      room.layers = [];
      room.submissions = {};
      room.votes = {};
      room.djEffect = "normal";
      room.loopBpm = room.settings.bpm;

      if (mode === "rhythm" || mode === "melody") {
        room.loopPlaying = false;
        room.challenge = msg.challenge || null;
        room.tabu = null;
      } else if (mode === "tabu") {
        room.loopPlaying = false;
        room.challenge = null;
        const scores = {};
        room.players.forEach((p) => { scores[p.id] = 0; });
        room.tabu = {
          card: msg.tabuCard || null,
          scores,
          guesses: [],
          turnToken: 1
        };
      } else {
        room.challenge = null;
        room.tabu = null;
        // Herkes önce kendi kaydını yapıp dinleyebilsin; gönderince loop başlar
        room.loopPlaying = false;
        room.loopAnchorServerMs = Date.now();
      }
      broadcastRoom(room);
      return;
    }

    if (msg.type === "restart_game") {
      resetToLobby(room);
      broadcastRoom(room);
      return;
    }

    if (msg.type === "live_note") {
      for (const p of room.players) {
        if (p.id === playerId) continue;
        const targetMeta = clients.get(p.id);
        if (targetMeta && targetMeta.ws.readyState === 1) {
          targetMeta.ws.send(
            JSON.stringify({
              type: "live_note",
              slot: msg.slot || "",
              freq: Number(msg.freq) || 261.63,
              holdMs: Math.min(12000, Math.max(45, Number(msg.holdMs) || 140)),
              instrumentId: String(msg.instrumentId || "grand_piano"),
              synthParams: msg.synthParams || null,
              serverNow: Date.now()
            })
          );
        }
      }
      return;
    }

    if (msg.type === "set_loop_playing") {
      const playing = Boolean(msg.playing);
      room.loopPlaying = playing;
      if (playing) {
        room.loopAnchorServerMs = Number(msg.anchorServerMs) || Date.now();
      }
      broadcastRoom(room);
      return;
    }

    if (msg.type === "set_loop_bpm") {
      const nextBpm = Math.min(200, Math.max(50, Number(msg.bpm) || 110));
      room.loopBpm = nextBpm;
      room.settings.bpm = Math.min(180, Math.max(60, nextBpm));
      room.loopAnchorServerMs = Date.now();
      broadcastRoom(room);
      return;
    }

    if (msg.type === "set_dj_effect") {
      if (!isHost) return;
      const allowedDj = ["normal", "slowed", "underwater", "radio", "cave"];
      if (!allowedDj.includes(msg.effect)) return;
      room.djEffect = msg.effect;
      room.loopAnchorServerMs = Date.now();
      broadcastRoom(room);
      return;
    }

    if (msg.type === "new_concept") {
      room.concept = String(msg.concept || "Güneşli Piknik").slice(0, 60);
      broadcastRoom(room);
      return;
    }

    if (msg.type === "add_layer") {
      if (msg.layer && typeof msg.layer === "object") {
        const cleanNotes = Array.isArray(msg.layer.notes) ? msg.layer.notes : [];
        room.layers.push({
          ...msg.layer,
          notes: cleanNotes,
          id: String(msg.layer.id || "l_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6)),
          playerId,
          playerName: senderPlayer?.name || msg.layer.playerName || "Oyuncu",
          avatar: senderPlayer?.avatar || msg.layer.avatar || "fox",
          muted: false
        });
      }
      advanceStudioTurn(room, msg.nextConcept);
      if (!room.finished) {
        room.loopPlaying = true;
        room.loopAnchorServerMs = Date.now();
      }
      broadcastRoom(room);
      return;
    }

    if (msg.type === "skip_turn") {
      advanceStudioTurn(room, msg.nextConcept);
      broadcastRoom(room);
      return;
    }

    if (msg.type === "toggle_mute") {
      const layer = room.layers.find((l) => l.id === msg.layerId);
      if (layer) layer.muted = !layer.muted;
      broadcastRoom(room);
      return;
    }

    if (msg.type === "toggle_reverse") {
      const layer = room.layers.find((l) => l.id === msg.layerId);
      if (layer) layer.reverse = !layer.reverse;
      broadcastRoom(room);
      return;
    }

    if (msg.type === "delete_layer") {
      room.layers = room.layers.filter((l) => l.id !== msg.layerId);
      broadcastRoom(room);
      return;
    }

    if (msg.type === "submit_challenge") {
      if (!senderPlayer) return;
      room.submissions[playerId] = {
        playerId,
        name: senderPlayer.name,
        avatar: senderPlayer.avatar,
        accuracy: Math.min(100, Math.max(0, Number(msg.accuracy) || 0)),
        detail: String(msg.detail || "").slice(0, 140),
        playedNotesText: String(msg.playedNotesText || "").slice(0, 260)
      };
      if (room.players.length > 0 && Object.keys(room.submissions).length >= room.players.length) {
        room.finished = true;
      }
      broadcastRoom(room);
      return;
    }

    if (msg.type === "force_finish_challenge") {
      if (!isHost) return;
      room.finished = true;
      broadcastRoom(room);
      return;
    }

    if (msg.type === "tabu_correct") {
      if (!room.tabu || !senderPlayer) return;
      const teller = room.players[room.turnIndex];
      const wordLabel = room.tabu.card?.word || "";
      if (teller && teller.id !== playerId) {
        room.tabu.scores[teller.id] = (room.tabu.scores[teller.id] || 0) + 1;
      }
      room.tabu.guesses.push({
        avatar: senderPlayer.avatar,
        name: senderPlayer.name,
        text: `✅ "${wordLabel}" doğru bilindi! Kart değişti.`,
        correct: true
      });
      room.tabu.card = msg.nextCard || room.tabu.card;
      broadcastRoom(room);
      return;
    }

    if (msg.type === "tabu_buzz") {
      if (!room.tabu || !senderPlayer) return;
      const teller = room.players[room.turnIndex];
      const wordLabel = room.tabu.card?.word || "";
      if (teller) {
        room.tabu.scores[teller.id] = (room.tabu.scores[teller.id] || 0) - 1;
      }
      room.tabu.guesses.push({
        avatar: senderPlayer.avatar,
        name: senderPlayer.name,
        text: `🚨 TABU! "${wordLabel}" kartında yasaklı kelime basıldı! (${teller?.name || "Anlatıcı"}: -1 puan, yeni kart)`,
        correct: false
      });
      room.tabu.card = msg.nextCard || room.tabu.card;
      broadcastRoom(room);
      return;
    }

    if (msg.type === "tabu_pass") {
      if (!room.tabu) return;
      room.tabu.card = msg.nextCard || room.tabu.card;
      room.tabu.guesses.push({
        avatar: senderPlayer?.avatar || "fox",
        name: senderPlayer?.name || "Anlatıcı",
        text: "⏭️ Pas geçildi, yeni kart çekildi.",
        correct: false
      });
      broadcastRoom(room);
      return;
    }

    if (msg.type === "tabu_next_turn") {
      if (!room.tabu) return;
      advanceTabuTurn(room, msg.nextCard);
      broadcastRoom(room);
      return;
    }

    if (msg.type === "tabu_guess") {
      if (!room.tabu || !senderPlayer) return;
      const text = String(msg.text || "").trim().slice(0, 100);
      if (!text) return;
      const targetWord = String(room.tabu.card?.word || "").trim().toLocaleUpperCase("tr-TR");
      const guessUpper = text.toLocaleUpperCase("tr-TR");
      const isCorrect = Boolean(targetWord) && guessUpper === targetWord;

      room.tabu.guesses.push({
        avatar: senderPlayer.avatar,
        name: senderPlayer.name,
        text: isCorrect ? `🎉 "${text}" — DOĞRU TAHMİN! (+1 puan)` : text,
        correct: isCorrect
      });

      if (isCorrect) {
        room.tabu.scores[playerId] = (room.tabu.scores[playerId] || 0) + 1;
        const teller = room.players[room.turnIndex];
        if (teller && teller.id !== playerId) {
          room.tabu.scores[teller.id] = (room.tabu.scores[teller.id] || 0) + 1;
        }
        room.tabu.card = msg.nextCard || room.tabu.card;
      }
      broadcastRoom(room);
      return;
    }

    if (msg.type === "cast_vote") {
      const targetId = String(msg.targetPlayerId || "");
      const validTarget = room.players.some((p) => p.id === targetId);
      if (!validTarget) return;
      room.votes[playerId] = targetId;
      broadcastRoom(room);
    }
  });

  ws.on("close", () => {
    removePlayerFromRoom(playerId);
    clients.delete(playerId);
  });
});

server.listen(PORT, () => {
  console.log(`Kollay Gelsin! sunucusu ${PORT} portunda çalışıyor.`);
});
