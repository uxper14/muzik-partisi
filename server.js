const express = require("express");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const app = express();
app.use(express.static(path.join(__dirname)));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const rooms = new Map();
const clients = new Map(); // playerId -> { ws, roomCode, token }

// ─── Yeniden bağlanma ─────────────────────────────────────────────────────────
// Bağlantısı kopan oyuncu hemen silinmez; bu süre içinde gizli token ile geri dönebilir.
const RECONNECT_GRACE_MS = 30_000;
const disconnectedPlayers = new Map(); // playerId -> { roomCode, token, timer }

function makeToken() {
  return crypto.randomBytes(16).toString("hex");
}

const ALLOWED_MODES = new Set(["collab", "rhythm", "melody"]);

// Yeniden dinleme hakkı: -1 = sonsuz, aksi halde 1-10
function clampReplayLimit(v) {
  const n = Number(v);
  if (n === -1) return -1;
  if (!Number.isFinite(n)) return 1;
  return Math.min(10, Math.max(1, Math.round(n)));
}
const ALLOWED_DJ_EFFECTS = new Set(["normal", "slowed", "underwater", "radio", "cave"]);

function makeId(len = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function clampBeats(raw) {
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 16) return n;
  return 8;
}

function clampTotalRounds(raw) {
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 8) return n;
  return 2;
}

function clampVoteDuration(raw) {
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 10 && n <= 120) return n;
  return 30;
}

function clearVotingTimer(room) {
  if (room && room.votingTimeout) {
    clearTimeout(room.votingTimeout);
    room.votingTimeout = null;
  }
}

function finalizeVoting(room) {
  if (!room || room.votingClosed) return;
  clearVotingTimer(room);
  room.votingClosed = true;
}

function checkAllPlayersDoneVoting(room) {
  if (!room || !room.finished || room.votingClosed) return;
  if (!room.players.length) return;
  const allDone = room.players.every((p) => Boolean(room.voteDone[p.id]));
  if (allDone) {
    finalizeVoting(room);
  }
}

function openStudioVoting(room) {
  clearVotingTimer(room);
  room.finished = true;
  room.votes = {};
  room.voteDone = {};
  room.votingClosed = false;
  const voteSec = clampVoteDuration(room.settings?.voteDuration);
  room.votingEndsServerMs = Date.now() + voteSec * 1000;

  room.votingTimeout = setTimeout(() => {
    if (!rooms.has(room.code)) return;
    finalizeVoting(room);
    broadcastRoom(room);
  }, voteSec * 1000 + 250);
}

function createRoom(hostPlayer) {
  let code = makeId(5);
  while (rooms.has(code)) code = makeId(5);

  const room = {
    code,
    hostId: hostPlayer.id,
    players: [hostPlayer],
    gameSessionId: 1,
    turnSeq: 0,
    settings: {
      mode: "collab",
      totalRounds: 2,
      bpm: 110,
      beats: 8,
      turnDuration: 0,
      voteDuration: 30,
      secretMode: false,
      replayLimit: 1 // Melodiyi Taklit Et: ilk dinlemeden sonra kaç kez yeniden dinlenebilir (-1 = sonsuz)
    },
    started: false,
    finished: false,
    currentRound: 1,
    turnIndex: 0,
    loopBpm: 110,
    loopAnchorServerMs: Date.now(),
    djEffect: "normal",
    layers: [],
    votes: {},
    voteDone: {},
    votingClosed: false,
    votingEndsServerMs: null,
    votingTimeout: null,
    challenge: null,
    challengeListens: {},
    submissions: {}
  };

  rooms.set(code, room);
  return room;
}

function sanitizeRoomForViewer(room, viewerId) {
  const revealAll = !room.settings.secretMode || room.finished;
  const layers = room.layers.map((layer) => {
    if (revealAll || layer.playerId === viewerId) {
      return { ...layer, hiddenUntilEnd: false };
    }
    return {
      id: layer.id,
      playerId: layer.playerId,
      playerName: layer.playerName,
      avatar: layer.avatar,
      instrumentName: "Gizli Enstrüman",
      muted: layer.muted,
      reverse: layer.reverse,
      hiddenUntilEnd: true,
      notes: []
    };
  });

  // FIX: Oyun bitmeden submission skorları gizle; sadece kimin gönderdiği görünür
  const submissionsForViewer = {};
  for (const [k, v] of Object.entries(room.submissions)) {
    if (room.finished) {
      submissionsForViewer[k] = v;
    } else {
      submissionsForViewer[k] = { playerId: v.playerId, name: v.name, avatar: v.avatar };
    }
  }

  return {
    code: room.code,
    hostId: room.hostId,
    // FIX: Referans yerine kopya gönder — dış mutasyona karşı koruma
    players: room.players.map((p) => ({ ...p, offline: disconnectedPlayers.has(p.id) })),
    gameSessionId: room.gameSessionId,
    turnSeq: room.turnSeq,
    settings: { ...room.settings },
    started: room.started,
    finished: room.finished,
    currentRound: room.currentRound,
    turnIndex: room.turnIndex,
    loopBpm: room.loopBpm,
    loopAnchorServerMs: room.loopAnchorServerMs,
    djEffect: room.djEffect,
    layers,
    votes: room.votingClosed ? { ...room.votes } : {},
    myVotedFor: room.votes[viewerId] || null,
    voteDone: { ...room.voteDone },
    myVoteDone: Boolean(room.voteDone[viewerId]),
    votingClosed: Boolean(room.votingClosed),
    votingEndsServerMs: room.votingEndsServerMs,
    challenge: room.challenge,
    challengeListens: { ...(room.challengeListens || {}) },
    submissions: submissionsForViewer
  };
}

function broadcastRoom(room) {
  const now = Date.now();
  for (const player of room.players) {
    const client = clients.get(player.id);
    if (client && client.ws.readyState === 1) {
      client.ws.send(
        JSON.stringify({
          type: "room_state",
          viewerId: player.id,
          serverNow: now,
          room: sanitizeRoomForViewer(room, player.id)
        })
      );
    }
  }
}

function broadcastToOthers(room, senderId, payload) {
  const now = Date.now();
  const data = JSON.stringify({ ...payload, serverNow: now });
  for (const player of room.players) {
    if (player.id === senderId) continue;
    const client = clients.get(player.id);
    if (client && client.ws.readyState === 1) {
      client.ws.send(data);
    }
  }
}

function sendError(ws, message) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "error_msg", message }));
  }
}

function resetRoomToLobby(room) {
  clearVotingTimer(room);
  room.gameSessionId = (room.gameSessionId || 1) + 1;
  room.turnSeq = 0;
  room.started = false;
  room.finished = false;
  room.currentRound = 1;
  room.turnIndex = 0;
  room.layers = [];
  room.votes = {};
  room.voteDone = {};
  room.votingClosed = false;
  room.votingEndsServerMs = null;
  room.submissions = {};
  room.challenge = null;
  room.challengeListens = {};
  room.djEffect = "normal";
  room.loopBpm = room.settings.bpm;
  room.loopAnchorServerMs = Date.now();
  // Not: settings.bpm ve loopBpm kasıtlı olarak ayrı tutulur.
  // loopBpm oyun sırasında canlı değiştirilebilir; settings.bpm lobi varsayılanıdır.
}

function advanceStudioTurn(room) {
  if (!room.players.length) return;
  room.turnSeq = (room.turnSeq || 0) + 1;
  const nextIndex = room.turnIndex + 1;
  if (nextIndex < room.players.length) {
    room.turnIndex = nextIndex;
    return;
  }

  const totalRounds = clampTotalRounds(room.settings.totalRounds);
  if (room.currentRound < totalRounds) {
    room.currentRound += 1;
    room.turnIndex = 0;
  } else {
    room.turnIndex = 0;
    openStudioVoting(room);
  }
}

// Oyuncuyu odadan kalıcı olarak çıkarır (tur/round/oylama mantığını düzelterek)
function removePlayerFromRoom(room, playerId) {
  const wasActive = room.players[room.turnIndex]?.id === playerId;
  room.players = room.players.filter((p) => p.id !== playerId);

  if (!room.players.length) {
    clearVotingTimer(room);
    rooms.delete(room.code);
    return;
  }

  if (room.hostId === playerId) {
    room.hostId = room.players[0].id;
  }

  const wrappedAround = room.turnIndex >= room.players.length;
  if (wrappedAround) room.turnIndex = 0;

  if (wasActive && room.started && !room.finished) {
    room.turnSeq = (room.turnSeq || 0) + 1;
    if (room.settings.mode === "collab" && wrappedAround) {
      const totalRounds = clampTotalRounds(room.settings.totalRounds);
      if (room.currentRound < totalRounds) {
        room.currentRound += 1;
      } else {
        openStudioVoting(room);
      }
    }
  }

  if (room.started && !room.finished && ["rhythm", "melody"].includes(room.settings.mode)) {
    if (Object.keys(room.submissions).length >= room.players.length) {
      room.finished = true;
    }
  }

  if (room.finished && !room.votingClosed) {
    checkAllPlayersDoneVoting(room);
  }

  broadcastRoom(room);
}

// ─── Pasif oda temizleme: 2 saattir başlamamış odaları kaldır ─────────────────
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [code, room] of rooms) {
    if (!room.started && room.loopAnchorServerMs < cutoff) {
      clearVotingTimer(room);
      rooms.delete(code);
    }
  }
}, 30 * 60 * 1000);
// ──────────────────────────────────────────────────────────────────────────────

wss.on("connection", (ws) => {
  let playerId = makeId(8);
  while (clients.has(playerId) || disconnectedPlayers.has(playerId)) playerId = makeId(8);
  const token = makeToken();
  clients.set(playerId, { ws, roomCode: null, token });

  // token sadece bu oyuncuya gider; oda durumunda asla yayınlanmaz
  ws.send(JSON.stringify({ type: "welcome", playerId, token, serverNow: Date.now() }));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const session = clients.get(playerId);
    if (!session || session.ws !== ws) return;

    if (msg.type === "reconnect") {
      const oldId = String(msg.playerId || "").slice(0, 16);
      const reqToken = String(msg.token || "");
      const reqCode = String(msg.roomCode || "").trim().toUpperCase();
      const room = rooms.get(reqCode);
      const fail = () => ws.send(JSON.stringify({ type: "reconnect_failed", serverNow: Date.now() }));

      if (!oldId || !reqToken || !room || oldId === playerId) return fail();
      if (!room.players.some((p) => p.id === oldId)) return fail();

      const disc = disconnectedPlayers.get(oldId);
      const live = clients.get(oldId);
      let expectedToken = null;
      if (disc && disc.roomCode === reqCode) expectedToken = disc.token;
      else if (live && live.roomCode === reqCode) expectedToken = live.token; // sunucu kopmayı henüz fark etmediyse
      if (!expectedToken) return fail();

      const a = Buffer.from(expectedToken);
      const b = Buffer.from(reqToken);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return fail();

      if (disc) {
        clearTimeout(disc.timer);
        disconnectedPlayers.delete(oldId);
      }

      // Bu bağlantının geçici kimliğini bırak, eski kimliği devral
      clients.delete(playerId);
      playerId = oldId;
      clients.set(playerId, { ws, roomCode: reqCode, token: expectedToken });

      // Eski (yarı açık) soket varsa kapat; close handler'ı ws eşleşmediği için hiçbir şey yapmaz
      if (live && live.ws !== ws) {
        try { live.ws.terminate(); } catch (_) {}
      }

      ws.send(JSON.stringify({ type: "reconnected", playerId, roomCode: reqCode, serverNow: Date.now() }));
      broadcastRoom(room);
      return;
    }

    if (msg.type === "create_room") {
      const name = String(msg.name || "Kurucu").trim().slice(0, 20) || "Kurucu";
      const avatar = String(msg.avatar || "fox_pro");
      const room = createRoom({ id: playerId, name, avatar });
      session.roomCode = room.code;
      broadcastRoom(room);
      return;
    }

    if (msg.type === "join_room") {
      const code = String(msg.code || "").trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) {
        sendError(ws, "Oda bulunamadı. Kodu kontrol et.");
        return;
      }
      if (room.started) {
        sendError(ws, "Bu odada oyun zaten başlamış.");
        return;
      }
      if (room.players.length >= 10) {
        sendError(ws, "Oda dolu (en fazla 10 oyuncu).");
        return;
      }

      // FIX: Oyuncu zaten başka bir odadaysa önce oradan temizle
      if (session.roomCode && session.roomCode !== code) {
        const oldRoom = rooms.get(session.roomCode);
        if (oldRoom) {
          oldRoom.players = oldRoom.players.filter((p) => p.id !== playerId);
          if (!oldRoom.players.length) {
            clearVotingTimer(oldRoom);
            rooms.delete(oldRoom.code);
          } else {
            if (oldRoom.hostId === playerId) {
              oldRoom.hostId = oldRoom.players[0].id;
            }
            broadcastRoom(oldRoom);
          }
        }
      }

      const name = String(msg.name || "Oyuncu").trim().slice(0, 20) || "Oyuncu";
      const avatar = String(msg.avatar || "panda_pro");
      if (!room.players.some((p) => p.id === playerId)) {
        room.players.push({ id: playerId, name, avatar });
      }
      session.roomCode = room.code;
      broadcastRoom(room);
      return;
    }

    const room = session.roomCode ? rooms.get(session.roomCode) : null;
    if (!room) return;

    const isHost = room.hostId === playerId;
    const isActivePlayer = room.players[room.turnIndex]?.id === playerId;

    if (msg.type === "update_settings") {
      if (!isHost) return;
      const incoming = msg.settings || {};
      if (incoming.mode && ALLOWED_MODES.has(incoming.mode)) {
        room.settings.mode = incoming.mode;
      }
      if (incoming.totalRounds !== undefined) {
        room.settings.totalRounds = clampTotalRounds(incoming.totalRounds);
      }
      if (incoming.bpm !== undefined) {
        const cleanBpm = Math.min(200, Math.max(50, Number(incoming.bpm) || 110));
        room.settings.bpm = cleanBpm;
        room.loopBpm = cleanBpm;
      }
      if (incoming.beats !== undefined) {
        room.settings.beats = clampBeats(incoming.beats);
      }
      if (incoming.turnDuration !== undefined) {
        room.settings.turnDuration = Math.min(180, Math.max(0, Number(incoming.turnDuration) || 0));
      }
      if (incoming.voteDuration !== undefined) {
        room.settings.voteDuration = clampVoteDuration(incoming.voteDuration);
      }
      if (incoming.replayLimit !== undefined) {
        room.settings.replayLimit = clampReplayLimit(incoming.replayLimit);
      }
      if (incoming.secretMode !== undefined) {
        room.settings.secretMode = Boolean(incoming.secretMode);
      }
      broadcastRoom(room);
      return;
    }

    if (msg.type === "start_game") {
      if (!isHost) return;
      clearVotingTimer(room);
      room.gameSessionId = (room.gameSessionId || 1) + 1;
      room.turnSeq = 1;
      room.started = true;
      room.finished = false;
      room.currentRound = 1;
      room.turnIndex = 0;
      room.layers = [];
      room.votes = {};
      room.voteDone = {};
      room.votingClosed = false;
      room.votingEndsServerMs = null;
      room.submissions = {};
      room.djEffect = "normal";
      room.loopBpm = room.settings.bpm;
      room.loopAnchorServerMs = Date.now();
      room.settings.beats = clampBeats(room.settings.beats);
      room.settings.totalRounds = clampTotalRounds(room.settings.totalRounds);
      room.settings.voteDuration = clampVoteDuration(room.settings.voteDuration);

      room.challengeListens = {}; // Yeniden dinleme hakları her tur başında sıfırlanır
      room.settings.replayLimit = clampReplayLimit(room.settings.replayLimit);
      if (room.settings.mode === "rhythm" || room.settings.mode === "melody") {
        room.challenge = msg.challenge || null;
      } else {
        room.challenge = null;
      }

      broadcastRoom(room);
      return;
    }

    if (msg.type === "return_to_lobby") {
      if (!isHost) return;
      resetRoomToLobby(room);
      broadcastRoom(room);
      return;
    }

    if (msg.type === "live_note") {
      if (!isActivePlayer) return;
      broadcastToOthers(room, playerId, {
        type: "live_note",
        slot: msg.slot,
        freq: msg.freq,
        holdMs: Number(msg.holdMs) || 480,
        instrumentId: msg.instrumentId,
        synthParams: msg.synthParams || null
      });
      return;
    }

    if (msg.type === "add_layer") {
      if (!isActivePlayer) return;
      const sender = room.players.find((p) => p.id === playerId);
      if (!sender) return;

      const rawNotes = Array.isArray(msg.notes) ? msg.notes.slice(0, 120) : [];
      const hasVocal = Boolean(msg.hasVocal && msg.vocalData);

      if (!rawNotes.length && !hasVocal) {
        advanceStudioTurn(room);
        broadcastRoom(room);
        return;
      }

      room.layers.push({
        id: makeId(6),
        playerId: sender.id,
        playerName: sender.name,
        avatar: sender.avatar,
        instrumentId: String(msg.instrumentId || "grand_piano"),
        instrumentName: String(msg.instrumentName || "Piyano"),
        recordedBpm: Number(msg.recordedBpm) || room.loopBpm,
        recordedBeats: clampBeats(msg.recordedBeats || room.settings.beats),
        muted: false,
        reverse: Boolean(msg.reverse),
        notes: rawNotes,
        hasVocal,
        vocalData: hasVocal ? String(msg.vocalData) : null,
        vocalReverse: Boolean(msg.vocalReverse),
        vocalEffect: String(msg.vocalEffect || "normal")
      });

      advanceStudioTurn(room);
      broadcastRoom(room);
      return;
    }

    if (msg.type === "skip_turn") {
      if (!(isActivePlayer || isHost)) return;
      advanceStudioTurn(room);
      broadcastRoom(room);
      return;
    }

    if (msg.type === "cast_vote") {
      if (!room.finished || room.votingClosed) return;
      // FIX: Oy verildikten sonra değiştirilemez
      if (room.votes[playerId]) return;
      const targetId = String(msg.targetPlayerId || "");
      if (!targetId || targetId === playerId) return;
      const targetExists = room.players.some((p) => p.id === targetId);
      if (!targetExists) return;
      room.votes[playerId] = targetId;
      broadcastRoom(room);
      return;
    }

    if (msg.type === "finish_voting") {
      if (!room.finished || room.votingClosed) return;
      room.voteDone[playerId] = true;
      checkAllPlayersDoneVoting(room);
      broadcastRoom(room);
      return;
    }

    if (msg.type === "set_dj_effect") {
      if (!isHost) return;
      const fx = String(msg.djEffect || "normal");
      if (ALLOWED_DJ_EFFECTS.has(fx)) {
        room.djEffect = fx;
        broadcastRoom(room);
      }
      return;
    }

    if (msg.type === "toggle_layer_mute") {
      if (!isHost) return;
      const layer = room.layers.find((l) => l.id === msg.layerId);
      if (layer) {
        layer.muted = !layer.muted;
        broadcastRoom(room);
      }
      return;
    }

    if (msg.type === "toggle_layer_reverse") {
      if (!isHost) return;
      const layer = room.layers.find((l) => l.id === msg.layerId);
      if (layer) {
        layer.reverse = !layer.reverse;
        broadcastRoom(room);
      }
      return;
    }

    if (msg.type === "delete_layer") {
      if (!isHost) return;
      room.layers = room.layers.filter((l) => l.id !== msg.layerId);
      broadcastRoom(room);
      return;
    }

    if (msg.type === "update_live_bpm") {
      if (!isHost) return;
      // Not: loopBpm canlı BPM'dir, settings.bpm lobi varsayılanıdır — kasıtlı ayrı
      room.loopBpm = Math.min(200, Math.max(50, Number(msg.bpm) || 110));
      broadcastRoom(room);
      return;
    }

    if (msg.type === "submit_challenge") {
      const sender = room.players.find((p) => p.id === playerId);
      if (!sender) return;

      room.submissions[playerId] = {
        playerId,
        name: sender.name,
        avatar: sender.avatar,
        accuracy: Math.min(100, Math.max(0, Math.round(Number(msg.accuracy) || 0))),
        detail: String(msg.detail || ""),
        playedNotesText: String(msg.playedNotesText || "")
      };

      if (Object.keys(room.submissions).length >= room.players.length) {
        room.finished = true;
      }
      broadcastRoom(room);
      return;
    }

    if (msg.type === "challenge_listen") {
      if (!room.started || room.finished || !room.challenge) return;
      if (room.settings.mode !== "melody") return;
      if (!room.players.some((p) => p.id === playerId)) return;
      if (!room.challengeListens) room.challengeListens = {};
      const used = Number(room.challengeListens[playerId]) || 0;
      const limit = clampReplayLimit(room.settings.replayLimit);
      const allowed = limit < 0 ? Infinity : 1 + limit; // ilk dinleme + yeniden dinleme hakları
      if (used >= allowed) {
        broadcastRoom(room);
        return;
      }
      room.challengeListens[playerId] = used + 1;
      broadcastRoom(room);
      return;
    }

    if (msg.type === "force_end_challenge") {
      if (!isHost) return;
      room.finished = true;
      broadcastRoom(room);
      return;
    }
  });

  ws.on("close", () => {
    const session = clients.get(playerId);
    // Kimlik başka bir bağlantıya devredildiyse (yeniden bağlanma) dokunma
    if (!session || session.ws !== ws) return;
    clients.delete(playerId);
    if (!session.roomCode) return;

    const room = rooms.get(session.roomCode);
    if (!room || !room.players.some((p) => p.id === playerId)) return;

    const goneId = playerId;
    const roomCode = session.roomCode;
    const timer = setTimeout(() => {
      disconnectedPlayers.delete(goneId);
      const r = rooms.get(roomCode);
      if (r) removePlayerFromRoom(r, goneId);
    }, RECONNECT_GRACE_MS);

    disconnectedPlayers.set(goneId, { roomCode, token: session.token, timer });
    broadcastRoom(room); // diğerleri oyuncuyu "bağlantı koptu" olarak görür
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Kollay Gelsin sunucusu ${PORT} portunda çalışıyor`);
});
