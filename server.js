const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  const cleanUrl = (req.url || "/").split("?")[0];
  if (cleanUrl === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, now: Date.now() }));
    return;
  }

  const filePath = path.join(__dirname, "index.html");
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("index.html okunamadı.");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(content);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 15 * 1024 * 1024 });

const rooms = new Map();
const clients = new Map();

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = "";
    for (let i = 0; i < 4; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(code));
  return code;
}

function generatePlayerId() {
  return "p_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
}

function normalizeBeats(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 16 ? n : 8;
}

function isLoopMode(mode) {
  return ["collab", "theme"].includes(mode);
}

function buildPublicRoomForPlayer(room, viewerId) {
  const revealAll = Boolean(room.finished);
  const layers = (room.layers || []).map((layer) => {
    const hidden = Boolean(room.settings.secretMode && !revealAll && layer.playerId !== viewerId);
    if (hidden) {
      return {
        id: layer.id,
        playerId: layer.playerId,
        playerName: layer.playerName,
        avatar: layer.avatar,
        instrumentId: "hidden",
        instrumentName: "Gizli Kayıt",
        notes: [],
        recordedBpm: layer.recordedBpm,
        recordedBeats: layer.recordedBeats,
        hasVocal: false,
        vocalData: null,
        muted: Boolean(layer.muted),
        reverse: Boolean(layer.reverse),
        hiddenUntilEnd: true
      };
    }
    return {
      ...layer,
      hiddenUntilEnd: false
    };
  });

  return {
    code: room.code,
    hostId: room.hostId,
    gameSessionId: room.gameSessionId,
    started: room.started,
    finished: room.finished,
    settings: room.settings,
    players: room.players,
    currentRound: room.currentRound,
    turnIndex: room.turnIndex,
    turnSeq: room.turnSeq,
    concept: room.concept,
    djEffect: room.djEffect,
    loopBpm: room.loopBpm,
    loopPlaying: room.loopPlaying,
    loopAnchorServerMs: room.loopAnchorServerMs,
    layers,
    challenge: room.challenge,
    submissions: room.submissions,
    tabu: room.tabu,
    votes: room.votes,
    voteDone: room.voteDone,
    votingEndsServerMs: room.votingEndsServerMs,
    votingClosed: room.votingClosed,
    myVotedFor: room.votes?.[viewerId] || null,
    myVoteDone: Boolean(room.voteDone?.[viewerId])
  };
}

function broadcastRoom(room) {
  if (!room) return;
  const now = Date.now();
  for (const p of room.players) {
    const ws = clients.get(p.id);
    if (ws && ws.readyState === 1) {
      ws.send(
        JSON.stringify({
          type: "room_state",
          serverNow: now,
          room: buildPublicRoomForPlayer(room, p.id)
        })
      );
    }
  }
}

function broadcastToOthers(room, senderId, payload) {
  if (!room) return;
  const raw = JSON.stringify({ ...payload, serverNow: Date.now() });
  for (const p of room.players) {
    if (p.id === senderId) continue;
    const ws = clients.get(p.id);
    if (ws && ws.readyState === 1) {
      ws.send(raw);
    }
  }
}

function clearRoomVoteTimer(room) {
  if (room && room._voteTimer) {
    clearTimeout(room._voteTimer);
    room._voteTimer = null;
  }
}

function closeVotingAndAnnounce(room) {
  if (!room || room.votingClosed) return;
  clearRoomVoteTimer(room);
  room.votingClosed = true;
  broadcastRoom(room);
}

function startVotingPhase(room) {
  clearRoomVoteTimer(room);
  room.votes = {};
  room.voteDone = {};
  room.votingClosed = false;
  const voteSec = Math.max(10, Number(room.settings.voteDuration) || 30);
  room.votingEndsServerMs = Date.now() + voteSec * 1000;
  room._voteTimer = setTimeout(() => {
    closeVotingAndAnnounce(room);
  }, voteSec * 1000 + 250);
}

function advanceStudioTurn(room, nextConcept) {
  if (!room || !room.players.length) return;
  room.turnSeq = (room.turnSeq || 0) + 1;
  if (nextConcept) {
    room.concept = nextConcept;
  }

  const nextIdx = room.turnIndex + 1;
  if (nextIdx >= room.players.length) {
    const totalRounds = Math.max(1, Number(room.settings.totalRounds) || 2);
    if (room.currentRound >= totalRounds) {
      room.finished = true;
      room.loopPlaying = true;
      room.loopAnchorServerMs = Date.now();
      startVotingPhase(room);
      return;
    }
    room.currentRound += 1;
    room.turnIndex = 0;
  } else {
    room.turnIndex = nextIdx;
  }
}

function resetRoomToLobby(room) {
  clearRoomVoteTimer(room);
  room.gameSessionId = (room.gameSessionId || 1) + 1;
  room.started = false;
  room.finished = false;
  room.currentRound = 1;
  room.turnIndex = 0;
  room.turnSeq = 0;
  room.layers = [];
  room.loopPlaying = false;
  room.loopAnchorServerMs = Date.now();
  room.loopBpm = Number(room.settings.bpm) || 110;
  room.djEffect = "normal";
  room.challenge = null;
  room.submissions = {};
  room.tabu = null;
  room.votes = {};
  room.voteDone = {};
  room.votingEndsServerMs = null;
  room.votingClosed = false;
}

wss.on("connection", (ws) => {
  const playerId = generatePlayerId();
  clients.set(playerId, ws);
  let currentRoomCode = null;

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
      msg = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }

    if (msg.type === "create_room") {
      const code = generateRoomCode();
      const playerName = String(msg.player?.name || "Oyuncu").trim().slice(0, 20) || "Oyuncu";
      const avatar = String(msg.player?.avatar || "fox");
      const s = msg.settings || {};

      const room = {
        code,
        hostId: playerId,
        gameSessionId: 1,
        started: false,
        finished: false,
        settings: {
          mode: isLoopMode(s.mode) || ["rhythm", "melody", "tabu"].includes(s.mode) ? s.mode : "collab",
          bpm: Number(s.bpm) || 110,
          beats: normalizeBeats(s.beats),
          totalRounds: Math.max(1, Number(s.totalRounds) || 2),
          turnDuration: Math.max(0, Number(s.turnDuration) || 0),
          voteDuration: Math.max(10, Number(s.voteDuration) || 30),
          secretMode: Boolean(s.secretMode)
        },
        players: [{ id: playerId, name: playerName, avatar }],
        currentRound: 1,
        turnIndex: 0,
        turnSeq: 0,
        concept: "Güneşli Piknik",
        djEffect: "normal",
        loopBpm: Number(s.bpm) || 110,
        loopPlaying: false,
        loopAnchorServerMs: Date.now(),
        layers: [],
        challenge: null,
        submissions: {},
        tabu: null,
        votes: {},
        voteDone: {},
        votingEndsServerMs: null,
        votingClosed: false,
        _voteTimer: null
      };

      rooms.set(code, room);
      currentRoomCode = code;
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

      const playerName = String(msg.player?.name || "Oyuncu").trim().slice(0, 20) || "Oyuncu";
      const avatar = String(msg.player?.avatar || "fox");

      const existing = room.players.find((p) => p.id === playerId);
      if (existing) {
        existing.name = playerName;
        existing.avatar = avatar;
      } else {
        room.players.push({ id: playerId, name: playerName, avatar });
      }

      currentRoomCode = code;
      broadcastRoom(room);
      return;
    }

    const room = currentRoomCode ? rooms.get(currentRoomCode) : null;
    if (!room) return;
    const isHost = room.hostId === playerId;
    const sender = room.players.find((p) => p.id === playerId);

    if (msg.type === "update_settings") {
      if (!isHost || room.started) return;
      const s = msg.settings || {};
      if (s.mode && ["collab", "theme", "rhythm", "melody", "tabu"].includes(s.mode)) {
        room.settings.mode = s.mode;
      }
      if (s.bpm !== undefined) {
        room.settings.bpm = Math.min(200, Math.max(50, Number(s.bpm) || 110));
        room.loopBpm = room.settings.bpm;
      }
      if (s.beats !== undefined) room.settings.beats = normalizeBeats(s.beats);
      if (s.totalRounds !== undefined) room.settings.totalRounds = Math.min(6, Math.max(1, Number(s.totalRounds) || 2));
      if (s.turnDuration !== undefined) room.settings.turnDuration = Math.max(0, Number(s.turnDuration) || 0);
      if (s.voteDuration !== undefined) room.settings.voteDuration = Math.max(10, Number(s.voteDuration) || 30);
      if (s.secretMode !== undefined) room.settings.secretMode = Boolean(s.secretMode);
      broadcastRoom(room);
      return;
    }

    if (msg.type === "start_game") {
      if (!isHost) return;
      clearRoomVoteTimer(room);
      room.gameSessionId = (room.gameSessionId || 1) + 1;
      room.started = true;
      room.finished = false;
      room.currentRound = 1;
      room.turnIndex = 0;
      room.turnSeq = 1;
      room.layers = [];
      room.submissions = {};
      room.votes = {};
      room.voteDone = {};
      room.votingClosed = false;
      room.djEffect = "normal";
      room.loopBpm = Number(room.settings.bpm) || 110;
      if (msg.concept) room.concept = msg.concept;

      const mode = room.settings.mode;
      if (isLoopMode(mode)) {
        room.loopPlaying = true;
        room.loopAnchorServerMs = Date.now();
      } else {
        room.loopPlaying = false;
      }

      if (mode === "rhythm" || mode === "melody") {
        room.challenge = msg.challenge || null;
      } else if (mode === "tabu") {
        const scores = {};
        room.players.forEach((p) => { scores[p.id] = 0; });
        room.tabu = {
          card: msg.tabuCard || { word: "MÜZİK", forbidden: ["Ses", "Nota", "Şarkı", "Ritim", "Dinlemek"] },
          scores,
          guesses: [],
          turnToken: 1
        };
      }

      broadcastRoom(room);
      return;
    }

    if (msg.type === "restart_game") {
      if (!isHost) return;
      resetRoomToLobby(room);
      broadcastRoom(room);
      return;
    }

    if (msg.type === "live_note") {
      const activePlayer = room.players[room.turnIndex];
      if (!activePlayer || activePlayer.id !== playerId) return;
      broadcastToOthers(room, playerId, {
        type: "live_note",
        slot: msg.slot || "",
        freq: Number(msg.freq) || 261.63,
        holdMs: Number(msg.holdMs) || 480,
        instrumentId: msg.instrumentId || "grand_piano",
        synthParams: msg.synthParams || null
      });
      return;
    }

    if (msg.type === "add_layer") {
      const activePlayer = room.players[room.turnIndex];
      if (!activePlayer || (activePlayer.id !== playerId && !isHost)) return;

      if (msg.layer) {
        const author = sender || activePlayer;
        room.layers.push({
          ...msg.layer,
          playerId: author.id,
          playerName: author.name,
          avatar: author.avatar,
          muted: false,
          reverse: Boolean(msg.layer.reverse)
        });
      }

      if (!room.loopPlaying) {
        room.loopPlaying = true;
        room.loopAnchorServerMs = Date.now();
      }

      advanceStudioTurn(room, msg.nextConcept);
      broadcastRoom(room);
      return;
    }

    if (msg.type === "skip_turn") {
      const activePlayer = room.players[room.turnIndex];
      if (!activePlayer || (activePlayer.id !== playerId && !isHost)) return;
      advanceStudioTurn(room, msg.nextConcept);
      broadcastRoom(room);
      return;
    }

    if (msg.type === "new_concept") {
      if (!isHost) return;
      if (msg.concept) room.concept = msg.concept;
      broadcastRoom(room);
      return;
    }

    if (msg.type === "set_loop_playing") {
      if (!isHost) return;
      room.loopPlaying = Boolean(msg.playing);
      if (room.loopPlaying) {
        room.loopAnchorServerMs = Number(msg.anchorServerMs) || Date.now();
      }
      broadcastRoom(room);
      return;
    }

    if (msg.type === "set_loop_bpm") {
      if (!isHost) return;
      const newBpm = Math.min(200, Math.max(50, Number(msg.bpm) || 110));
      room.loopBpm = newBpm;
      room.settings.bpm = newBpm;
      room.loopAnchorServerMs = Date.now();
      broadcastRoom(room);
      return;
    }

    if (msg.type === "set_dj_effect") {
      if (!isHost) return;
      room.djEffect = msg.effect || "normal";
      broadcastRoom(room);
      return;
    }

    if (msg.type === "toggle_mute") {
      if (!isHost) return;
      const layer = room.layers.find((l) => l.id === msg.layerId);
      if (!layer) return;
      layer.muted = !layer.muted;
      broadcastRoom(room);
      return;
    }

    if (msg.type === "toggle_reverse") {
      if (!isHost) return;
      const layer = room.layers.find((l) => l.id === msg.layerId);
      if (!layer) return;
      layer.reverse = !layer.reverse;
      broadcastRoom(room);
      return;
    }

    if (msg.type === "delete_layer") {
      if (!isHost) return;
      const idx = room.layers.findIndex((l) => l.id === msg.layerId);
      if (idx === -1) return;
      room.layers.splice(idx, 1);
      broadcastRoom(room);
      return;
    }

    if (msg.type === "submit_challenge") {
      if (!sender) return;
      room.submissions[playerId] = {
        playerId,
        name: sender.name,
        avatar: sender.avatar,
        accuracy: Math.max(0, Math.min(100, Number(msg.accuracy) || 0)),
        detail: String(msg.detail || ""),
        playedNotesText: String(msg.playedNotesText || "")
      };
      if (Object.keys(room.submissions).length >= room.players.length) {
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

    if (msg.type === "tabu_guess") {
      if (!room.tabu || !sender) return;
      const teller = room.players[room.turnIndex];
      if (teller && teller.id === playerId) return;
      const guessTxt = String(msg.text || "").trim();
      if (!guessTxt) return;
      const target = String(room.tabu.card?.word || "").toLocaleUpperCase("tr-TR");
      const normGuess = guessTxt.toLocaleUpperCase("tr-TR");
      const isCorrect = target && normGuess === target;

      room.tabu.guesses.push({
        name: sender.name,
        avatar: sender.avatar,
        text: guessTxt,
        correct: isCorrect
      });

      if (isCorrect) {
        room.tabu.scores[sender.id] = (room.tabu.scores[sender.id] || 0) + 1;
        if (teller) {
          room.tabu.scores[teller.id] = (room.tabu.scores[teller.id] || 0) + 1;
        }
        if (msg.nextCard) room.tabu.card = msg.nextCard;
      }
      broadcastRoom(room);
      return;
    }

    if (msg.type === "tabu_correct") {
      if (!room.tabu) return;
      const teller = room.players[room.turnIndex];
      if (!teller || (teller.id !== playerId && !isHost)) return;
      room.tabu.scores[teller.id] = (room.tabu.scores[teller.id] || 0) + 1;
      if (msg.nextCard) room.tabu.card = msg.nextCard;
      broadcastRoom(room);
      return;
    }

    if (msg.type === "tabu_buzz") {
      if (!room.tabu) return;
      const teller = room.players[room.turnIndex];
      if (teller && teller.id === playerId) return;
      if (teller) {
        room.tabu.scores[teller.id] = (room.tabu.scores[teller.id] || 0) - 1;
      }
      room.tabu.guesses.push({
        name: sender?.name || "Oyuncu",
        avatar: sender?.avatar || "fox",
        text: "🚨 TABU! Yasaklı kelime kullanıldı (-1 Puan)",
        correct: false
      });
      if (msg.nextCard) room.tabu.card = msg.nextCard;
      broadcastRoom(room);
      return;
    }

    if (msg.type === "tabu_pass") {
      if (!room.tabu) return;
      const teller = room.players[room.turnIndex];
      if (!teller || (teller.id !== playerId && !isHost)) return;
      if (msg.nextCard) room.tabu.card = msg.nextCard;
      broadcastRoom(room);
      return;
    }

    if (msg.type === "tabu_next_turn") {
      if (!room.tabu || !room.players.length) return;
      const teller = room.players[room.turnIndex];
      if (!teller || (teller.id !== playerId && !isHost)) return;
      room.turnIndex = (room.turnIndex + 1) % room.players.length;
      room.tabu.turnToken = (room.tabu.turnToken || 1) + 1;
      if (msg.nextCard) room.tabu.card = msg.nextCard;
      broadcastRoom(room);
      return;
    }

    if (msg.type === "cast_vote") {
      if (!room.finished || room.votingClosed || room.voteDone?.[playerId]) return;
      const targetId = String(msg.targetPlayerId || "");
      if (!targetId || targetId === playerId) return;
      if (!room.players.some((p) => p.id === targetId)) return;
      room.votes[playerId] = targetId;
      broadcastRoom(room);
      return;
    }

    if (msg.type === "finish_voting") {
      if (!room.finished || room.votingClosed) return;
      room.voteDone[playerId] = true;
      const allDone = room.players.every((p) => Boolean(room.voteDone[p.id]));
      if (allDone) {
        closeVotingAndAnnounce(room);
      } else {
        broadcastRoom(room);
      }
    }
  });

  ws.on("close", () => {
    clients.delete(playerId);
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room) return;

    const wasTurnIdx = room.turnIndex;
    room.players = room.players.filter((p) => p.id !== playerId);

    if (!room.players.length) {
      clearRoomVoteTimer(room);
      rooms.delete(currentRoomCode);
      return;
    }

    if (room.hostId === playerId) {
      room.hostId = room.players[0].id;
    }

    if (room.turnIndex >= room.players.length) {
      room.turnIndex = 0;
    } else if (wasTurnIdx < room.turnIndex) {
      room.turnIndex = Math.max(0, room.turnIndex - 1);
    }

    if (room.started && !room.finished && (room.settings.mode === "rhythm" || room.settings.mode === "melody")) {
      if (Object.keys(room.submissions || {}).length >= room.players.length) {
        room.finished = true;
      }
    }

    if (room.finished && !room.votingClosed && isLoopMode(room.settings.mode)) {
      const allDone = room.players.every((p) => Boolean(room.voteDone?.[p.id]));
      if (allDone) {
        closeVotingAndAnnounce(room);
        return;
      }
    }

    broadcastRoom(room);
  });
});

server.listen(PORT, () => {
  console.log(`Kollay Gelsin! sunucusu http://localhost:${PORT} adresinde hazır.`);
});
