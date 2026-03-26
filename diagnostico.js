// diagnostico.js - versión whatsapp-web.js
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode");

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
  console.log("\n📱 QR generado. Abre qr.png y escanéalo.");
  console.log("   WhatsApp > Dispositivos vinculados > Vincular dispositivo\n");
});

client.on("ready", () => {
  console.log("\n✅ CONECTADO. Envíate un mensaje de WhatsApp.\n");
  console.log("=".repeat(60));
});

client.on("auth_failure", (msg) => {
  console.log("❌ Error de autenticación:", msg);
});

client.on("disconnected", (reason) => {
  console.log("❌ Desconectado:", reason);
});

client.on("message", async (msg) => {
  const chat = await msg.getChat();
  const contact = await msg.getContact();

  console.log("\n" + "=".repeat(60));
  console.log("📍 Chat ID  :", msg.from);
  console.log("👤 Remitente:", contact.number);
  console.log("👥 ¿Grupo?  :", chat.isGroup ? "SÍ" : "NO");
  console.log("💬 Mensaje  :", msg.body);
  console.log("=".repeat(60));
});

client.initialize();