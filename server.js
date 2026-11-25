const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 3000;
const INDEX_FILE = path.join(__dirname, "index.html");

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

server.on("error", (err) => {
  console.error("Sunucu baslatilirken hata olustu:", err.message);
});

server.listen(PORT, () => {
  console.log(`Kollay Gelsin! sunucusu aktif -> Port: ${PORT}`);
});
