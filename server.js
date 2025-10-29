require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const { SpeechClient } = require("@google-cloud/speech");
const { Translate } = require("@google-cloud/translate").v2;
const http = require("http");
const WebSocket = require("ws");
const colors = require("colors"); // npm i colors

// --- helper time
const now = () => new Date().toISOString().split("T")[1].split(".")[0];

// --- Si subes la KEY como JSON en la variable GOOGLE_KEY_JSON,
//     la escribimos a un archivo temporal y apuntamos a él.
if (process.env.GOOGLE_KEY_JSON) {
  try {
    const keyPath = path.join(__dirname, "google-key-from-env.json");
    fs.writeFileSync(keyPath, process.env.GOOGLE_KEY_JSON, { encoding: "utf8" });
    process.env.GOOGLE_KEY_PATH = keyPath;
    console.log(`[${now()}] 🔐 GOOGLE_KEY_JSON escrita a ${keyPath}`);
  } catch (err) {
    console.error(`[${now()}] ❌ Error escribiendo GOOGLE_KEY_JSON:`, err);
  }
}

// --- Express app
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors()); // Permitir requests desde cualquier origen

const PORT = Number(process.env.PORT || 3000);

// --- Inicializa clientes Google
const keyFilename = process.env.GOOGLE_KEY_PATH || undefined;
const clientSTT = new SpeechClient({ keyFilename });
const clientTranslate = new Translate({ keyFilename });

// --- Start HTTP server
const server = http.createServer(app);

server.listen(PORT, () => {
  console.log(`✅ Servidor HTTP corriendo en puerto ${PORT}`.green);
  console.log("🚀 Backend iniciado, esperando conexiones...\n".yellow);
});

// --- WebSocket server atachado al mismo server
const wss = new WebSocket.Server({ server });
console.log(`🟢 WebSocket listo (attach to same HTTP server).`.cyan);

// --- Health endpoint
app.get("/health", (req, res) => res.json({ ok: true }));

// --- Rooms map
const rooms = {}; // callID -> Set<ws>

wss.on("connection", (ws, req) => {
  // parse callID from querystring
  const url = new URL(req.url, `https://${req.headers.host}`);
  const callID = url.searchParams.get("callID") || "default";

  console.log(`[${now()}] 🤝 Cliente conectado (callID=${callID})`.green);

  // register socket in room
  if (!rooms[callID]) rooms[callID] = new Set();
  rooms[callID].add(ws);

  // create a single recognizeStream per connection
  const recognizeStream = clientSTT
    .streamingRecognize({
      config: {
        encoding: "LINEAR16",
        sampleRateHertz: 16000,
        languageCode: "es-ES",
      },
      interimResults: true,
    })
    .on("error", (err) => {
      console.error(`[${now()}] ❌ Error STT:`.red, err);
    })
    .on("data", async (data) => {
      const texto = data.results[0]?.alternatives[0]?.transcript || "";
      if (texto) {
        try {
          const [traduccion] = await clientTranslate.translate(texto, "en");

          console.log(`[${now()}] 🎧 Texto reconocido:`.magenta, texto);
          console.log(`[${now()}] 🌎 Traducción:`.cyan, traduccion);

          const payload = JSON.stringify({
            texto_original: texto,
            traduccion: traduccion,
            callID,
            timestamp: new Date().toISOString(),
          });

          rooms[callID].forEach((client) => {
            if (client.readyState === WebSocket.OPEN) client.send(payload);
          });
        } catch (err) {
          console.error(`[${now()}] ⚠️ Error traduciendo/enviando:`, err);
        }
      }
    });

  ws.on("message", (msg) => {
    if (Buffer.isBuffer(msg) || msg instanceof Buffer) {
      console.log(`[${now()}] 📦 Chunk recibido: ${msg.length} bytes (callID=${callID})`.blue);
      recognizeStream.write(msg);
    } else {
      console.log(`[${now()}] 🔁 Mensaje de control:`, msg.toString());
    }
  });

  ws.on("close", () => {
    try {
      recognizeStream.end();
    } catch (e) {}
    if (rooms[callID]) {
      rooms[callID].delete(ws);
      if (rooms[callID].size === 0) delete rooms[callID];
    }
    console.log(`[${now()}] 🔴 Cliente desconectado (callID=${callID})`.gray);
  });

  ws.on("error", (err) => {
    console.error(`[${now()}] ⚠️ Error socket:`, err.message);
  });
});
