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

function broadcastRoom(room) {
  const payload = JSON.stringify({
    type: "room_state",
    room: {
      code: room.code,
      hostId: room.hostId,
      started: room.started,
      settings: room.settings,
      players: room.players,
      turnIndex: room.turnIndex,
      concept: room.concept,
      layers: room.layers
    }
  });
  room.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

function broadcastEvent(room, data, excludeWs = null) {
  const payload = JSON.stringify(data);
  room.clients.forEach((client) => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

wss.on("connection", (ws) => {
  ws.playerId = "p_" + Math.random().toString(36).slice(2, 9);
  ws.roomCode = null;

  ws.send(JSON.stringify({ type: "welcome", playerId: ws.playerId }));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }

    if (msg.type === "create_room") {
      const code = generateRoomCode();
      const room = {
        code,
        hostId: ws.playerId,
        started: false,
        settings: {
          mode: msg.settings?.mode || "collab",
          bpm: Number(msg.settings?.bpm) || 115,
          beats: Number(msg.settings?.beats) || 8,
          turnDuration: Number(msg.settings?.turnDuration) || 0
        },
        players: [
          {
            id: ws.playerId,
            name: (msg.player?.name || "Oyuncu").slice(0, 18),
            avatar: msg.player?.avatar || "🦊"
          }
        ],
        turnIndex: 0,
        concept: "Yağmurda Koşmak",
        layers: [],
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
      broadcastRoom(room);
      return;
    }

    const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
    if (!room) return;

    if (msg.type === "update_settings" && ws.playerId === room.hostId) {
      room.settings = { ...room.settings, ...msg.settings };
      broadcastRoom(room);
    } else if (msg.type === "start_game" && ws.playerId === room.hostId) {
      room.started = true;
      room.turnIndex = 0;
      room.layers = [];
      if (msg.concept) room.concept = msg.concept;
      broadcastRoom(room);
    } else if (msg.type === "restart_game") {
      room.started = false;
      room.turnIndex = 0;
      room.layers = [];
      broadcastRoom(room);
    } else if (msg.type === "add_layer") {
      room.layers.push(msg.layer);
      room.turnIndex = (room.turnIndex + 1) % Math.max(1, room.players.length);
      if (msg.nextConcept) room.concept = msg.nextConcept;
      broadcastRoom(room);
    } else if (msg.type === "skip_turn") {
      room.turnIndex = (room.turnIndex + 1) % Math.max(1, room.players.length);
      if (msg.nextConcept) room.concept = msg.nextConcept;
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
      broadcastEvent(room, { type: "live_note", keyId: msg.keyId, instrumentId: msg.instrumentId }, ws);
    }
  });

  ws.on("close", () => {
    const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
    if (!room) return;
    room.clients.delete(ws);
    room.players = room.players.filter((p) => p.id !== ws.playerId);
    if (room.players.length === 0) {
      rooms.delete(room.code);
      return;
    }
    if (room.hostId === ws.playerId) {
      room.hostId = room.players[0].id;
    }
    room.turnIndex = room.turnIndex % room.players.length;
    broadcastRoom(room);
  });
});

server.listen(PORT, () => {
  console.log(`Kollay Gelsin! sunucusu aktif -> Port: ${PORT}`);
});
