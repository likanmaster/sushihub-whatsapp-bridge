/**
 * SushiHub - WhatsApp Web QR Bridge (Protocolo Multi-Dispositivo Real con Baileys)
 *
 * Permite vincular cualquier teléfono celular (WhatsApp normal o Business)
 * mediante el protocolo oficial de dispositivos vinculados (WhatsApp Web).
 * Compatible con cuentas personales, comerciales y LIDs (Linked Device Identifiers).
 */

import http from "http";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import pino from "pino";

// Directorios y Rutas
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, "auth_info_baileys");

const PORT = process.env.PORT || 3001;

// Archivos de persistencia local
const QUEUE_FILE = path.join(AUTH_DIR, "message_queue.json");
const PROCESSED_IDS_FILE = path.join(AUTH_DIR, "processed_message_ids.json");

// Cargar cola persistente desde disco
function loadQueue() {
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      const data = fs.readFileSync(QUEUE_FILE, "utf-8");
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) {
    console.error("[WhatsApp Bridge] Error cargando cola persistente:", e.message);
  }
  return [];
}

function saveQueue(queue) {
  try {
    if (!fs.existsSync(AUTH_DIR)) {
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    }
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue.slice(-100), null, 2), "utf-8");
  } catch (e) {
    console.error("[WhatsApp Bridge] Error guardando cola persistente:", e.message);
  }
}

// Cargar IDs de mensajes ya procesados para deduplicación
function loadProcessedIds() {
  try {
    if (fs.existsSync(PROCESSED_IDS_FILE)) {
      const data = fs.readFileSync(PROCESSED_IDS_FILE, "utf-8");
      const arr = JSON.parse(data);
      if (Array.isArray(arr)) return new Set(arr);
    }
  } catch (e) {
    console.error("[WhatsApp Bridge] Error cargando IDs procesados:", e.message);
  }
  return new Set();
}

const processedMessageIds = loadProcessedIds();

let saveIdsTimeout = null;
function markMessageProcessed(id) {
  if (!id) return;
  processedMessageIds.add(id);
  if (processedMessageIds.size > 3000) {
    const trimmed = Array.from(processedMessageIds).slice(-2000);
    processedMessageIds.clear();
    trimmed.forEach((x) => processedMessageIds.add(x));
  }
  if (!saveIdsTimeout) {
    saveIdsTimeout = setTimeout(() => {
      saveIdsTimeout = null;
      try {
        if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
        fs.writeFileSync(
          PROCESSED_IDS_FILE,
          JSON.stringify(Array.from(processedMessageIds).slice(-2000)),
          "utf-8"
        );
      } catch (e) {}
    }, 2000);
  }
}

// Cola de mensajes (cargada de disco para no perder nada si el proceso se reinicia)
let messageQueue = loadQueue();

// Mapa de correspondencia entre número limpio / teléfono y su JID real (incluye @lid y @s.whatsapp.net)
const jidMap = new Map();
// Cache en memoria de LIDs resueltos a números reales
const lidPhoneMap = new Map();

// Estado de la sesión en memoria
let sessionState = {
  bridgeOnline: true,
  estado: "desconectado", // "desconectado" | "qr_listo" | "conectado" | "conectando"
  qrString: "",
  telefonoVinculado: "",
  nombreDispositivo: "",
  bateria: 100,
  ultimaConexion: null,
};

let waSocket = null;
let currentAuthState = null;
let reconnectAttempts = 0;
let isInitializing = false;

// Resuelve el número de teléfono real (ej: +56999728992) a partir de cualquier JID o LID
async function resolvePhoneNumber(rawJid, msg = null) {
  if (!rawJid) return "";

  // 1. Si ya termina en @s.whatsapp.net, el usuario es el número de teléfono
  if (rawJid.endsWith("@s.whatsapp.net")) {
    const rawNum = rawJid.split("@")[0].split(":")[0].replace(/\D/g, "");
    if (rawNum && rawNum.length >= 8 && rawNum.length <= 15) {
      return `+${rawNum}`;
    }
  }

  // 2. Si el mensaje trae participant o participantAlt con @s.whatsapp.net
  const altJid = msg?.key?.participantAlt || msg?.key?.participant || msg?.participant;
  if (altJid && typeof altJid === "string" && altJid.endsWith("@s.whatsapp.net")) {
    const altNum = altJid.split("@")[0].split(":")[0].replace(/\D/g, "");
    if (altNum && altNum.length >= 8 && altNum.length <= 15) {
      return `+${altNum}`;
    }
  }

  // 3. Si es un LID (@lid), resolver usando Baileys signalRepository o mapping almacenado
  const isLid = rawJid.endsWith("@lid") || (!rawJid.includes("@") && rawJid.length > 13);
  if (isLid) {
    const lidUser = rawJid.split("@")[0].split(":")[0];

    if (lidPhoneMap.has(lidUser)) {
      return lidPhoneMap.get(lidUser);
    }

    // 3a. Intentar con signalRepository de Baileys
    try {
      if (waSocket?.signalRepository?.lidMapping?.getPNForLID) {
        const fullLid = rawJid.includes("@") ? rawJid : `${rawJid}@lid`;
        const resolved = await waSocket.signalRepository.lidMapping.getPNForLID(fullLid);
        if (resolved) {
          const num = resolved.split("@")[0].split(":")[0].replace(/\D/g, "");
          if (num && num.length >= 8 && num.length <= 15) {
            const formatted = `+${num}`;
            lidPhoneMap.set(lidUser, formatted);
            return formatted;
          }
        }
      }
    } catch (e) {
      // continuar
    }

    // 3b. Intentar con authState keys de Baileys
    try {
      if (currentAuthState?.keys?.get) {
        const stored = await currentAuthState.keys.get("lid-mapping", [`${lidUser}_reverse`]);
        const found = stored?.[`${lidUser}_reverse`];
        if (found) {
          const num = String(found).split("@")[0].split(":")[0].replace(/\D/g, "");
          if (num && num.length >= 8 && num.length <= 15) {
            const formatted = `+${num}`;
            lidPhoneMap.set(lidUser, formatted);
            return formatted;
          }
        }
      }
    } catch (e) {
      // continuar
    }

    // 3c. Leer directamente el archivo de mapping reverso en AUTH_DIR
    try {
      const filePath = path.join(AUTH_DIR, `lid-mapping-${lidUser}_reverse.json`);
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, "utf8");
        const parsed = JSON.parse(content);
        const num = String(parsed).split("@")[0].split(":")[0].replace(/\D/g, "");
        if (num && num.length >= 8 && num.length <= 15) {
          const formatted = `+${num}`;
          lidPhoneMap.set(lidUser, formatted);
          return formatted;
        }
      }
    } catch (e) {
      // continuar
    }
  }

  // 4. Intentar extraer teléfono chileno del texto del mensaje
  if (msg?.message) {
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      "";
    const match = text.match(/(?:\+?56\s?9|9)\s?\d{4}\s?\d{4}/);
    if (match) {
      const clean = match[0].replace(/\D/g, "");
      return clean.startsWith("56") ? `+${clean}` : `+56${clean}`;
    }
  }

  return "";
}

// Caché y resolución de fotos de perfil de contactos de WhatsApp
const profilePicCache = new Map();

async function getProfilePicture(jid, phone = null) {
  if (!waSocket || sessionState.estado !== "conectado") return null;

  const cleanPhone = phone ? phone.replace(/\D/g, "") : "";
  const cacheKey = jid || cleanPhone;
  if (cacheKey && profilePicCache.has(cacheKey)) {
    return profilePicCache.get(cacheKey);
  }

  const candidates = [];
  if (cleanPhone) {
    if (cleanPhone.length === 9 && cleanPhone.startsWith("9")) {
      candidates.push(`56${cleanPhone}@s.whatsapp.net`);
    }
    candidates.push(`${cleanPhone}@s.whatsapp.net`);
  }
  if (jid) candidates.push(jid);

  for (const candidate of candidates) {
    try {
      const url = await waSocket.profilePictureUrl(candidate, "image");
      if (url) {
        if (cacheKey) profilePicCache.set(cacheKey, url);
        if (cleanPhone) profilePicCache.set(cleanPhone, url);
        if (jid) profilePicCache.set(jid, url);
        return url;
      }
    } catch (e) {
      // Ignorar e intentar con siguiente candidato
    }
  }

  for (const candidate of candidates) {
    try {
      const url = await waSocket.profilePictureUrl(candidate, "preview");
      if (url) {
        if (cacheKey) profilePicCache.set(cacheKey, url);
        if (cleanPhone) profilePicCache.set(cleanPhone, url);
        if (jid) profilePicCache.set(jid, url);
        return url;
      }
    } catch (e) {
      // Ignorar
    }
  }

  // Guardar null en caché durante 3 minutos si no tiene foto o es privada
  if (cacheKey) {
    profilePicCache.set(cacheKey, null);
    setTimeout(() => profilePicCache.delete(cacheKey), 3 * 60 * 1000);
  }
  return null;
}

// Resolución de foto de perfil de Facebook
async function resolveFacebookPicture(queryStr) {
  if (!queryStr) return null;
  const trimmed = queryStr.trim();

  // 1. Si ya es una URL directa de imagen de Facebook (CDN) o formato de imagen
  if (trimmed.includes("fbcdn.net") || trimmed.includes("scontent") || trimmed.match(/\.(jpg|jpeg|png|webp)(\?|$)/i)) {
    return trimmed;
  }

  // 2. Extraer URL formateada para versión móvil
  let targetUrl = trimmed;
  if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
    targetUrl = `https://m.facebook.com/${targetUrl}`;
  } else {
    targetUrl = targetUrl
      .replace("://www.facebook.com", "://m.facebook.com")
      .replace("://facebook.com", "://m.facebook.com");
  }

  // 3. Scraping con User-Agent móvil (iPhone Safari) para extraer la etiqueta og:image o fotos scontent
  const mobileUA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1";

  try {
    const res = await fetch(targetUrl, {
      headers: {
        "User-Agent": mobileUA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-User": "?1",
        "Sec-Fetch-Dest": "document"
      },
      redirect: "follow",
      signal: AbortSignal.timeout(5000)
    });

    if (res.ok) {
      const text = await res.text();

      // a. Buscar meta og:image
      const ogMatch = text.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
                      text.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
      if (ogMatch && ogMatch[1]) {
        const ogUrl = ogMatch[1].replace(/&amp;/g, "&");
        if (!ogUrl.includes("rsrc.php") && !ogUrl.includes("favicon") && !ogUrl.includes("static.xx") && (ogUrl.includes("fbcdn.net") || ogUrl.includes("scontent"))) {
          return ogUrl;
        }
      }

      // b. Buscar imágenes scontent en el HTML
      const scontentMatches = text.match(/https:\/\/[^"'\s]*scontent[^"'\s]*\.(?:jpg|png|jpeg)[^"'\s]*/gi);
      if (scontentMatches && scontentMatches.length > 0) {
        for (const match of scontentMatches) {
          const cleanMatch = match.replace(/&amp;/g, "&");
          if (!cleanMatch.includes("rsrc.php") && !cleanMatch.includes("static.xx")) {
            return cleanMatch;
          }
        }
      }

      // c. Si hay entity_id o profile_id
      const idMatch = text.match(/"entity_id":"(\d+)"/) || text.match(/"userID":"(\d+)"/) || text.match(/"profile_id":(\d+)/);
      if (idMatch && idMatch[1]) {
        try {
          const gRes = await fetch(`https://graph.facebook.com/${idMatch[1]}/picture?type=large&redirect=false`, {
            signal: AbortSignal.timeout(3000)
          });
          if (gRes.ok) {
            const gData = await gRes.json();
            if (gData?.data?.url && !gData.data.is_silhouette && !gData.data.url.includes("rsrc.php")) {
              return gData.data.url;
            }
          }
        } catch (e) {}
      }
    }
  } catch (e) {
    // Continuar a fallback
  }

  // 4. Fallback: Graph API directo si es un ID numérico o username público (páginas comerciales)
  const numericMatch = trimmed.match(/(?:profile\.php\?id=|\/people\/[^\/]+\/|^)(\d+)$/i);
  const potentialId = numericMatch ? numericMatch[1] : trimmed.replace(/https?:\/\/(www\.)?facebook\.com\//i, "").replace(/\/.*$/, "").replace(/^@/, "").trim();

  if (potentialId && potentialId.length >= 2) {
    try {
      const gRes = await fetch(`https://graph.facebook.com/${potentialId}/picture?type=large&redirect=false`, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(3000)
      });
      if (gRes.ok) {
        const gData = await gRes.json();
        if (gData?.data?.url && !gData.data.is_silhouette && !gData.data.url.includes("rsrc.php")) {
          return gData.data.url;
        }
      }
    } catch (e) {}
  }

  return null;
}

// Iniciar y gestionar el Socket de WhatsApp Web (Baileys)
async function startWhatsAppSocket() {
  if (isInitializing) return;
  isInitializing = true;

  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }

  try {
    sessionState.estado = "conectando";
    console.log("[WhatsApp Bridge] Conectando a los servidores de WhatsApp...");

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    currentAuthState = state;
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[WhatsApp Bridge] Versión Baileys: ${version.join(".")}, ¿Es última?: ${isLatest}`);

    waSocket = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: true,
      browser: ["SushiHub POS", "Chrome", "1.0.0"],
      generateHighQualityLinkPreview: true,
      syncFullHistory: false,
    });

    waSocket.ev.on("creds.update", saveCreds);

    waSocket.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("---------------------------------------------------------");
        console.log("[WhatsApp Bridge] ¡NUEVO CÓDIGO QR REAL RECIBIDO!");
        console.log("Escanéalo en pantalla o en esta consola.");
        console.log("---------------------------------------------------------");
        sessionState.estado = "qr_listo";
        sessionState.qrString = qr;
        sessionState.ultimaConexion = new Date().toISOString();
      }

      if (connection === "open") {
        reconnectAttempts = 0;
        const jid = waSocket.user?.id || "";
        const rawPhone = jid.split(":")[0] || jid.split("@")[0];
        const formattedPhone = rawPhone ? `+${rawPhone}` : "Teléfono Vinculado";
        const deviceName = waSocket.user?.name || "WhatsApp en Celular";

        sessionState.estado = "conectado";
        sessionState.qrString = "";
        sessionState.telefonoVinculado = formattedPhone;
        sessionState.nombreDispositivo = deviceName;
        sessionState.ultimaConexion = new Date().toISOString();

        console.log("=========================================================");
        console.log(`[WhatsApp Bridge] ✅ ¡WHATSAPP VINCULADO CON ÉXITO!`);
        console.log(`  Teléfono: ${formattedPhone}`);
        console.log(`  Nombre:   ${deviceName}`);
        console.log(`  Listo para recibir y responder pedidos.`);
        console.log("=========================================================");
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(
          `[WhatsApp Bridge] Conexión cerrada. Código: ${statusCode}, ¿Reconectar?: ${shouldReconnect}`
        );

        if (statusCode === DisconnectReason.loggedOut) {
          console.log("[WhatsApp Bridge] Sesión desvinculada por el usuario.");
          sessionState.estado = "desconectado";
          sessionState.qrString = "";
          sessionState.telefonoVinculado = "";
          sessionState.nombreDispositivo = "";

          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          } catch (e) {
            console.error("Error limpiando carpeta de auth:", e);
          }
        } else if (shouldReconnect) {
          reconnectAttempts++;
          const waitTime = Math.min(reconnectAttempts * 2000, 10000);
          console.log(`[WhatsApp Bridge] Reintentando conexión en ${waitTime / 1000}s...`);
          setTimeout(() => {
            isInitializing = false;
            startWhatsAppSocket();
          }, waitTime);
        }
      }
    });

    // Función unificada para procesar mensajes entrantes (en vivo y recuperados offline)
    const processIncomingMessage = async (msg, originType = "notify") => {
      if (!msg || !msg.key) return;
      // Ignorar mensajes enviados por nosotros o estados
      if (msg.key.fromMe) return;
      if (msg.key.remoteJid === "status@broadcast") return;
      if (!msg.message) return;

      const msgId = msg.key.id;
      if (msgId && processedMessageIds.has(msgId)) {
        return; // Ya procesado, evitar duplicados
      }

      // Manejar reacciones a mensajes entrantes (❤️, 👍, 😂, etc.)
      if (msg.message.reactionMessage) {
        const react = msg.message.reactionMessage;
        const targetMsgId = react.key?.id;
        const emoji = react.text || "";
        const rawJid = msg.key.remoteJid || "";
        const realPhone = await resolvePhoneNumber(rawJid, msg);
        const cleanPhone = realPhone ? realPhone.replace(/\D/g, "") : "";
        const cleanLid = rawJid.replace(/@.+/, "").replace(/\D/g, "");
        const senderName = msg.pushName || (realPhone ? `Cliente WhatsApp (${realPhone})` : "Cliente WhatsApp");

        console.log(`---------------------------------------------------------`);
        console.log(`[WhatsApp Bridge] ❤️ REACCIÓN RECIBIDA: "${emoji || "QUITADA"}" en mensaje ${targetMsgId}`);
        console.log(`  De:       ${senderName}`);
        console.log(`---------------------------------------------------------`);

        if (msgId) markMessageProcessed(msgId);

        messageQueue.push({
          tipo: "reaccion",
          msgId: msgId || "",
          targetMsgId: targetMsgId || "",
          emoji: emoji,
          jid: rawJid,
          remitenteId: cleanPhone || cleanLid || rawJid,
          nombreCliente: senderName,
          telefono: realPhone || "",
          fecha: new Date().toISOString(),
        });

        if (messageQueue.length > 100) {
          messageQueue.shift();
        }
        saveQueue(messageQueue);
        return;
      }

      // Antigüedad del mensaje: si es mayor a 48 horas, ignorarlo (evita volcar historiales antiguos)
      const rawTimestamp =
        typeof msg.messageTimestamp === "number"
          ? msg.messageTimestamp
          : msg.messageTimestamp?.low || msg.messageTimestamp?.high || 0;

      const msgDate = rawTimestamp > 0 ? new Date(rawTimestamp * 1000) : new Date();
      const ageHours = (Date.now() - msgDate.getTime()) / (1000 * 60 * 60);
      if (ageHours > 48) {
        if (msgId) markMessageProcessed(msgId);
        return;
      }

      // Extraer texto del mensaje
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.documentMessage?.caption ||
        msg.message.videoMessage?.caption ||
        "";

      if (!text.trim()) return;

      if (msgId) markMessageProcessed(msgId);

      const rawJid = msg.key.remoteJid || "";
      const realPhone = await resolvePhoneNumber(rawJid, msg);
      const cleanPhone = realPhone ? realPhone.replace(/\D/g, "") : "";
      const cleanLid = rawJid.replace(/@.+/, "").replace(/\D/g, "");

      const senderName = msg.pushName || (realPhone ? `Cliente WhatsApp (${realPhone})` : "Cliente WhatsApp");

      // Registrar en el mapa de JIDs para que responder siempre apunte al chat exacto
      jidMap.set(rawJid, rawJid);
      if (cleanLid) jidMap.set(cleanLid, rawJid);
      if (cleanPhone) {
        jidMap.set(cleanPhone, rawJid);
        jidMap.set(`+${cleanPhone}`, rawJid);
      }
      if (msg.key.participant) {
        const participantClean = msg.key.participant.replace(/@.+/, "").replace(/\D/g, "");
        jidMap.set(msg.key.participant, rawJid);
        if (participantClean) jidMap.set(participantClean, rawJid);
      }

      const fotoPerfil = await getProfilePicture(rawJid, realPhone);
      const isOffline = originType === "append" || originType === "history";

      console.log(`---------------------------------------------------------`);
      console.log(`[WhatsApp Bridge] 💬 MENSAJE RECIBIDO (${isOffline ? "RECUPERADO OFFLINE / RECONEXIÓN" : "EN VIVO"}):`);
      console.log(`  De:       ${senderName}`);
      console.log(`  Teléfono: ${realPhone || "(No disponible)"}`);
      console.log(`  Foto:     ${fotoPerfil ? "✅ Disponible" : "❌ Sin foto / Privada"}`);
      console.log(`  Fecha:    ${msgDate.toLocaleString()}`);
      console.log(`  Texto:    "${text}"`);
      console.log(`---------------------------------------------------------`);

      messageQueue.push({
        msgId: msgId || "",
        jid: rawJid,
        remitenteId: cleanPhone || cleanLid || rawJid,
        nombreCliente: senderName,
        mensaje: text,
        telefono: realPhone || "",
        fotoPerfil: fotoPerfil || "",
        fecha: msgDate.toISOString(),
      });

      if (messageQueue.length > 100) {
        messageQueue.shift();
      }
      saveQueue(messageQueue);
    };

    // 1. Escuchar mensajes entrantes (tanto en vivo "notify" como recuperados al reconectar "append")
    waSocket.ev.on("messages.upsert", async ({ messages, type }) => {
      // Baileys usa "notify" para mensajes en tiempo real y "append" para mensajes acumulados offline
      for (const msg of messages) {
        await processIncomingMessage(msg, type);
      }
    });

    // 2. Escuchar sincronización de historial cuando el celular o puente se reconectan
    waSocket.ev.on("messaging-history.set", async ({ messages }) => {
      if (Array.isArray(messages) && messages.length > 0) {
        console.log(`[WhatsApp Bridge] 🔄 Sincronizando ${messages.length} mensaje(s) recibidos del historial/offline...`);
        for (const msg of messages) {
          await processIncomingMessage(msg, "history");
        }
      }
    });
  } catch (err) {
    console.error("[WhatsApp Bridge] Error inicializando socket:", err);
    sessionState.estado = "desconectado";
  } finally {
    isInitializing = false;
  }
}

// Servidor HTTP Local para comunicarse con el Frontend React de SushiHub
const server = http.createServer(async (req, res) => {
  // CORS & Private Network Access (PNA) Headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Access-Control-Request-Private-Network");
  res.setHeader("Access-Control-Allow-Private-Network", "true");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url || "/";

  // Endpoint: GET /status
  if (req.method === "GET" && url.startsWith("/status")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ...sessionState,
        pendingCount: messageQueue.length,
      })
    );
    return;
  }

  // Endpoint: GET /messages (devuelve mensajes en cola y los vacía)
  if (req.method === "GET" && url.startsWith("/messages")) {
    const messages = messageQueue.splice(0);
    saveQueue(messageQueue);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ messages }));
    return;
  }

  // Endpoint: GET /resolve-phone?jid=...
  if (req.method === "GET" && url.startsWith("/resolve-phone")) {
    const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const jidParam = urlObj.searchParams.get("jid") || urlObj.searchParams.get("phone") || "";
    try {
      const phone = await resolvePhoneNumber(jidParam);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, jid: jidParam, phone }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // Endpoint: GET /profile-picture?jid=...&phone=...
  if (req.method === "GET" && url.startsWith("/profile-picture")) {
    const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const jidParam = urlObj.searchParams.get("jid") || "";
    const phoneParam = urlObj.searchParams.get("phone") || "";

    try {
      const url = await getProfilePicture(jidParam, phoneParam);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, url: url || null }));
    } catch (err) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, url: null, error: err.message }));
    }
    return;
  }

  // Endpoint: GET /facebook-picture?query=...
  if (req.method === "GET" && url.startsWith("/facebook-picture")) {
    const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const queryParam = urlObj.searchParams.get("query") || urlObj.searchParams.get("id") || "";

    try {
      const pictureUrl = await resolveFacebookPicture(queryParam);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: !!pictureUrl, url: pictureUrl }));
    } catch (err) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, url: null, error: err.message }));
    }
    return;
  }

  // Endpoint: GET /qr
  if (req.method === "GET" && url.startsWith("/qr")) {
    if (sessionState.estado === "desconectado" && !waSocket) {
      startWhatsAppSocket();
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        estado: sessionState.estado,
        qrString: sessionState.qrString,
        telefonoVinculado: sessionState.telefonoVinculado,
      })
    );
    return;
  }

  // Endpoint: POST /logout
  if (req.method === "POST" && url.startsWith("/logout")) {
    try {
      if (waSocket) {
        await waSocket.logout().catch(() => {});
        waSocket.end();
        waSocket = null;
      }
      sessionState.estado = "desconectado";
      sessionState.qrString = "";
      sessionState.telefonoVinculado = "";
      sessionState.nombreDispositivo = "";

      try {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      } catch (e) {}

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, message: "Sesión cerrada correctamente" }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // Endpoint: POST /send-message (para responder directamente al cliente)
  if (req.method === "POST" && url.startsWith("/send-message")) {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const { to, jid, text, image, caption } = payload;

        if ((!to && !jid) || (!text && !image)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: "Faltan campos 'to'/'jid' o contenido ('text'/'image')" }));
          return;
        }

        if (!waSocket || sessionState.estado !== "conectado") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: "WhatsApp no está vinculado actualmente" }));
          return;
        }

        // Resolución precisa del JID real del destinatario
        let targetJid = jid || to;

        // Si es un número sin dominio (@lid o @s.whatsapp.net), buscar en jidMap
        if (!targetJid.includes("@")) {
          const clean = targetJid.replace(/\D/g, "");
          if (jidMap.has(clean)) {
            targetJid = jidMap.get(clean);
          } else if (jidMap.has(targetJid)) {
            targetJid = jidMap.get(targetJid);
          } else {
            targetJid = `${clean}@s.whatsapp.net`;
          }
        }

        if (image) {
          let imgBuffer = null;
          let isUrl = false;

          if (typeof image === "string" && image.startsWith("data:")) {
            const base64Data = image.split(",")[1] || image;
            imgBuffer = Buffer.from(base64Data, "base64");
          } else if (typeof image === "string" && (image.startsWith("http://") || image.startsWith("https://"))) {
            isUrl = true;
          } else if (typeof image === "string") {
            imgBuffer = Buffer.from(image, "base64");
          }

          const captionText = text || caption || "";
          console.log(`[WhatsApp Bridge] 📤 Enviando imagen a JID real: "${targetJid}" (caption: "${captionText}")`);

          if (imgBuffer) {
            await waSocket.sendMessage(targetJid, {
              image: imgBuffer,
              caption: captionText,
            });
          } else if (isUrl) {
            await waSocket.sendMessage(targetJid, {
              image: { url: image },
              caption: captionText,
            });
          }
          console.log(`[WhatsApp Bridge] ✅ Imagen entregada exitosamente al socket de WhatsApp`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, targetJid, type: "image", caption: captionText }));
        } else {
          console.log(`[WhatsApp Bridge] 📤 Enviando mensaje a JID real: "${targetJid}": "${text}"`);
          await waSocket.sendMessage(targetJid, { text });
          console.log(`[WhatsApp Bridge] ✅ Mensaje entregado exitosamente al socket de WhatsApp`);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, targetJid, text, type: "text" }));
        }
      } catch (err) {
        console.error("[WhatsApp Bridge] Error enviando mensaje:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // Endpoint: POST /react-message (para enviar reacciones con emojis a WhatsApp: ❤️, 👍, 😂, etc.)
  if (req.method === "POST" && url.startsWith("/react-message")) {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const { to, jid, msgId, emoji } = payload;

        if (!waSocket || sessionState.estado !== "conectado") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: "WhatsApp no está conectado actualmente" }));
          return;
        }

        let targetJid = jid || to;
        if (!targetJid.includes("@")) {
          const clean = targetJid.replace(/\D/g, "");
          if (jidMap.has(clean)) {
            targetJid = jidMap.get(clean);
          } else if (jidMap.has(targetJid)) {
            targetJid = jidMap.get(targetJid);
          } else {
            targetJid = `${clean}@s.whatsapp.net`;
          }
        }

        console.log(`[WhatsApp Bridge] ❤️ Enviando reacción "${emoji || "(quitar)"}" a mensaje "${msgId || "sin-id"}" en "${targetJid}"`);

        if (msgId) {
          await waSocket.sendMessage(targetJid, {
            react: {
              text: emoji || "", // Si emoji es "" elimina la reacción en WhatsApp
              key: {
                remoteJid: targetJid,
                fromMe: false, // Reaccionar al mensaje recibido del cliente
                id: msgId,
              },
            },
          });
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, targetJid, emoji }));
      } catch (err) {
        console.error("[WhatsApp Bridge] Error enviando reacción:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // Ruta genérica
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      app: "SushiHub WhatsApp Multi-Device Bridge",
      version: "2.1.0",
      estado: sessionState.estado,
      telefonoVinculado: sessionState.telefonoVinculado,
    })
  );
});

// Iniciar servidor HTTP
server.listen(PORT, "0.0.0.0", () => {
  console.log("=========================================================");
  console.log("  🍣 SushiHub - WhatsApp Web Bridge (Multi-Dispositivo)");
  console.log(`  Servicio activo en puerto: ${PORT} (0.0.0.0)`);
  console.log(`  Directorio de autenticacion: ${AUTH_DIR}`);
  console.log("  Cargando sesión de WhatsApp...");
  console.log("=========================================================");
  startWhatsAppSocket();
});
