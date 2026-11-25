const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6 });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

const THEMES = [
  "🌧️ Yağmurlu Gece Kafesi", "🚀 Uzay Gemisi Kaçışı", "🏖️ 90'lar Yaz Tatili",
  "👻 Korku Filmi Gerilimi", "🤠 Vahşi Batı Düellosu", "🌃 Gece 3'te Şehir Turu",
  "🎮 Retro Atari Salonu", "🔥 Stadyum Final Heyecanı"
];

const CHAOS_TASKS = [
  { id: 'synth', text: "🎹 Sadece Synth ile melodi ekle!" },
  { id: 'flute', text: "🎶 Sadece Flüt kullanarak çal!" },
  { id: 'guitar', text: "🎸 Sadece Elektro Gitar ile katman ekle!" },
  { id: 'bass', text: "🔊 Sadece Bas Gitar ile altyapı kur!" },
  { id: 'drums', text: "🥁 Sadece Canlı Davul Pedlerini kullan!" },
  { id: 'mic', text: "🎤 Mikrofonla beatbox veya vokal ekle!" }
];

const CHALLENGES = [
  { notes: ['C4', 'E4', 'G4', 'C5'], rhythm: [0, 2, 4, 6] },
  { notes: ['A3', 'C4', 'E4', 'G4', 'A4'], rhythm: [0, 1, 3, 4, 6] },
  { notes: ['F4', 'A4', 'C5', 'G4', 'E4'], rhythm: [0, 2, 3, 5, 7] },
  { notes: ['D4', 'F4', 'A4', 'C5', 'D5', 'A4'], rhythm: [0, 1, 2, 4, 6, 7] }
];

function genCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function getRoomState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    mode: room.mode,
    bpm: room.bpm,
    timeLimit: room.timeLimit,
    blindMode: room.blindMode,
    blindRevealed: room.blindRevealed,
    players: room.players,
    layers: room.layers,
    beatPreset: room.beatPreset,
    turnIndex: room.turnIndex,
    theme: room.theme,
    chaosTasks: room.chaosTasks,
    challenge: room.challenge,
    challengeStep: room.challengeStep,
    scores: room.scores,
    votingActive: room.votingActive,
    votes: room.votes,
    winnerId: room.winnerId,
    songTitle: room.songTitle
  };
}

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name, mode, bpm, timeLimit, blindMode }) => {
    const code = genCode();
    const challenge = CHALLENGES[0];
    rooms[code] = {
      code,
      hostId: socket.id,
      mode: mode || 'free',
      bpm: Number(bpm) || 105,
      timeLimit: Number(timeLimit) || 0,
      blindMode: !!blindMode,
      blindRevealed: false,
      players: [{ id: socket.id, name: name || 'Prodüktör 1' }],
      layers: [],
      beatPreset: 'none',
      turnIndex: 0,
      theme: THEMES[Math.floor(Math.random() * THEMES.length)],
      chaosTasks: {},
      challenge,
      challengeStep: 0,
      scores: { [socket.id]: 0 },
      votingActive: false,
      votes: {},
      winnerId: null,
      songTitle: ''
    };
    assignChaosTask(rooms[code], socket.id);
    socket.join(code);
    socket.roomCode = code;
    socket.emit('roomJoined', getRoomState(rooms[code]));
  });

  socket.on('joinRoom', ({ code, name }) => {
    const room = rooms[code?.toUpperCase()];
    if (!room) return socket.emit('errorMsg', 'Oda bulunamadı!');
    room.players.push({ id: socket.id, name: name || `Oyuncu ${room.players.length + 1}` });
    room.scores[socket.id] = 0;
    assignChaosTask(room, socket.id);
    socket.join(room.code);
    socket.roomCode = room.code;
    socket.emit('roomJoined', getRoomState(room));
    io.to(room.code).emit('stateUpdate', getRoomState(room));
  });

  function assignChaosTask(room, playerId) {
    room.chaosTasks[playerId] = CHAOS_TASKS[Math.floor(Math.random() * CHAOS_TASKS.length)];
  }

  socket.on('addLayer', (layer) => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    if (room.mode === 'turn') {
      const current = room.players[room.turnIndex % room.players.length];
      if (current && current.id !== socket.id) return;
      room.turnIndex = (room.turnIndex + 1) % room.players.length;
    }
    const player = room.players.find(p => p.id === socket.id);
    layer.id = Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    layer.authorId = socket.id;
    layer.author = player ? player.name : 'Anonim';
    room.layers.push(layer);
    if (room.mode === 'chaos') assignChaosTask(room, socket.id);
    io.to(room.code).emit('stateUpdate', getRoomState(room));
  });

  socket.on('removeLayer', (layerId) => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    room.layers = room.layers.filter(l => l.id !== layerId);
    io.to(room.code).emit('stateUpdate', getRoomState(room));
  });

  socket.on('duplicateLayer', ({ layerId, type }) => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    const orig = room.layers.find(l => l.id === layerId);
    if (!orig || !orig.events) return;
    const copy = JSON.parse(JSON.stringify(orig));
    copy.id = Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    if (type === 'octave') {
      copy.label += ' (+1 Oktav)';
      copy.events.forEach(ev => {
        if (ev.notes) ev.notes = ev.notes.map(n => shiftOctave(n, 1));
      });
    } else if (type === 'reverse') {
      copy.label += ' (Ters)';
      copy.events.forEach(ev => {
        ev.step = (8 - ev.step) % 8;
        if (ev.exact !== undefined) ev.exact = Math.max(0, 8 - ev.exact - 0.25);
      });
    }
    room.layers.push(copy);
    io.to(room.code).emit('stateUpdate', getRoomState(room));
  });

  socket.on('setBeatPreset', (preset) => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    room.beatPreset = preset;
    io.to(room.code).emit('stateUpdate', getRoomState(room));
  });

  socket.on('changeBpm', (delta) => {
    const room = rooms[socket.roomCode];
    if (!room || room.hostId !== socket.id) return;
    room.bpm = Math.min(160, Math.max(65, room.bpm + delta));
    io.to(room.code).emit('stateUpdate', getRoomState(room));
  });

  socket.on('newTheme', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.hostId !== socket.id) return;
    room.theme = THEMES[Math.floor(Math.random() * THEMES.length)];
    io.to(room.code).emit('stateUpdate', getRoomState(room));
  });

  socket.on('revealBlind', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.hostId !== socket.id) return;
    room.blindRevealed = true;
    io.to(room.code).emit('stateUpdate', getRoomState(room));
  });

  socket.on('triggerFx', (fxType) => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    io.to(room.code).emit('playFx', fxType);
  });

  socket.on('sendReaction', (emoji) => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    io.to(room.code).emit('reaction', { emoji, name: player ? player.name : '' });
  });

  socket.on('submitChallenge', ({ score }) => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    room.scores[socket.id] = (room.scores[socket.id] || 0) + score;
    io.to(room.code).emit('stateUpdate', getRoomState(room));
  });

  socket.on('nextChallenge', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.hostId !== socket.id) return;
    room.challengeStep = (room.challengeStep + 1) % CHALLENGES.length;
    room.challenge = CHALLENGES[room.challengeStep];
    io.to(room.code).emit('stateUpdate', getRoomState(room));
  });

  socket.on('startVoting', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.hostId !== socket.id) return;
    room.votingActive = true;
    room.votes = {};
    room.winnerId = null;
    io.to(room.code).emit('stateUpdate', getRoomState(room));
  });

  socket.on('castVote', (targetId) => {
    const room = rooms[socket.roomCode];
    if (!room || !room.votingActive || targetId === socket.id) return;
    room.votes[socket.id] = targetId;
    io.to(room.code).emit('stateUpdate', getRoomState(room));
  });

  socket.on('finishVoting', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.hostId !== socket.id) return;
    const counts = {};
    Object.values(room.votes).forEach(id => counts[id] = (counts[id] || 0) + 1);
    let bestId = room.players[0]?.id;
    let max = -1;
    room.players.forEach(p => {
      const c = counts[p.id] || 0;
      if (c > max) { max = c; bestId = p.id; }
    });
    room.votingActive = false;
    room.winnerId = bestId;
    io.to(room.code).emit('stateUpdate', getRoomState(room));
  });

  socket.on('setSongTitle', (title) => {
    const room = rooms[socket.roomCode];
    if (!room || room.winnerId !== socket.id) return;
    room.songTitle = String(title || '').slice(0, 40);
    io.to(room.code).emit('stateUpdate', getRoomState(room));
  });

  socket.on('disconnect', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.players.length === 0) {
      delete rooms[socket.roomCode];
    } else {
      if (room.hostId === socket.id) room.hostId = room.players[0].id;
      io.to(room.code).emit('stateUpdate', getRoomState(room));
    }
  });
});

function shiftOctave(note, delta) {
  const m = note.match(/^([A-G]#?)(\d)$/);
  if (!m) return note;
  return m[1] + Math.min(6, Math.max(2, Number(m[2]) + delta));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`LoopStudio Pro aktif: http://localhost:${PORT}`));
