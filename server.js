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

if (process.env.GOOGLE_KEY_JSON) {
  const keyPath = path.join(__dirname, "google-key-from-env.json");
  fs.writeFileSync(keyPath, process.env.GOOGLE_KEY_JSON, { encoding: "utf8" });
  process.env.GOOGLE_KEY_PATH = keyPath;
  console.log(`[${now()}] 🔐 GOOGLE_KEY_JSON escrita a ${keyPath}`);
}

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

function extraerCodigoCorto(codigo) {
  if (!codigo) return 'en';
  if (codigo.includes('-')) {
    return codigo.split('-')[0];
  }
  return codigo;
}

const app = express();
app.use(express.json());
app.use(cors());

const PORT = Number(process.env.PORT || 3000);
const keyFilename = process.env.GOOGLE_KEY_PATH || undefined;

const clientSTT = new SpeechClient({ keyFilename });
const clientTranslate = new Translate({ keyFilename });

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
server.listen(PORT, () => {
  console.log(`✅ Servidor HTTP en puerto ${PORT}`.green);
  console.log("🚀 Esperando conexiones WebSocket...\n".yellow);
});

const rooms = {};
const userMeta = {};
const userStreams = {}; // ws -> { stream, lastAudioTime, isRestarting, inactivityTimer }

setInterval(() => {
  wss.clients.forEach((c) => c.readyState === WebSocket.OPEN && c.ping());
}, 25000);

function createRecognizeStream(ws, { callID, userID, sourceLang, targetLang }) {
  const sourceLangNormalizado = normalizarCodigoIdioma(sourceLang);
  const targetLangCorto = extraerCodigoCorto(targetLang);

  console.log(`[${now()}] 🎙️ STT: ${userID} (${sourceLang} → ${targetLang})`.yellow);

  let ultimoTextoProcesado = "";
  let ultimoTimestamp = Date.now();

  const recognizeStream = clientSTT
    .streamingRecognize({
      config: {
        encoding: "LINEAR16",
        sampleRateHertz: 16000,
        languageCode: sourceLangNormalizado,
        enableAutomaticPunctuation: true,
        useEnhanced: true,
        model: 'latest_short',
      },
      interimResults: true,
    })
    .on("error", (err) => {
      console.error(`[${now()}] ❌ Error STT (${userID}):`, err.message);
      
      // 🔥 RECREAR STREAM SI HAY TIMEOUT
      if ((err.message.includes("Audio Timeout") || err.message.includes("duration elapsed")) 
          && userStreams[ws] && !userStreams[ws].isRestarting) {
        
        console.log(`[${now()}] 🔄 Timeout detectado, recreando stream para ${userID}...`.yellow);
        userStreams[ws].isRestarting = true;
        
        // Limpiar stream viejo
        try {
          recognizeStream.removeAllListeners();
          recognizeStream.end();
          recognizeStream.destroy();
        } catch (e) {}
        
        // Crear nuevo stream después de un delay
        setTimeout(() => {
          if (userMeta[ws] && userStreams[ws]) {
            const newStream = createRecognizeStream(ws, userMeta[ws]);
            userStreams[ws].stream = newStream;
            userStreams[ws].isRestarting = false;
            userStreams[ws].lastAudioTime = Date.now();
            console.log(`[${now()}] ✅ Stream recreado para ${userID}`.green);
          }
        }, 1000);
      }
    })
    .on("data", async (data) => {
      try {
        const result = data.results[0];
        if (!result) return;

        const texto = result.alternatives[0]?.transcript || "";
        if (!texto) return;

        const isFinal = result.isFinal;
        
        // Actualizar timestamp
        if (userStreams[ws]) {
          userStreams[ws].lastAudioTime = Date.now();
        }
        
        const ahora = Date.now();
        const tiempoDesdeUltimo = ahora - ultimoTimestamp;
        
        if (!isFinal && tiempoDesdeUltimo < 800) {
          return;
        }

        if (texto === ultimoTextoProcesado && tiempoDesdeUltimo < 1500) {
          return;
        }

        ultimoTextoProcesado = texto;
        ultimoTimestamp = ahora;

        const [traduccion] = await clientTranslate.translate(texto, targetLangCorto);

        const payload = JSON.stringify({
          userID,
          texto_original: texto,
          traduccion,
          sourceLang: sourceLangNormalizado,
          targetLang: targetLangCorto,
          timestamp: new Date().toISOString(),
          isFinal,
        });

        rooms[callID]?.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
          }
        });

        if (isFinal) {
          console.log(`[${now()}] ✅ ${userID}: ${texto} → ${traduccion}`.cyan);
        }
      } catch (e) {
        console.error(`[${now()}] ⚠️ Error (${userID}):`, e.message);
      }
    })
    .on("end", () => {
      console.log(`[${now()}] 🔚 Stream ended para ${userID}`.gray);
    });

  // Guardar stream
  if (!userStreams[ws]) {
    userStreams[ws] = {
      stream: recognizeStream,
      lastAudioTime: Date.now(),
      isRestarting: false,
      inactivityTimer: null
    };
  } else {
    userStreams[ws].stream = recognizeStream;
    userStreams[ws].isRestarting = false;
  }

  // 🔥 MONITOREO PREVENTIVO DE INACTIVIDAD
  // Limpiar timer previo si existe
  if (userStreams[ws].inactivityTimer) {
    clearInterval(userStreams[ws].inactivityTimer);
  }

  userStreams[ws].inactivityTimer = setInterval(() => {
    if (!userStreams[ws] || !userMeta[ws] || userStreams[ws].isRestarting) {
      return;
    }

    const timeSinceLastAudio = Date.now() - userStreams[ws].lastAudioTime;
    
    // Si han pasado más de 20 segundos sin audio, recrear preventivamente
    if (timeSinceLastAudio > 20000) {
      console.log(`[${now()}] ⏰ Inactividad ${Math.floor(timeSinceLastAudio/1000)}s para ${userID}, recreando...`.yellow);
      
      userStreams[ws].isRestarting = true;
      
      try {
        recognizeStream.removeAllListeners();
        recognizeStream.end();
        recognizeStream.destroy();
      } catch (e) {}
      
      setTimeout(() => {
        if (userMeta[ws] && userStreams[ws]) {
          const newStream = createRecognizeStream(ws, userMeta[ws]);
          console.log(`[${now()}] ♻️ Stream preventivo creado para ${userID}`.green);
        }
      }, 500);
    }
  }, 8000); // Revisar cada 8 segundos

  return recognizeStream;
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `https://${req.headers.host}`);

  const callID = url.searchParams.get("callID") || "default";
  const userID = url.searchParams.get("userID") || `u_${Date.now()}`;
  const sourceLang = url.searchParams.get("sourceLang") || "es";
  const targetLang = url.searchParams.get("targetLang") || "en";

  console.log(`[${now()}] 🤝 ${userID} → ${callID}`.green);

  if (!rooms[callID]) rooms[callID] = new Set();
  rooms[callID].add(ws);

  userMeta[ws] = { callID, userID, sourceLang, targetLang };

  createRecognizeStream(ws, userMeta[ws]);

  ws.on("message", (msg) => {
    if (Buffer.isBuffer(msg)) {
      // 🔥 CRITICAL: Solo escribir si el stream NO está reiniciándose
      if (userStreams[ws] && !userStreams[ws].isRestarting) {
        userStreams[ws].lastAudioTime = Date.now();
        
        try {
          const stream = userStreams[ws].stream;
          // Verificar que el stream existe, no está destruido y no está ended
          if (stream && !stream.destroyed && stream.writable) {
            stream.write(msg);
          }
        } catch (e) {
          // Silenciar errores de escritura durante transición
          if (!e.message.includes("write after end")) {
            console.error(`[${now()}] ⚠️ Error escribiendo (${userID}):`, e.message);
          }
        }
      }
      // Si está reiniciándose, simplemente descartar el audio
    }
  });

  ws.on("close", () => {
    console.log(`[${now()}] 🔴 ${userID} desconectado`.gray);

    // Limpiar timer de inactividad
    if (userStreams[ws] && userStreams[ws].inactivityTimer) {
      clearInterval(userStreams[ws].inactivityTimer);
    }

    try {
      if (userStreams[ws]) {
        userStreams[ws].stream?.removeAllListeners();
        userStreams[ws].stream?.end();
        userStreams[ws].stream?.destroy();
      }
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

app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});