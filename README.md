# 📱 SushiHub - Conexión de WhatsApp por Código QR

Este servicio permite enlazar cualquier teléfono celular con WhatsApp a tu sistema SushiHub POS escaneando un código QR en pantalla (mediante la función oficial de **Dispositivos Vinculados** de WhatsApp).

---

## 🚀 ¿Cómo usarlo?

### Opción 1: Simulación Directa en el Sistema (Sin instalar nada)
1. Abre tu sistema en **Configuración > WhatsApp & Redes**.
2. Asegúrate de tener seleccionada la opción **"1. Conexión por Código QR"**.
3. Haz clic en **"Generar Código QR"** y luego en **"Simular Escaneo Exitoso"**.
4. ¡Listo! El sistema pasará a estado **En Línea** y podrás recibir y enviar mensajes inmediatamente.

---

### Opción 2: Conexión Real con tu Celular (Servicio Node.js)
Si deseas que tu teléfono celular físico reciba mensajes reales y los mande a tu sistema:

1. Abre una terminal en la carpeta del proyecto y ejecuta:
   ```bash
   node services/whatsapp-qr-bridge/index.js
   ```
2. En tu pantalla de **Configuración > WhatsApp & Redes**, haz clic en **"Generar Código QR"**.
3. Abre WhatsApp en tu celular:
   - En Android: Toca los **3 puntos** arriba a la derecha > **Dispositivos vinculados**.
   - En iPhone: Ve a **Configuración** abajo a la derecha > **Dispositivos vinculados**.
4. Toca el botón verde **"Vincular un dispositivo"** y apunta la cámara al código QR en tu pantalla.
5. ¡Listo! Tu teléfono quedará vinculado con el sistema y cada cliente que te escriba sonará en la caja POS.
