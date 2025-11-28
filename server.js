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
  // Si ya viene en formato completo (es-ES, en-US), retornar tal cual
  if (codigo && codigo.includes('-') && codigo.length > 2) {
    return codigo;
  }

  // Mapeo de códigos cortos a formato completo para Google APIs
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

// 🔄 Función para extraer código corto de idioma (para traducción)
function extraerCodigoCorto(codigo) {
  if (!codigo) return 'en';
  // Si viene "es-ES", extraer solo "es"
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
const userStreams = {}; // ws -> recognizeStream
const streamTimeouts = {}; // ws -> timeout ID para limpiar

// Mantener conexión viva
setInterval(() => {
  wss.clients.forEach((c) => c.readyState === WebSocket.OPEN && c.ping());
}, 25000);

// --- Crear stream de reconocimiento individual
function createRecognizeStream(ws, { callID, userID, sourceLang, targetLang }) {
  // Si ya existe un stream, cerrarlo primero
  if (userStreams[ws]) {
    try {
      userStreams[ws].end();
      userStreams[ws].destroy();
    } catch (e) {
      console.warn(`[${now()}] ⚠️ Error limpiando stream anterior: ${e.message}`);
    }
    delete userStreams[ws];
  }

  // Normalizar códigos de idioma para Google STT
  const sourceLangNormalizado = normalizarCodigoIdioma(sourceLang);
  const targetLangCorto = extraerCodigoCorto(targetLang);

  console.log(
    `[${now()}] 🎙️ Creando STT para ${userID}`.yellow
  );
  console.log(`[${now()}]    - sourceLang original: ${sourceLang} -> normalizado: ${sourceLangNormalizado}`);
  console.log(`[${now()}]    - targetLang original: ${targetLang} -> código corto: ${targetLangCorto}`);

  const recognizeStream = clientSTT
    .streamingRecognize({
      config: {
        encoding: "LINEAR16",
        sampleRateHertz: 16000,
        languageCode: sourceLangNormalizado, // ✅ Ahora usa código completo
      },
      interimResults: true,
    })
    .on("error", (err) => {
      console.error(`[${now()}] ❌ Error STT (${userID}):`, err.message);
      // Intentar recrear el stream en caso de error
      if (userMeta[ws]) {
        console.log(`[${now()}] 🔄 Recreando stream después de error para ${userID}...`.yellow);
        setTimeout(() => {
          if (userMeta[ws]) {
            createRecognizeStream(ws, userMeta[ws]);
          }
        }, 1000);
      }
    })
    .on("end", () => {
      console.log(`[${now()}] ⚠️ Stream STT terminó para ${userID}`.yellow);
      // Recrear el stream cuando termina
      if (userMeta[ws]) {
        console.log(`[${now()}] 🔄 Recreando stream para ${userID}...`.yellow);
        setTimeout(() => {
          if (userMeta[ws] && ws.readyState === WebSocket.OPEN) {
            createRecognizeStream(ws, userMeta[ws]);
          }
        }, 500);
      }
    })
    .on("data", async (data) => {
      const texto = data.results[0]?.alternatives[0]?.transcript || "";
      if (!texto) return;

      try {
        // Traducción usando código corto (Google Translate usa códigos cortos)
        const [traduccion] = await clientTranslate.translate(texto, targetLangCorto);

        const payload = JSON.stringify({
          userID,
          texto_original: texto,
          traduccion,
          sourceLang: sourceLangNormalizado, // Enviar código completo al cliente
          targetLang: targetLangCorto,
          timestamp: new Date().toISOString(),
        });

        // Enviar a todos los usuarios en el mismo room
        if (rooms[callID]) {
          rooms[callID].forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(payload);
            }
          });
        }

        console.log(`[${now()}] 🗣️ ${userID}: ${texto}`.cyan);
        console.log(`[${now()}] 🌍 Traducción (${sourceLangNormalizado}→${targetLangCorto}): ${traduccion}`.green);
      } catch (e) {
        console.error(`[${now()}] ⚠️ Error traduciendo (${userID}):`, e.message);
      }
    });

  userStreams[ws] = recognizeStream;
  return recognizeStream;
}

// --- WebSocket connection
wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `https://${req.headers.host}`);

  const callID = url.searchParams.get("callID") || "default";
  const userID = url.searchParams.get("userID") || `u_${Date.now()}`;
  const sourceLang = url.searchParams.get("sourceLang") || "es";
  const targetLang = url.searchParams.get("targetLang") || "en";

  console.log(`[${now()}] 🤝 ${userID} conectado a llamada ${callID}`.green);
  console.log(`[${now()}]    - Configuración: ${sourceLang} → ${targetLang}`);

  // --- Añadir usuario al room
  if (!rooms[callID]) rooms[callID] = new Set();
  rooms[callID].add(ws);

  // --- Guardar sus datos
  userMeta[ws] = { callID, userID, sourceLang, targetLang };

  // --- Crear su stream de reconocimiento
  const recognizeStream = createRecognizeStream(ws, userMeta[ws]);

  // --- Manejar mensajes (audio)
  ws.on("message", (msg) => {
    if (Buffer.isBuffer(msg)) {
      // ✅ Validar que el stream exista y esté listo antes de escribir
      const stream = userStreams[ws];
      if (stream && stream.writable && !stream.destroyed) {
        stream.write(msg);
      } else {
        console.warn(`[${now()}] ⚠️ Stream no está listo para escribir para ${userID}`);
      }
    } else {
      console.log(`[${now()}] 📩 Mensaje control (${userID}):`, msg.toString());
    }
  });

  // --- Al cerrar conexión
  ws.on("close", () => {
    console.log(`[${now()}] 🔴 ${userID} desconectado`.gray);

    // Limpiar timeout si existe
    if (streamTimeouts[ws]) {
      clearTimeout(streamTimeouts[ws]);
      delete streamTimeouts[ws];
    }

    // Cerrar stream del usuario
    try {
      const stream = userStreams[ws];
      if (stream) {
        if (!stream.destroyed) {
          stream.end();
          stream.destroy();
        }
      }
    } catch (e) {
      console.warn(`[${now()}] ⚠️ Error cerrando stream: ${e.message}`);
    }

    delete userStreams[ws];
    delete userMeta[ws];

    // Eliminar del room
    if (rooms[callID]) {
      rooms[callID].delete(ws);
      if (rooms[callID].size === 0) {
        console.log(`[${now()}] 🧹 Cerrando room vacío ${callID}`.yellow);
        delete rooms[callID];
      }
    }
  });

  ws.on("error", (err) => {
    console.error(`[${now()}] ⚠️ WS error (${userID}):`, err.message);
  });
});

// --- Endpoint de salud
app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});