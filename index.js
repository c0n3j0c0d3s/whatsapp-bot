require("dotenv").config();
const { Client, LocalAuth } = require("whatsapp-web.js");
const { google } = require("googleapis");
const Database = require("better-sqlite3");
const cron = require("node-cron");
const qrcode = require("qrcode");
const fs = require("fs");

// ─── CONFIG ────────────────────────────────────────────────────────────────
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME;
const APPROVER_NUMBER = process.env.APPROVER_NUMBER;
const MY_NUMBER = process.env.MY_NUMBER;

// ─── BASE DE DATOS SQLITE ──────────────────────────────────────────────────
const db = new Database("bot_data.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS token_counter (
    id INTEGER PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS pending_transactions (
    token TEXT PRIMARY KEY,
    fecha TEXT NOT NULL,
    tipo TEXT NOT NULL,
    cantidad REAL NOT NULL,
    factura_amt REAL NOT NULL DEFAULT 0,
    comentarios TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

const counterRow = db
  .prepare("SELECT value FROM token_counter WHERE id = 1")
  .get();
if (!counterRow) {
  db.prepare("INSERT INTO token_counter (id, value) VALUES (1, 1)").run();
}

function getNextToken() {
  const row = db.prepare("SELECT value FROM token_counter WHERE id = 1").get();
  const token = String(row.value).padStart(6, "0");
  db.prepare("UPDATE token_counter SET value = value + 1 WHERE id = 1").run();
  return token;
}

function savePendingTx(token, tx) {
  db.prepare(`
    INSERT INTO pending_transactions
      (token, fecha, tipo, cantidad, factura_amt, comentarios, chat_id, created_at)
    VALUES
      (@token, @fecha, @tipo, @cantidad, @factura_amt, @comentarios, @chat_id, @created_at)
  `).run({
    token,
    fecha: tx.fecha,
    tipo: tx.tipo,
    cantidad: tx.cantidad,
    factura_amt: tx.facturaAmt,
    comentarios: tx.comentarios,
    chat_id: tx.chatId,
    created_at: new Date().toISOString(),
  });
}

function getPendingTx(token) {
  const row = db
    .prepare("SELECT * FROM pending_transactions WHERE token = ?")
    .get(token);
  if (!row) return null;
  return {
    fecha: row.fecha,
    tipo: row.tipo,
    cantidad: row.cantidad,
    facturaAmt: row.factura_amt,
    comentarios: row.comentarios,
    chatId: row.chat_id,
    createdAt: row.created_at,
  };
}

function deletePendingTx(token) {
  db.prepare("DELETE FROM pending_transactions WHERE token = ?").run(token);
}

function getAllPendingTx() {
  return db
    .prepare("SELECT * FROM pending_transactions ORDER BY created_at ASC")
    .all();
}

// ─── GOOGLE SHEETS ─────────────────────────────────────────────────────────
const auth = new google.auth.GoogleAuth({
  keyFile: "credentials.json",
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

async function getSheetsClient() {
  const client = await auth.getClient();
  return google.sheets({ version: "v4", auth: client });
}

async function getBalance() {
  try {
    const sheets = await getSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!G2`,
    });
    const val = res.data.values?.[0]?.[0];
    if (!val) return 0;
    return parseFloat(val.toString().replace(/[$,]/g, "")) || 0;
  } catch (err) {
    console.error("❌ Error al leer balance:", err.message);
    return 0;
  }
}

async function appendRow(fecha, tipo, cantidad, factura, comentarios) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:E`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[fecha, tipo, cantidad, factura, comentarios]] },
  });
}

// ─── HELPERS ───────────────────────────────────────────────────────────────
function parseMonto(str) {
  return parseFloat(str.replace(/,/g, ""));
}

function formatMoney(num) {
  return Number(num).toLocaleString("es-MX", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function tipoEmoji(tipo) {
  if (tipo === "ingreso") return "📥";
  if (tipo === "egreso") return "📤";
  if (tipo === "factura") return "🧾";
  return "📄";
}

function parseCommand(text) {
  const regex =
    /^\/(\d{1,2}\/\d{1,2})\s+(ingreso|egreso|factura)\s+([\d,]+)\s+(.+)$/i;
  const match = text.trim().match(regex);
  if (!match) return null;
  return {
    fecha: match[1],
    tipo: match[2].toLowerCase(),
    cantidad: parseMonto(match[3]),
    comentarios: match[4].trim(),
  };
}

function formatTimeSince(isoString) {
  const created = new Date(isoString);
  const now = new Date();
  const diffMs = now - created;
  const diffHrs = Math.floor(diffMs / (1000 * 60 * 60));
  const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  if (diffHrs > 0) return `${diffHrs}h ${diffMins}m`;
  return `${diffMins}m`;
}

// ─── BOT ───────────────────────────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: "auth_info" }),
  puppeteer: {
    headless: true,
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

client.on("qr", async (qr) => {
  await qrcode.toFile("qr.png", qr);
  console.log("📱 QR generado. Abre qr.png y escanéalo con WhatsApp.");
});

client.on("ready", () => {
  console.log("✅ Bot conectado a WhatsApp");
  if (fs.existsSync("qr.png")) fs.unlinkSync("qr.png");

  // ── CRON: Recordatorio diario 6pm Monterrey ───────────────────────────
  cron.schedule(
    "0 18 * * *",
    async () => {
      const pending = getAllPendingTx();

      if (pending.length === 0) {
        await client.sendMessage(
          MY_NUMBER,
          "✅ *Reporte 6PM*\n\nNo hay transacciones pendientes. Todo al día 👌"
        );
        return;
      }

      let msg = `⏰ *Reporte Diario — 6:00 PM*\n`;
      msg += `📋 Tienes *${pending.length}* transacción(es) pendiente(s):\n\n`;

      for (const row of pending) {
        msg += `─────────────────────\n`;
        msg += `${tipoEmoji(row.tipo)} *${row.tipo.toUpperCase()}*\n`;
        msg += `🔑 ID: *${row.token}*\n`;
        msg += `📅 Fecha: ${row.fecha}\n`;
        msg += `💰 Cantidad: $${formatMoney(row.cantidad)}\n`;
        if (row.tipo === "factura") {
          msg += `🏷️ Comisión (2.5%): $${formatMoney(row.factura_amt)}\n`;
        }
        msg += `📝 ${row.comentarios}\n`;
        msg += `⏱️ Pendiente hace: ${formatTimeSince(row.created_at)}\n`;
      }

      msg += `─────────────────────\n`;
      msg += `Para aprobar: /aprobar XXXXXX\nPara rechazar: /rechazar XXXXXX`;

      await client.sendMessage(MY_NUMBER, msg);
      await client.sendMessage(APPROVER_NUMBER, msg);
    },
    { timezone: "America/Monterrey" }
  );
});

client.on("auth_failure", (msg) => {
  console.error("❌ Error de autenticación:", msg);
});

client.on("disconnected", (reason) => {
  console.log("❌ Bot desconectado:", reason);
});

// ── MENSAJES ───────────────────────────────────────────────────────────────
client.on("message", async (msg) => {
  // Obtener número real aunque venga en formato @lid
  const chat = await msg.getChat();
  const contact = await msg.getContact();
  const senderNumber = contact.number; // número limpio ej: 5218184670320
  const sender = `${senderNumber}@c.us`;
  const chatId = msg.from;
  const trimmed = msg.body.trim();

  // DEBUG TEMPORAL
  console.log("📨 Mensaje recibido:");
  console.log("   chatId     :", chatId);
  console.log("   sender     :", sender);
  console.log("   msg.fromMe :", msg.fromMe);
  console.log("   msg.body   :", trimmed);
  console.log("   MY_NUMBER  :", MY_NUMBER);
  console.log("   APPROVER   :", APPROVER_NUMBER);

  if (msg.fromMe) return;
  if (!trimmed) return;

  // ── COMANDO DE TRANSACCIÓN ────────────────────────────────────────────
  if (
    trimmed.startsWith("/") &&
    !trimmed.startsWith("/aprobar") &&
    !trimmed.startsWith("/rechazar")
  ) {
    if (sender !== MY_NUMBER) return;

    const parsed = parseCommand(trimmed);
    if (!parsed) {
      await client.sendMessage(
        chatId,
        "❌ *Formato incorrecto*\n\n" +
          "Usa:\n`/DD/MM tipo cantidad comentarios`\n\n" +
          "*Ejemplos:*\n" +
          "`/26/3 ingreso 50,000 efectivo venado`\n" +
          "`/26/3 egreso 15,000 renta oficina`\n" +
          "`/26/3 factura 50,000 gumesa 1`"
      );
      return;
    }

    let facturaAmt = 0;
    if (parsed.tipo === "factura") {
      facturaAmt = parseFloat((parsed.cantidad * 0.025).toFixed(2));
    }

    const token = getNextToken();
    savePendingTx(token, {
      fecha: parsed.fecha,
      tipo: parsed.tipo,
      cantidad: parsed.cantidad,
      facturaAmt,
      comentarios: parsed.comentarios,
      chatId,
    });

    let detalle =
      `${tipoEmoji(parsed.tipo)} *Solicitud de ${parsed.tipo.toUpperCase()}*\n\n` +
      `📅 Fecha: ${parsed.fecha}\n` +
      `💰 Cantidad: $${formatMoney(parsed.cantidad)}\n`;

    if (parsed.tipo === "factura") {
      detalle += `🏷️ Comisión (2.5%): $${formatMoney(facturaAmt)}\n`;
    }

    detalle +=
      `📝 Comentarios: ${parsed.comentarios}\n\n` +
      `🔑 ID: *${token}*\n\n` +
      `⏳ Esperando aprobación...\n` +
      `✅ Aprobar: /aprobar ${token}\n` +
      `❌ Rechazar: /rechazar ${token}`;

    await client.sendMessage(chatId, detalle);
    return;
  }

  // ── APROBAR ──────────────────────────────────────────────────────────
  if (trimmed.startsWith("/aprobar")) {
    if (sender !== APPROVER_NUMBER) return;

    const token = trimmed.split(" ")[1]?.trim();

    if (!token || !getPendingTx(token)) {
      await client.sendMessage(
        chatId,
        `❌ ID \`${token}\` no encontrado o ya procesado.`
      );
      return;
    }

    const tx = getPendingTx(token);
    deletePendingTx(token);

    try {
      await appendRow(
        tx.fecha,
        tx.tipo,
        tx.cantidad,
        tx.tipo === "factura" ? tx.facturaAmt : "",
        tx.comentarios
      );

      const balance = await getBalance();

      let confirmMsg =
        `✅ *APROBADO* 🎉\n\n` +
        `${tipoEmoji(tx.tipo)} *${tx.tipo.toUpperCase()}*\n` +
        `🔑 ID: *${token}*\n\n` +
        `📅 Fecha: ${tx.fecha}\n` +
        `💰 Cantidad: $${formatMoney(tx.cantidad)}\n`;

      if (tx.tipo === "factura") {
        confirmMsg += `🏷️ Comisión (2.5%): $${formatMoney(tx.facturaAmt)}\n`;
      }

      confirmMsg +=
        `📝 Comentarios: ${tx.comentarios}\n\n` +
        `📊 *Balance General: $${formatMoney(balance)}*`;

      await client.sendMessage(tx.chatId, confirmMsg);
    } catch (err) {
      console.error("❌ Error al escribir en Sheets:");
      console.error("   Mensaje:", err.message);
      console.error("   Detalle:", err.errors || err.response?.data || err);
      savePendingTx(token, tx);
      await client.sendMessage(
        chatId,
        "❌ Error al guardar en Google Sheets. La transacción sigue pendiente."
      );
    }
    return;
  }

  // ── RECHAZAR ─────────────────────────────────────────────────────────
  if (trimmed.startsWith("/rechazar")) {
    if (sender !== APPROVER_NUMBER) return;

    const token = trimmed.split(" ")[1]?.trim();

    if (!token || !getPendingTx(token)) {
      await client.sendMessage(
        chatId,
        `❌ ID \`${token}\` no encontrado o ya procesado.`
      );
      return;
    }

    const tx = getPendingTx(token);
    deletePendingTx(token);

    await client.sendMessage(
      tx.chatId,
      `❌ *RECHAZADO* 🚫\n\n` +
        `${tipoEmoji(tx.tipo)} *${tx.tipo.toUpperCase()}*\n` +
        `🔑 ID: *${token}*\n\n` +
        `📅 Fecha: ${tx.fecha}\n` +
        `💰 Cantidad: $${formatMoney(tx.cantidad)}\n` +
        `📝 Comentarios: ${tx.comentarios}\n\n` +
        `⚠️ Esta transacción *no* fue registrada.`
    );
    return;
  }
});

client.initialize();