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
    'pt': 'PT-BR',
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

// --- Estructuras de conexión (NUEVAS)
const rooms = {}; // callID -> Set<userID>
const userConnections = {}; // userID -> { ws, callID, sourceLang, targetLang, stream, lastText, lastTimestamp }
const callParticipants = {}; // callID -> Map<userID, { sourceLang, targetLang }>

// Mantener conexión viva
setInterval(() => {
  wss.clients.forEach((c) => c.readyState === WebSocket.OPEN && c.ping());
}, 25000);

// --- Crear stream de reconocimiento POR USUARIO (NO compartido)
function createUserStream(userID, callID, sourceLang, targetLang, ws) {
  console.log(`[${now()}] 🎙️ Creando stream individual para ${userID}`.yellow);
  
  const sourceLangNormalizado = normalizarCodigoIdioma(sourceLang);
  console.log(`[${now()}]    - Idioma STT: ${sourceLangNormalizado}`);

  const recognizeStream = clientSTT
    .streamingRecognize({
      config: {
        encoding: "LINEAR16",
        sampleRateHertz: 16000,
        languageCode: sourceLangNormalizado,
        enableAutomaticPunctuation: true,
        model: "default",
      },
      interimResults: false, // ✅ SOLO RESULTADOS FINALES (evita duplicados)
    })
    .on("error", (err) => {
      console.error(`[${now()}] ❌ Error STT para ${userID}:`, err.message);
      
      // ✅ MEJORADO: Solo recrear si el error es recuperable
      const userData = userConnections[userID];
      if (userData && userData.ws.readyState === WebSocket.OPEN) {
        // Verificar si es un error recuperable
        const isRecoverableError = 
          err.message.includes('Timeout') || 
          err.message.includes('network') ||
          err.message.includes('UNAVAILABLE');
        
        if (isRecoverableError) {
          console.log(`[${now()}] 🔄 Recreando stream para ${userID} (error recuperable)...`);
          setTimeout(() => {
            if (userConnections[userID]) {
              try {
                const newStream = createUserStream(
                  userID, 
                  callID, 
                  sourceLang, 
                  targetLang, 
                  ws
                );
                userConnections[userID].stream = newStream;
                console.log(`[${now()}] ✅ Stream recreado para ${userID}`);
              } catch (e) {
                console.error(`[${now()}] ❌ No se pudo recrear stream: ${e.message}`);
              }
            }
          }, 2000);
        }
      }
    })
    .on("end", () => {
      console.log(`[${now()}] ⚠️ Stream STT terminó para ${userID}`.yellow);
    })
    .on("data", async (data) => {
      const texto = data.results[0]?.alternatives[0]?.transcript || "";
      if (!texto || texto.trim().length === 0) return;

      const userData = userConnections[userID];
      if (!userData) return;

      // ✅ DEDUPLICACIÓN: Evitar procesar el mismo texto múltiples veces
      const ahora = Date.now();
      if (userData.lastText === texto && (ahora - userData.lastTimestamp) < 3000) {
        console.log(`[${now()}] ⏭️ Texto duplicado ignorado de ${userID}: "${texto}"`);
        return;
      }

      // Actualizar último texto procesado
      userData.lastText = texto;
      userData.lastTimestamp = ahora;

      console.log(`[${now()}] 🗣️ ${userID}: ${texto}`.cyan);

      // ✅ Traducir y enviar a TODOS los usuarios (incluyendo el emisor para UI)
      const participants = callParticipants[callID];
      if (!participants) return;

      for (const [recipientUserID, recipientConfig] of participants) {
        const recipientConnection = userConnections[recipientUserID];
        if (!recipientConnection || recipientConnection.ws.readyState !== WebSocket.OPEN) {
          continue;
        }

        try {
          // Traducir al idioma del destinatario
          const targetLangCorto = extraerCodigoCorto(recipientConfig.targetLang);
          const [traduccion] = await clientTranslate.translate(texto, targetLangCorto);

          const payload = JSON.stringify({
            userID: userID, // Quien habló
            texto_original: texto,
            traduccion: traduccion,
            sourceLang: sourceLangNormalizado,
            targetLang: targetLangCorto,
            timestamp: new Date().toISOString(),
            isSelf: recipientUserID === userID, // ✅ NUEVA BANDERA
          });

          // ✅ Enviar a TODOS (incluido el emisor)
          recipientConnection.ws.send(payload);

          if (recipientUserID === userID) {
            console.log(`[${now()}] 📤 Transcripción enviada al emisor (para UI)`.gray);
          } else {
            console.log(`[${now()}] 🌍 Traducción enviada a ${recipientUserID} (${sourceLangNormalizado}→${targetLangCorto}): ${traduccion}`.green);
          }
        } catch (e) {
          console.error(`[${now()}] ⚠️ Error traduciendo para ${recipientUserID}:`, e.message);
        }
      }
    });

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
  console.log(`[${now()}]    - Idioma origen: ${sourceLang}`);
  console.log(`[${now()}]    - Idioma destino: ${targetLang}`);

  // ✅ Inicializar room si no existe
  if (!rooms[callID]) {
    rooms[callID] = new Set();
    callParticipants[callID] = new Map();
  }

  // ✅ Agregar usuario al room
  rooms[callID].add(userID);
  callParticipants[callID].set(userID, { sourceLang, targetLang });
  console.log(`[${now()}]    - Usuarios en room: ${rooms[callID].size}`);

  // ✅ Crear stream individual para este usuario
  const stream = createUserStream(userID, callID, sourceLang, targetLang, ws);

  // ✅ Guardar conexión del usuario
  userConnections[userID] = {
    ws,
    callID,
    sourceLang,
    targetLang,
    stream,
    lastText: "",
    lastTimestamp: 0,
  };

  // ✅ Manejar audio entrante con validación
  ws.on("message", (msg) => {
    if (Buffer.isBuffer(msg)) {
      const userData = userConnections[userID];
      if (!userData) {
        console.warn(`[${now()}] ⚠️ Audio recibido pero usuario ${userID} no existe`);
        return;
      }

      const stream = userData.stream;
      if (stream && stream.writable && !stream.destroyed) {
        try {
          stream.write(msg);
        } catch (e) {
          console.warn(`[${now()}] ⚠️ Error escribiendo audio para ${userID}: ${e.message}`);
          // Intentar recrear stream
          try {
            const newStream = createUserStream(userID, callID, userData.sourceLang, userData.targetLang, ws);
            userData.stream = newStream;
            console.log(`[${now()}] 🔄 Stream recreado automáticamente para ${userID}`);
          } catch (err) {
            console.error(`[${now()}] ❌ No se pudo recrear stream: ${err.message}`);
          }
        }
      } else {
        console.warn(`[${now()}] ⚠️ Stream no disponible para ${userID}, recreando...`);
        try {
          const newStream = createUserStream(userID, callID, userData.sourceLang, userData.targetLang, ws);
          userData.stream = newStream;
        } catch (err) {
          console.error(`[${now()}] ❌ Error recreando stream: ${err.message}`);
        }
      }
    }
  });

  // ✅ Al cerrar conexión
  ws.on("close", () => {
    console.log(`[${now()}] 🔴 ${userID} desconectado`.gray);

    const userData = userConnections[userID];
    if (userData) {
      // Cerrar stream del usuario
      try {
        if (userData.stream && !userData.stream.destroyed) {
          userData.stream.end();
          userData.stream.destroy();
        }
      } catch (e) {
        console.warn(`[${now()}] ⚠️ Error cerrando stream de ${userID}: ${e.message}`);
      }

      // Eliminar del room
      if (rooms[userData.callID]) {
        rooms[userData.callID].delete(userID);
        callParticipants[userData.callID]?.delete(userID);
        
        console.log(`[${now()}]    - Usuarios restantes en room: ${rooms[userData.callID].size}`);

        // Si el room queda vacío, limpiar
        if (rooms[userData.callID].size === 0) {
          console.log(`[${now()}] 🧹 Room ${userData.callID} vacío, limpiando`.yellow);
          delete rooms[userData.callID];
          delete callParticipants[userData.callID];
        }
      }

      // Eliminar conexión del usuario
      delete userConnections[userID];
    }
  });

  ws.on("error", (err) => {
    console.error(`[${now()}] ⚠️ WS error (${userID}): ${err.message}`);
  });
});

// --- Endpoint de salud
app.get("/health", (req, res) => {
  res.json({ 
    ok: true, 
    time: new Date().toISOString(),
    activeRooms: Object.keys(rooms).length,
    activeUsers: Object.keys(userConnections).length,
  });
});

// --- Endpoint para debug
app.get("/debug", (req, res) => {
  const roomsInfo = {};
  for (const [callID, users] of Object.entries(rooms)) {
    roomsInfo[callID] = Array.from(users);
  }
  
  res.json({
    rooms: roomsInfo,
    activeConnections: Object.keys(userConnections).length,
  });
});