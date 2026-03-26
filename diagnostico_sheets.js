// diagnostico_sheets.js
// Corre con: node diagnostico_sheets.js
require("dotenv").config();
const { google } = require("googleapis");
const fs = require("fs");

console.log("\n🔍 DIAGNÓSTICO GOOGLE SHEETS\n" + "=".repeat(60));

// ── PASO 1: Variables de entorno ──────────────────────────────────────────
console.log("\n📋 PASO 1 — Variables de entorno:");
console.log("   SPREADSHEET_ID :", process.env.SPREADSHEET_ID || "❌ UNDEFINED");
console.log("   SHEET_NAME     :", process.env.SHEET_NAME || "❌ UNDEFINED");

// ── PASO 2: Archivo credentials.json ─────────────────────────────────────
console.log("\n📋 PASO 2 — Archivo credentials.json:");
if (!fs.existsSync("credentials.json")) {
  console.log("   ❌ NO EXISTE el archivo credentials.json");
  console.log("   → Descárgalo de Google Cloud Console y ponlo en la carpeta del proyecto");
  process.exit(1);
}

let creds;
try {
  creds = JSON.parse(fs.readFileSync("credentials.json", "utf8"));
  console.log("   ✅ Archivo encontrado y válido");
  console.log("   📧 client_email:", creds.client_email || "❌ No encontrado");
  console.log("   🔑 private_key :", creds.private_key ? "✅ Presente" : "❌ FALTA");
  console.log("   📄 type        :", creds.type || "❌ No encontrado");
} catch (e) {
  console.log("   ❌ El archivo credentials.json tiene un error de formato:", e.message);
  process.exit(1);
}

// ── PASO 3: Autenticación con Google ─────────────────────────────────────
console.log("\n📋 PASO 3 — Autenticación con Google:");
async function runDiagnostico() {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: "credentials.json",
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const client = await auth.getClient();
    console.log("   ✅ Autenticación exitosa");

    const sheets = google.sheets({ version: "v4", auth: client });

    // ── PASO 4: Leer la hoja ───────────────────────────────────────────
    console.log("\n📋 PASO 4 — Leyendo Google Sheet:");
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: `${process.env.SHEET_NAME}!A1:G2`,
      });
      const rows = res.data.values;
      console.log("   ✅ Conexión exitosa con la hoja");
      console.log("   📊 Contenido de A1:G2:");
      if (!rows || rows.length === 0) {
        console.log("   ⚠️  La hoja está vacía");
      } else {
        rows.forEach((row, i) => console.log(`   Fila ${i + 1}:`, row));
      }
    } catch (err) {
      console.log("   ❌ Error al leer la hoja:");
      console.log("   →", err.message);
      if (err.message.includes("not found")) {
        console.log("   💡 El SPREADSHEET_ID está mal o la hoja no existe");
      }
      if (err.message.includes("403")) {
        console.log("   💡 No tienes permisos. Comparte la hoja con:", creds.client_email);
      }
      process.exit(1);
    }

    // ── PASO 5: Leer balance (G2) ─────────────────────────────────────
    console.log("\n📋 PASO 5 — Leyendo balance (celda G2):");
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: `${process.env.SHEET_NAME}!G2`,
      });
      const val = res.data.values?.[0]?.[0];
      console.log("   Valor crudo en G2:", val ?? "⚠️  Vacío o sin fórmula");
    } catch (err) {
      console.log("   ❌ Error al leer G2:", err.message);
    }

    // ── PASO 6: Escribir fila de prueba ───────────────────────────────
    console.log("\n📋 PASO 6 — Escribiendo fila de prueba:");
    try {
      await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: `${process.env.SHEET_NAME}!A:E`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [["TEST", "diagnostico", "999", "", "prueba automatica"]],
        },
      });
      console.log("   ✅ Escritura exitosa — revisa tu Google Sheet,");
      console.log("   debe haber una fila nueva que diga TEST / diagnostico / 999");
    } catch (err) {
      console.log("   ❌ Error al escribir:", err.message);
      if (err.message.includes("403")) {
        console.log("   💡 Sin permisos de escritura. Comparte la hoja con:", creds.client_email);
        console.log("   💡 Asegúrate de darle rol de EDITOR, no solo lector");
      }
    }

    console.log("\n" + "=".repeat(60));
    console.log("✅ Diagnóstico completo\n");
  } catch (err) {
    console.log("   ❌ Falló la autenticación:");
    console.log("   →", err.message);
  }
}

runDiagnostico();