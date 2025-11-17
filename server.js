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

// 🔄 Función para extraer código corto de idioma (para traducción)
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
const userStreams = {}; // ws -> recognizeStream

// Mantener conexión viva
setInterval(() => {
  wss.clients.forEach((c) => c.readyState === WebSocket.OPEN && c.ping());
}, 25000);

// --- Crear stream de reconocimiento individual
function createRecognizeStream(ws, { callID, userID, sourceLang, targetLang }) {
  const sourceLangNormalizado = normalizarCodigoIdioma(sourceLang);
  const targetLangCorto = extraerCodigoCorto(targetLang);

  console.log(`[${now()}] 🎙️ STT: ${userID} (${sourceLang} → ${targetLang})`.yellow);

  // 🔥 Variable para almacenar el último texto procesado y evitar duplicados
  let ultimoTextoProcesado = "";
  let ultimoTimestamp = Date.now();

  const recognizeStream = clientSTT
    .streamingRecognize({
      config: {
        encoding: "LINEAR16",
        sampleRateHertz: 16000,
        languageCode: sourceLangNormalizado,
        // ✅ OPTIMIZACIONES PARA VELOCIDAD
        enableAutomaticPunctuation: true, // Puntuación automática
        useEnhanced: true, // Modelo mejorado (más rápido)
        model: 'latest_short', // Modelo optimizado para frases cortas
      },
      interimResults: true, // Resultados intermedios para baja latencia
    })
    .on("error", (err) => {
      console.error(`[${now()}] ❌ Error STT (${userID}):`, err.message);
    })
    .on("data", async (data) => {
      try {
        const result = data.results[0];
        if (!result) return;

        const texto = result.alternatives[0]?.transcript || "";
        if (!texto) return;

        // ✅ SOLO procesar resultados FINALES para evitar spam
        // Los interimResults se usan para iniciar rápido, pero solo enviamos finales
        const isFinal = result.isFinal;
        
        // 🔥 OPTIMIZACIÓN: Reducir duplicados y spam
        const ahora = Date.now();
        const tiempoDesdeUltimo = ahora - ultimoTimestamp;
        
        // Solo procesar si:
        // 1. Es resultado final, O
        // 2. Ha pasado al menos 500ms desde el último mensaje (para interims)
        if (!isFinal && tiempoDesdeUltimo < 500) {
          return;
        }

        // Evitar procesar el mismo texto múltiples veces
        if (texto === ultimoTextoProcesado && tiempoDesdeUltimo < 1000) {
          return;
        }

        ultimoTextoProcesado = texto;
        ultimoTimestamp = ahora;

        // 🌍 TRADUCCIÓN RÁPIDA
        const [traduccion] = await clientTranslate.translate(texto, targetLangCorto);

        const payload = JSON.stringify({
          userID,
          texto_original: texto,
          traduccion,
          sourceLang: sourceLangNormalizado,
          targetLang: targetLangCorto,
          timestamp: new Date().toISOString(),
          isFinal, // Indicar si es resultado final
        });

        // 📡 Enviar a todos los usuarios en el room
        rooms[callID]?.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
          }
        });

        // Log solo para finales (reducir spam en consola)
        if (isFinal) {
          console.log(`[${now()}] ✅ ${userID}: ${texto} → ${traduccion}`.cyan);
        }
      } catch (e) {
        console.error(`[${now()}] ⚠️ Error (${userID}):`, e.message);
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

  console.log(`[${now()}] 🤝 ${userID} → ${callID}`.green);

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
      recognizeStream.write(msg);
    }
  });

  // --- Al cerrar conexión
  ws.on("close", () => {
    console.log(`[${now()}] 🔴 ${userID} desconectado`.gray);

    try {
      userStreams[ws]?.end();
      userStreams[ws]?.destroy();
    } catch (e) {
      console.warn(`[${now()}] ⚠️ Error cerrando stream: ${e.message}`);
    }

    delete userStreams[ws];
    delete userMeta[ws];

    if (rooms[callID]) {
      rooms[callID].delete(ws);
      if (rooms[callID].size === 0) {
        console.log(`[${now()}] 🧹 Room ${callID} cerrado`.yellow);
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