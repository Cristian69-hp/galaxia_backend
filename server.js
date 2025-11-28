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

// 🔹 Configura clave Google si viene del entorno
if (process.env.GOOGLE_KEY_JSON) {
  const keyPath = path.join(__dirname, "google-key-from-env.json");
  fs.writeFileSync(keyPath, process.env.GOOGLE_KEY_JSON, { encoding: "utf8" });
  process.env.GOOGLE_KEY_PATH = keyPath;
  console.log(`[${now()}] 🔐 GOOGLE_KEY_JSON escrita a ${keyPath}`);
}

// 🌍 Función para normalizar códigos de idioma
function normalizarCodigoIdioma(codigo) {
  if (codigo && codigo.includes('-') && codigo.length > 2) {
    return codigo;
  }

  const mapeo = {
    'es': 'es-ES',
    'en': 'en-US',
    'fr': 'fr-FR',
    'de': 'de-DE',
    'it': 'it-IT',
    'pt': 'pt-PT',
    'zh': 'zh-CN',
    'ja': 'ja-JP',
  };

  const codigoLower = (codigo || 'en').toLowerCase();
  return mapeo[codigoLower] || 'en-US';
}

// 🔄 Función para extraer código corto de idioma
function extraerCodigoCorto(codigo) {
  if (!codigo) return 'en';
  if (codigo.includes('-')) {
    return codigo.split('-')[0];
  }
  return codigo;
}

// --- Express + HTTP Server
const app = express();
app.use(express.json());
app.use(cors());

const PORT = Number(process.env.PORT || 3000);
const keyFilename = process.env.GOOGLE_KEY_PATH || undefined;

// --- Inicializa los clientes de Google
const clientSTT = new SpeechClient({ keyFilename });
const clientTranslate = new Translate({ keyFilename });

// --- HTTP + WebSocket Server
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
server.listen(PORT, () => {
  console.log(`✅ Servidor HTTP en puerto ${PORT}`.green);
  console.log("🚀 Esperando conexiones WebSocket...\n".yellow);
});

// --- Estructuras de conexión
const rooms = {}; // callID -> Set<ws>
const userMeta = {}; // ws -> { callID, userID, sourceLang, targetLang }
const roomStreams = {}; // callID -> { stream, users: Map<userID, { sourceLang, targetLang }> }
const audioBuffer = {}; // callID -> chunks pendientes

// Mantener conexión viva
setInterval(() => {
  wss.clients.forEach((c) => c.readyState === WebSocket.OPEN && c.ping());
}, 25000);

// --- Crear stream de reconocimiento POR ROOM (compartido)
function createRoomStream(callID) {
  if (roomStreams[callID] && !roomStreams[callID].stream.destroyed) {
    console.log(`[${now()}] ℹ️ Stream ya existe para room ${callID}`);
    return roomStreams[callID].stream;
  }

  console.log(`[${now()}] 🎙️ Creando stream compartido para room ${callID}`.yellow);

  // Usar el idioma del PRIMER usuario que se conecte
  const firstUser = Array.from(rooms[callID] || [])[0];
  const firstMeta = firstUser ? userMeta[firstUser] : null;
  
  if (!firstMeta) {
    console.error(`[${now()}] ❌ No hay usuarios en room ${callID}`);
    return null;
  }

  const sourceLangNormalizado = normalizarCodigoIdioma(firstMeta.sourceLang);

  console.log(`[${now()}]    - Idioma de STT: ${sourceLangNormalizado}`);

  const recognizeStream = clientSTT
    .streamingRecognize({
      config: {
        encoding: "LINEAR16",
        sampleRateHertz: 16000,
        languageCode: sourceLangNormalizado,
      },
      interimResults: true,
    })
    .on("error", (err) => {
      console.error(`[${now()}] ❌ Error STT en room ${callID}:`, err.message);
      // Recrear stream
      delete roomStreams[callID];
      if (rooms[callID] && rooms[callID].size > 0) {
        setTimeout(() => {
          createRoomStream(callID);
        }, 2000);
      }
    })
    .on("end", () => {
      console.log(`[${now()}] ⚠️ Stream STT terminó para room ${callID}`.yellow);
      delete roomStreams[callID];
      
      // Recrear si aún hay usuarios
      if (rooms[callID] && rooms[callID].size > 0) {
        setTimeout(() => {
          createRoomStream(callID);
        }, 1000);
      }
    })
    .on("data", async (data) => {
      const texto = data.results[0]?.alternatives[0]?.transcript || "";
      if (!texto) return;

      try {
        // 🔑 IMPORTANTE: Cada usuario recibe la traducción a SU idioma
        const users = roomStreams[callID]?.users || new Map();
        
        for (const [userID, userConfig] of users) {
          const targetLangCorto = extraerCodigoCorto(userConfig.targetLang);

          try {
            const [traduccion] = await clientTranslate.translate(texto, targetLangCorto);

            const payload = JSON.stringify({
              userID: firstMeta.userID, // Quien habló (del primer idioma)
              texto_original: texto,
              traduccion,
              sourceLang: sourceLangNormalizado,
              targetLang: targetLangCorto,
              timestamp: new Date().toISOString(),
            });

            // Enviar a TODOS (cada uno vera su traducción)
            if (rooms[callID]) {
              rooms[callID].forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                  client.send(payload);
                }
              });
            }

            console.log(`[${now()}] 🗣️ ${firstMeta.userID}: ${texto}`.cyan);
            console.log(`[${now()}] 🌍 Traducción (${sourceLangNormalizado}→${targetLangCorto}): ${traduccion}`.green);
          } catch (e) {
            console.error(`[${now()}] ⚠️ Error traduciendo para ${userID}:`, e.message);
          }
        }
      } catch (e) {
        console.error(`[${now()}] ⚠️ Error procesando datos:`, e.message);
      }
    });

  roomStreams[callID] = {
    stream: recognizeStream,
    users: new Map(),
  };

  return recognizeStream;
}

// --- WebSocket connection
wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `https://${req.headers.host}`);

  const callID = url.searchParams.get("callID") || "default";
  const userID = url.searchParams.get("userID") || `u_${Date.now()}`;
  const sourceLang = url.searchParams.get("sourceLang") || "es";
  const targetLang = url.searchParams.get("targetLang") || "en";

  console.log(`[${now()}] 🤝 ${userID} conectado a room ${callID}`.green);
  console.log(`[${now()}]    - ${sourceLang} → ${targetLang}`);

  // Añadir al room
  if (!rooms[callID]) rooms[callID] = new Set();
  rooms[callID].add(ws);
  console.log(`[${now()}]    - Usuarios en room: ${rooms[callID].size}`);

  // Guardar metadatos
  userMeta[ws] = { callID, userID, sourceLang, targetLang };

  // Actualizar stream compartido con info del usuario
  if (!roomStreams[callID]) {
    createRoomStream(callID);
  }
  
  if (roomStreams[callID]) {
    roomStreams[callID].users.set(userID, { sourceLang, targetLang });
  }

  // Manejar audio
  ws.on("message", (msg) => {
    if (Buffer.isBuffer(msg)) {
      const stream = roomStreams[callID]?.stream;
      if (stream && stream.writable && !stream.destroyed) {
        try {
          stream.write(msg);
        } catch (e) {
          console.warn(`[${now()}] ⚠️ Error escribiendo audio: ${e.message}`);
        }
      } else {
        console.warn(`[${now()}] ⚠️ Stream no disponible para room ${callID}`);
      }
    }
  });

  // Al cerrar
  ws.on("close", () => {
    console.log(`[${now()}] 🔴 ${userID} desconectado`.gray);

    const meta = userMeta[ws];
    if (meta) {
      // Eliminar del room
      if (rooms[meta.callID]) {
        rooms[meta.callID].delete(ws);
        console.log(`[${now()}]    - Usuarios en room: ${rooms[meta.callID].size}`);

        // Si el room queda vacía, limpiar stream
        if (rooms[meta.callID].size === 0) {
          console.log(`[${now()}] 🧹 Room ${meta.callID} vacía, cerrando stream`.yellow);
          
          if (roomStreams[meta.callID]) {
            try {
              const stream = roomStreams[meta.callID].stream;
              if (stream && !stream.destroyed) {
                stream.end();
                stream.destroy();
              }
            } catch (e) {
              console.warn(`[${now()}] ⚠️ Error cerrando stream: ${e.message}`);
            }
            delete roomStreams[meta.callID];
          }
          
          delete rooms[meta.callID];
        } else {
          // Eliminar usuario del mapa de usuarios del stream
          if (roomStreams[meta.callID]) {
            roomStreams[meta.callID].users.delete(userID);
          }
        }
      }
    }

    delete userMeta[ws];
  });

  ws.on("error", (err) => {
    console.error(`[${now()}] ⚠️ WS error (${userID}): ${err.message}`);
  });
});

// --- Endpoint de salud
app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});