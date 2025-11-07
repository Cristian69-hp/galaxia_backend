require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const { SpeechClient } = require("@google-cloud/speech");
const { Translate } = require("@google-cloud/translate").v2;
const http = require("http");
const WebSocket = require("ws");
const colors = require("colors");

const now = () => new Date().toISOString().split("T")[1].split(".")[0];

// --- Escribir GOOGLE_KEY_JSON si viene en el entorno
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
app.use(cors());

const PORT = Number(process.env.PORT || 3000);

// --- Inicializa clientes Google
const keyFilename = process.env.GOOGLE_KEY_PATH || undefined;
const clientSTT = new SpeechClient({ keyFilename });
const clientTranslate = new Translate({ keyFilename });

// --- HTTP + WebSocket server
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

server.listen(PORT, () => {
  console.log(`✅ Servidor HTTP corriendo en puerto ${PORT}`.green);
  console.log("🚀 Backend iniciado, esperando conexiones...\n".yellow);
});

// --- Endpoint de salud
app.get("/health", (req, res) => res.json({ ok: true }));

// --- Mapa de salas y streams
const rooms = {}; // callID -> Set<ws>
const streams = {}; // callID -> recognizeStream

// --- Mantener viva la conexión
setInterval(() => {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.ping();
  });
}, 25000);

// --- Crear un stream de reconocimiento para una sesión
function createRecognizeStream(callID) {
  console.log(`[${now()}] 🎙️ Creando recognizeStream para ${callID}`.yellow);

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
      console.error(`[${now()}] ❌ Error STT (${callID}):`, err.message);
      if (!recognizeStream.destroyed) recognizeStream.destroy();
    })
    .on("data", async (data) => {
      const texto = data.results[0]?.alternatives[0]?.transcript || "";
      if (!texto) return;

      try {
        const [traduccion] = await clientTranslate.translate(texto, "en");

        console.log(`[${now()}] 🎧 (${callID}) Texto: `.magenta + texto);
        console.log(`[${now()}] 🌎 Traducción: `.cyan + traduccion);

        const payload = JSON.stringify({
          texto_original: texto,
          traduccion,
          callID,
          timestamp: new Date().toISOString(),
        });

        // Enviar solo a los clientes del room
        rooms[callID]?.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) client.send(payload);
        });
      } catch (err) {
        console.error(`[${now()}] ⚠️ Error traduciendo (${callID}):`, err.message);
      }
    });

  streams[callID] = recognizeStream;
  return recognizeStream;
}

// --- WebSocket connection
wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const callID = url.searchParams.get("callID") || "default";

  console.log(`[${now()}] 🤝 Cliente conectado (callID=${callID})`.green);

  // --- Añadir cliente a su sala
  if (!rooms[callID]) rooms[callID] = new Set();
  rooms[callID].add(ws);

  // --- Crear stream compartido si no existe
  const recognizeStream = streams[callID] || createRecognizeStream(callID);

  // --- Manejar audio recibido
  ws.on("message", (msg) => {
    if (!Buffer.isBuffer(msg)) {
      console.log(`[${now()}] 📩 Mensaje control:`, msg.toString());
      return;
    }

    if (recognizeStream.writable && !recognizeStream.destroyed) {
      recognizeStream.write(msg);
      console.log(`[${now()}] 🎤 Audio ${msg.length} bytes -> ${callID}`.blue);
    } else {
      console.warn(`[${now()}] ⚠️ Stream no disponible para ${callID}`.yellow);
    }
  });

  // --- Cuando un cliente se desconecta
  ws.on("close", () => {
    console.log(`[${now()}] 🔴 Cliente desconectado (callID=${callID})`.gray);

    if (rooms[callID]) {
      rooms[callID].delete(ws);
      if (rooms[callID].size === 0) {
        // Cerrar stream cuando todos salen
        console.log(`[${now()}] 🧹 Cerrando stream de ${callID}`.yellow);
        if (streams[callID]) {
          try {
            streams[callID].end();
            streams[callID].destroy();
          } catch (err) {
            console.warn(`[${now()}] ⚠️ Error al cerrar stream (${callID}):`, err.message);
          }
          delete streams[callID];
        }
        delete rooms[callID];
      }
    }
  });

  ws.on("error", (err) => {
    console.error(`[${now()}] ⚠️ Error socket (${callID}):`, err.message);
  });
});
