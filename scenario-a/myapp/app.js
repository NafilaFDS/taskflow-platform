const http = require("http");
const os = require("os");

const PORT = Number(process.env.PORT) || 3000;

let hung = false;

const server = http.createServer(async (req, res) => {
  if (req.url === "/crash") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("bye\n");
    setTimeout(() => process.exit(1), 100);
    return;
  }

  if (req.url === "/hang") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("now hanging\n");
    hung = true;
    return;
  }

  if (hung) {
    await new Promise(() => {});
    return;
  }

  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`Hello from myapp\nPort: ${PORT}\nHostname: ${os.hostname()}\n`);
    return;
  }

  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK\n");
    return;
  }

  if (req.url === "/slow") {
    await new Promise((resolve) => setTimeout(resolve, 45000));
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("finally\n");
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found\n");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`myapp listening on port ${PORT}`);
});
